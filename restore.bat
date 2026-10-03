@echo off
:: restore.bat - rebuild this BlackVault install from a full backup.
:: Windows twin of restore.sh (full-backups spec, section 3): change them
:: together. :env_value and :require_compose (bottom) are the same
:: subroutines as in backup.bat, and :run_with_passphrase holds backup.bat's
:: PowerShell step, character for character: change them together too
:: (scripts/full-restore-wrapper.test.ts compares them).
::
::   restore.bat <file> [--passphrase-file <path>] [--yes]
::
:: <file> is a full backup made by backup.bat or the Settings button
:: (blackvault-full-<time>.bvb): a file name in the backup folder
:: (BLACKVAULT_BACKUP_DIR in .env, by default <DATA_DIR>\backups), or a path
:: to a file in that folder. Copy the backup there first.
::
:: IT REPLACES EVERYTHING the backup holds: every record in the database and
:: every uploaded photo and document. User accounts, settings and the audit
:: log are kept. The backup may come from another machine with a different
:: encryption key.
::
:: WHAT IT DOES, in this order:
::   1. Checks the backup in a one-off container. A wrong passphrase or a
::      damaged file stops here: nothing was changed, BlackVault not stopped.
::   2. Asks you to type RESTORE (skipped with --yes).
::   3. Stops BlackVault and takes a snapshot of the database and the uploads
::      folder into backups\ (scripts\db-snapshot.bat). If that fails it
::      starts BlackVault again and stops: nothing was changed.
::   4. Restores, in a one-off container (see restore.sh for the steps).
::   5. Starts BlackVault.
:: IF STEP 4 FAILS, for any reason, the install is put back, BlackVault is
:: started again, and this script exits 1. The uploads are always put back.
:: The DATABASE is put back from the snapshot only if the restore had reached
:: its database step: the restore program leaves a marker folder,
:: <uploads>\.restore-<time>.db-started, just before that step. No marker
:: means the database was never touched, and it is left alone. If the
:: rollback itself fails, BlackVault is NOT started.
::
:: THE RECOVERY FILE. Before step 4 this script prints, and writes to
:: backups\restore-<time>-RECOVERY.txt, where the snapshot is and the commands
:: that put it back by hand. A batch file cannot catch Ctrl-C or a closed
:: window: if this script is interrupted, that file is all there is to say
:: the install may be half restored. It is deleted when the restore succeeds
:: or the automatic rollback has worked; while one exists, this script
:: refuses to start.
:: The rollback's file work is scripts/snapshot-restore.sh, run as root in a
:: one-off container with backups\ mounted read-only - the same script
:: restore.sh uses. PostgreSQL is put back with psql in the db container:
:: the dump is loaded into a NEW database, and only then swapped in.
::
:: THE PASSPHRASE NEVER TOUCHES cmd.exe, exactly as in backup.bat: one
:: PowerShell process reads --passphrase-file (or asks, without echo), starts
:: docker with its standard input a pipe, and writes the passphrase there.
:: The backup is opened twice (the check, then the restore), so WITHOUT
:: --passphrase-file you are asked for the passphrase twice: cmd.exe must not
:: hold it in between. With no --passphrase-file and no console this script
:: stops at once.
::
:: --yes: without a console there is nobody to type RESTORE, so --yes is
:: required; without it the script stops before anything is checked.
::
:: The two programs run as
::   docker compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify <name>
::   docker compose run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp <time> <name>
:: with no --user and no --no-deps, for the reasons given in backup.bat.
::
:: It never pauses. EXIT CODE: 0 restored, 1 failed (rolled back, or nothing
:: was changed). A failure ends with one ERROR line that says which.

:: Arguments are read BEFORE changing folder: a relative path is relative to
:: where the user ran this from.
setlocal DisableDelayedExpansion
set "BV_PASSFILE="
set "BV_YES="
set "BV_FILE_GIVEN="
set "BV_FILE_NAME="
set "BV_FILE_DIR="
set "BV_FILE_IS_PATH="
set "BV_FILE_SHOWN="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--passphrase-file" goto :arg_passfile
if /i "%~1"=="--yes" goto :arg_yes
set "BV_ARG=%~1"
if "%BV_ARG:~0,1%"=="-" goto :arg_unknown
if defined BV_FILE_GIVEN goto :arg_unknown
set "BV_FILE_GIVEN=1"
set "BV_FILE_SHOWN=%~1"
set "BV_FILE_NAME=%~nx1"
set "BV_FILE_DIR=%~dp1"
if not "%~1"=="%~nx1" set "BV_FILE_IS_PATH=1"
shift
goto :parse_args

:arg_unknown
:: Never echoed back: it could be a passphrase typed here by mistake.
>&2 echo ERROR: unknown argument. Usage: restore.bat file [--passphrase-file path] [--yes]
exit /b 1

:arg_passfile
if "%~2"=="" goto :arg_missing
set "BV_PASSFILE=%~f2"
shift
shift
goto :parse_args

:arg_yes
set "BV_YES=1"
shift
goto :parse_args

:arg_missing
>&2 echo ERROR: %~1 needs a value. Usage: restore.bat file [--passphrase-file path] [--yes]
exit /b 1

:args_done
set "BV_ARG="
if defined BV_FILE_GIVEN goto :file_given
>&2 echo ERROR: no backup file was given. Usage: restore.bat file [--passphrase-file path] [--yes]
exit /b 1
:file_given
:: Run from the folder this script lives in (.env and docker-compose.yml).
cd /d "%~dp0"
setlocal EnableDelayedExpansion

:: -- 1. The passphrase source, and the confirmation -----------------
set "BV_CONSOLE=1"
powershell -NoProfile -NonInteractive -Command "if ([Console]::IsInputRedirected) { exit 1 } else { exit 0 }" >nul 2>&1
if errorlevel 1 set "BV_CONSOLE="
if not defined BV_PASSFILE goto :need_console
if not exist "!BV_PASSFILE!" goto :passfile_unreadable
if exist "!BV_PASSFILE!\" goto :passfile_unreadable
for %%F in ("!BV_PASSFILE!") do if %%~zF EQU 0 goto :passfile_empty
goto :passphrase_source_ok
:passfile_unreadable
>&2 echo ERROR: cannot read the passphrase file !BV_PASSFILE!.
exit /b 1
:passfile_empty
>&2 echo ERROR: the passphrase file !BV_PASSFILE! is empty.
exit /b 1
:need_console
if defined BV_CONSOLE goto :passphrase_source_ok
>&2 echo ERROR: no passphrase: standard input is not a console, so there is nobody to ask. Use --passphrase-file path. Nothing was done.
exit /b 1
:passphrase_source_ok
:: Ruling R21: a restore replaces all data. Nobody at a console to confirm:
:: --yes, or stop now.
if defined BV_YES goto :confirm_source_ok
if defined BV_CONSOLE goto :confirm_source_ok
>&2 echo ERROR: a restore replaces all data and must be confirmed, but standard input is not a console. Add --yes to confirm. Nothing was done.
exit /b 1
:confirm_source_ok

:: -- 2. The install ------------------------------------------------
if not exist "scripts\db-snapshot.bat" goto :incomplete
if not exist "scripts\snapshot-restore.sh" goto :incomplete
goto :complete
:incomplete
>&2 echo ERROR: scripts\db-snapshot.bat or scripts\snapshot-restore.sh is missing; run restore.bat from a complete BlackVault folder. Nothing was changed.
exit /b 1
:complete
call :require_compose
if defined COMPOSE goto :compose_ok
if not defined _CV set "_CV=none"
>&2 echo ERROR: BlackVault needs Docker Compose v2.20 or newer, run as 'docker compose' (found: !_CV!). Nothing was done.
exit /b 1
:compose_ok

:: docker compose must read the BLACKVAULT_* keys from .env only, never from
:: this console, and the one-off containers must not inherit an
:: uploads-snapshot marker (see rotate-key.bat).
set "BLACKVAULT_DATABASE_URL="
set "BLACKVAULT_DB_PROVIDER="
set "BLACKVAULT_POSTGRES_PASSWORD="
set "BLACKVAULT_UPLOADS_SNAPSHOT="
set "BLACKVAULT_BACKUP_DIR="
:: Used by the shared PowerShell step: ask once per call, no time limit.
set "BV_MODE=verify"
set "BV_LIMIT="

:: docker compose takes DATA_DIR from this console before .env; this script
:: and scripts\db-snapshot.bat read .env. If the two differ, the snapshot
:: would be of one install and the restore of another.
call :env_value DATA_DIR
set "BV_HOST_DATA=!_EV!"
if not defined DATA_DIR goto :data_dir_ok
if "!DATA_DIR!"=="!BV_HOST_DATA!" goto :data_dir_ok
>&2 echo ERROR: DATA_DIR is set in this console and is not the DATA_DIR in .env, so docker compose and the snapshot would use different folders. Run 'set DATA_DIR=' first. Nothing was done.
exit /b 1
:data_dir_ok
if not defined BV_HOST_DATA set "BV_HOST_DATA=.\data"
:: Ruling R25: an earlier restore that did not end cleanly left its recovery
:: file. Never start a second restore on top of a possibly half-restored install.
if not exist "backups\restore-*-RECOVERY.txt" goto :no_recovery_pending
>&2 echo ERROR: an earlier restore did not finish cleanly: a restore-[time]-RECOVERY.txt file is still in !CD!\backups. Read it: it says how to put the install back as it was. If BlackVault is running and you have checked it, delete that file instead. Then run the restore again. Nothing was done.
exit /b 1
:no_recovery_pending

:: -- 3. The file: a name in the backup folder, or a path into it ----
:: The backup folder on the HOST: the same expression docker-compose.yml
:: mounts at /app/backups. A relative path is relative to this folder.
call :env_value BLACKVAULT_BACKUP_DIR
set "BV_HOST_DIR=!_EV!"
if defined BV_HOST_DIR goto :host_dir_known
call :env_value DATA_DIR
if not defined _EV set "_EV=.\data"
set "BV_HOST_DIR=!_EV!\backups"
:host_dir_known
if not defined BV_FILE_IS_PATH goto :file_name_check
set "BV_HOST_FULL="
for %%D in ("!BV_HOST_DIR!") do set "BV_HOST_FULL=%%~fD"
if not defined BV_HOST_FULL goto :file_outside
if not "!BV_HOST_FULL:~-1!"=="\" set "BV_HOST_FULL=!BV_HOST_FULL!\"
if /i not "!BV_FILE_DIR!"=="!BV_HOST_FULL!" goto :file_outside
:file_name_check
if not defined BV_FILE_NAME goto :file_bad_name
if "!BV_FILE_NAME:~0,1!"=="-" goto :file_bad_name
if "!BV_FILE_NAME:~0,1!"==";" goto :file_bad_name
for /f "delims=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-" %%X in ("!BV_FILE_NAME!") do goto :file_bad_name
goto :file_mapped
:file_outside
>&2 echo ERROR: restore: !BV_FILE_SHOWN! is not in the backup folder (!BV_HOST_DIR!). Give a file name, or the path of a file in that folder.
exit /b 1
:file_bad_name
>&2 echo ERROR: restore: that is not a backup file name. Give a file name, or the path of a file in the backup folder (!BV_HOST_DIR!).
exit /b 1
:file_mapped

call :provider_from_env

:: -- 4. Check the backup: nothing is changed yet --------------------
>&2 echo Checking the backup !BV_FILE_NAME! (nothing is changed yet)...
set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify !BV_FILE_NAME!"
call :run_with_passphrase 1>&2
if "!BV_RC!"=="0" goto :verified
>&2 echo ERROR: the backup !BV_FILE_NAME! did not pass the check (the reason is on the line above). Nothing was changed; BlackVault was not stopped.
exit /b 1
:verified

:: -- 5. Confirm ------------------------------------------------------
if defined BV_YES goto :confirmed
>&2 echo.
>&2 echo This will REPLACE what is in this BlackVault install with the backup !BV_FILE_NAME!:
>&2 echo   - every record in the database (firearms, accessories, ammunition, gear,
>&2 echo     documents, range sessions, kits, ...)
>&2 echo   - every uploaded photo and document
>&2 echo User accounts, settings and the audit log are kept. The photos and documents
>&2 echo that are here now are kept in the uploads folder, under .pre-restore-[time]\.
>&2 echo BlackVault is stopped while this runs.
set "BV_CONFIRM="
set /p "BV_CONFIRM=Type RESTORE to continue: "
if "!BV_CONFIRM!"=="RESTORE" goto :confirmed
>&2 echo ERROR: not confirmed. Nothing was changed; BlackVault was not stopped.
exit /b 1
:confirmed

set "BV_STAMP="
for /f "usebackq delims=" %%T in (`powershell -NoProfile -NonInteractive -Command "[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')" 2^>nul`) do set "BV_STAMP=%%T"
if defined BV_STAMP goto :stamp_ok
>&2 echo ERROR: could not read the time. Nothing was changed; BlackVault was not stopped.
exit /b 1
:stamp_ok
set "BV_RECOVERY=backups\restore-!BV_STAMP!-RECOVERY.txt"
:: The one-off restore container gets a name, so that it can be stopped by name.
set "BV_CONTAINER=blackvault-restore-!BV_STAMP!"
:: docker-compose.yml mounts <DATA_DIR>\uploads at /app/uploads. The restore
:: program's marker and its .pre-restore folder are looked for here.
set "BV_HOST_UPLOADS=!BV_HOST_DATA!\uploads"
set "BV_MARKER=!BV_HOST_UPLOADS!\.restore-!BV_STAMP!.db-started"

:: -- 6. Stop the app, snapshot the database and the uploads ---------
>&2 echo Stopping BlackVault...
%COMPOSE% stop blackvault 1>&2
if not errorlevel 1 goto :stopped
>&2 echo ERROR: could not stop BlackVault. Nothing was changed.
exit /b 1
:stopped

>&2 echo Taking a snapshot of the database and the uploads folder...
set "BV_SNAP_LOG=%TEMP%\blackvault-restore-snapshot-%RANDOM%%RANDOM%.log"
call scripts\db-snapshot.bat > "!BV_SNAP_LOG!" 2>&1
set "BV_SNAP_RC=!errorlevel!"
type "!BV_SNAP_LOG!" 1>&2
:: "Database snapshot saved: <path>" is db-snapshot.bat's contract (ruling R4).
set "BV_DB_SNAPSHOT="
for /f "usebackq tokens=1,* delims=:" %%A in (`findstr /b /c:"Database snapshot saved:" "!BV_SNAP_LOG!"`) do set "BV_DB_SNAPSHOT=%%B"
del /f /q "!BV_SNAP_LOG!" >nul 2>&1
if defined BV_DB_SNAPSHOT for /f "tokens=* delims= " %%V in ("!BV_DB_SNAPSHOT!") do set "BV_DB_SNAPSHOT=%%V"
set "BV_UPLOADS_SNAPSHOT="
if exist "backups\.uploads-snapshot-marker" set /p BV_UPLOADS_SNAPSHOT=<"backups\.uploads-snapshot-marker"
:: The marker is for update.bat's next `up`; a restore leaves no plaintext for the app to snapshot.
del /f /q "backups\.uploads-snapshot-marker" >nul 2>&1
if "!BV_SNAP_RC!"=="0" goto :snapshot_taken
call :start_app_or_warn
>&2 echo ERROR: the snapshot before the restore failed (see above), so the restore did not start. Nothing was changed.
exit /b 1
:snapshot_taken
if not defined BV_DB_SNAPSHOT goto :no_database
if not exist "!BV_DB_SNAPSHOT!" goto :no_database
goto :have_snapshot
:no_database
call :start_app_or_warn
>&2 echo ERROR: there is no database to snapshot yet, so a failed restore could not be undone. Start BlackVault once (docker compose up -d), wait until it is up, then run the restore again. Nothing was changed.
exit /b 1
:have_snapshot
set "BV_DB_SNAPSHOT_NAME="
for %%F in ("!BV_DB_SNAPSHOT!") do set "BV_DB_SNAPSHOT_NAME=%%~nxF"
:: With no uploads snapshot recorded the last argument of the uploads rollback is empty.
set "BV_UPLOADS_ARG="
set "BV_UPLOADS_SHOWN=(no uploads snapshot was recorded)"
if not defined BV_UPLOADS_SNAPSHOT goto :uploads_arg_done
for %%F in ("!BV_UPLOADS_SNAPSHOT!") do set "BV_UPLOADS_ARG=/bv-backups/%%~nxF"
set "BV_UPLOADS_SHOWN=!BV_UPLOADS_SNAPSHOT!"
:uploads_arg_done

:: -- 7. The recovery file, then the restore --------------------------
call :write_recovery
if exist "!BV_RECOVERY!" goto :recovery_written
call :start_app_or_warn
>&2 echo ERROR: could not write the recovery file !BV_RECOVERY!, so the restore did not start. Nothing was changed.
exit /b 1
:recovery_written
>&2 echo.
>&2 echo If this script is interrupted from here on, the install may be half restored.
>&2 echo How to put it back is in !CD!\!BV_RECOVERY!:
>&2 echo ----------------------------------------------------------------------
type "!BV_RECOVERY!" 1>&2
>&2 echo ----------------------------------------------------------------------
>&2 echo.

>&2 echo Restoring !BV_FILE_NAME!. A large backup can take a while...
set "BV_DOCKER_ARGS=compose run --rm -T --name !BV_CONTAINER! blackvault node dist/scripts/full-restore.mjs --stamp !BV_STAMP! !BV_FILE_NAME!"
call :run_with_passphrase
if "!BV_RC!"=="0" goto :restore_done

:: Ruling R24. What the restore program left behind:
::   started    its marker exists: the database step was reached. Also the
::              answer when the uploads folder is not there to look into.
::   complete   no marker, but .pre-restore-<time> exists: the program
::              removes its marker only after everything is in place, so
::              the restore FINISHED and only its exit status was lost.
::   untouched  neither: the database step was never reached.
set "BV_STATE=untouched"
if exist "!BV_HOST_UPLOADS!\.pre-restore-!BV_STAMP!\" set "BV_STATE=complete"
if exist "!BV_MARKER!\" set "BV_STATE=started"
if not exist "!BV_HOST_UPLOADS!\" set "BV_STATE=started"
if not "!BV_STATE!"=="complete" goto :rollback
>&2 echo WARNING: the restore program ended with exit !BV_RC!, but it had FINISHED: its marker is gone and the previous folders are in .pre-restore-!BV_STAMP!. Nothing is rolled back.

:restore_done
del /f /q "!BV_RECOVERY!" >nul 2>&1
if exist "!BV_RECOVERY!" >&2 echo WARNING: could not delete !BV_RECOVERY!; delete it by hand, or the next restore will refuse to start.
if exist "!BV_MARKER!\" >&2 echo WARNING: the restore finished but left its marker !BV_MARKER!. It can be deleted.
>&2 echo Starting BlackVault...
%COMPOSE% up -d 1>&2
if not errorlevel 1 goto :restored
>&2 echo ERROR: the restore is complete and was NOT rolled back, but BlackVault did not start. Check the logs (docker compose logs blackvault) and start it by hand: docker compose up -d
exit /b 1
:restored
>&2 echo Restore complete.
>&2 echo   The photos and documents that were here before: [uploads folder]\.pre-restore-!BV_STAMP!\
>&2 echo   The snapshot taken before the restore: !BV_DB_SNAPSHOT! !BV_UPLOADS_SNAPSHOT!
>&2 echo   Both can be deleted once you have checked BlackVault.
exit /b 0

:: -- 8. The restore failed: put the install back ---------------------
:: The uploads FIRST: that removes the restore's staging folder, which frees
:: the space the database copy may need on a full disk. Then the database,
:: only if the restore had reached it (ruling R24).
:rollback
>&2 echo.
set "BV_ROLLED_BACK=1"
if "!BV_STATE!"=="started" >&2 echo The restore failed (exit !BV_RC!; the reason is above) after it had reached the database. Putting the uploads and the database back from the snapshot...
if not "!BV_STATE!"=="started" >&2 echo The restore failed (exit !BV_RC!; the reason is above) before it reached the database: the database is left alone. Checking the uploads against the snapshot...
%COMPOSE% run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\backups:/bv-backups:ro" -v "!CD!\scripts\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh uploads /app/uploads !BV_STAMP! !BV_UPLOADS_ARG! 1>&2
if errorlevel 1 set "BV_ROLLED_BACK="
if not "!BV_STATE!"=="started" goto :rollback_checked
if /i "!DB_PROVIDER!"=="sqlite" goto :rollback_sqlite
:: PostgreSQL: the dump is loaded into a NEW database first, in one
:: transaction. Only when that worked is the live database dropped and the
:: new one given its name.
%COMPOSE% up -d --wait db 1>&2
if errorlevel 1 goto :rollback_db_failed
%COMPOSE% exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault -d postgres -c "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault" 1>&2
if errorlevel 1 goto :rollback_db_failed
%COMPOSE% exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault -d blackvault_rollback --single-transaction -f - < "!BV_DB_SNAPSHOT!" >nul
if errorlevel 1 goto :rollback_db_failed
%COMPOSE% exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault -d postgres -c "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault" 1>&2
if errorlevel 1 goto :rollback_db_failed
goto :rollback_checked
:rollback_sqlite
%COMPOSE% run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\backups:/bv-backups:ro" -v "!CD!\scripts\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh sqlite /bv-backups/!BV_DB_SNAPSHOT_NAME! /app/data/vault.db 1>&2
if errorlevel 1 goto :rollback_db_failed
goto :rollback_checked
:rollback_db_failed
set "BV_ROLLED_BACK="
:rollback_checked
if defined BV_ROLLED_BACK goto :rolled_back

>&2 echo ERROR: the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started. What to do is in !CD!\!BV_RECOVERY!:
type "!BV_RECOVERY!" 1>&2
exit /b 1

:rolled_back
if not "!BV_STATE!"=="started" goto :marker_cleared
%COMPOSE% run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\backups:/bv-backups:ro" -v "!CD!\scripts\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh clear-marker /app/uploads !BV_STAMP! 1>&2
if errorlevel 1 >&2 echo WARNING: everything was put back, but the marker !BV_MARKER! could not be removed. Delete it by hand.
:marker_cleared
del /f /q "!BV_RECOVERY!" >nul 2>&1
if exist "!BV_RECOVERY!" >&2 echo WARNING: could not delete !BV_RECOVERY!; delete it by hand, or the next restore will refuse to start.
set "BV_DONE=It had not reached the database, which was not touched; the uploads were checked against the snapshot. Nothing is changed."
if "!BV_STATE!"=="started" set "BV_DONE=The database and the uploads were put back from the snapshot taken before it (!BV_DB_SNAPSHOT!), so nothing is changed."
>&2 echo Starting BlackVault...
%COMPOSE% up -d 1>&2
if not errorlevel 1 goto :rolled_back_started
>&2 echo ERROR: the restore failed (the reason is above). !BV_DONE! But BlackVault did not start again: start it by hand: docker compose up -d
exit /b 1
:rolled_back_started
>&2 echo ERROR: the restore failed (the reason is above). !BV_DONE! BlackVault was started again.
exit /b 1

:: ============================================================
:: Subroutines
:: ============================================================

:: :start_app_or_warn - starts BlackVault again after a refusal that changed
:: nothing; says so if it does not start.
:start_app_or_warn
%COMPOSE% up -d 1>&2
if errorlevel 1 >&2 echo WARNING: BlackVault did not start again; start it by hand: docker compose up -d
goto :eof

:: :write_recovery - ruling R25: writes !BV_RECOVERY!, the file that says
:: where the snapshot is and exactly what to run to put it back. The same
:: steps as restore.sh's recovery_text. No exclamation mark may appear in
:: the text (delayed expansion is on).
:write_recovery
del /f /q "!BV_RECOVERY!" >nul 2>&1
set "BV_RB=docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\backups:/bv-backups:ro" -v "!CD!\scripts\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh"
set "BV_PSQL=docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault"
>>"!BV_RECOVERY!" echo BlackVault restore !BV_STAMP!: RECOVERY
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo Written by restore.bat just before it started restoring !BV_FILE_NAME!.
>>"!BV_RECOVERY!" echo restore.bat deletes this file when the restore has succeeded, or when it has
>>"!BV_RECOVERY!" echo put everything back itself. A batch file cannot catch Ctrl-C or a closed
>>"!BV_RECOVERY!" echo window: if you are reading this and restore.bat is no longer running,
>>"!BV_RECOVERY!" echo BlackVault is stopped and the install may be HALF RESTORED. Do not just start
>>"!BV_RECOVERY!" echo it: put the install back as it was with the commands below.
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo The install as it was before the restore is in this snapshot:
>>"!BV_RECOVERY!" echo   database: !BV_DB_SNAPSHOT!
>>"!BV_RECOVERY!" echo   uploads:  !BV_UPLOADS_SHOWN!
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo Run these in a Command Prompt, from "!CD!", in this order.
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo 1. Make sure the restore is no longer running. The second command must list
>>"!BV_RECOVERY!" echo    nothing before you go on ('No such container' from the first is fine):
>>"!BV_RECOVERY!" echo   docker stop !BV_CONTAINER!
>>"!BV_RECOVERY!" echo   docker ps -a --filter name=!BV_CONTAINER!
>>"!BV_RECOVERY!" echo   docker compose stop blackvault
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo 2. The photos and documents:
>>"!BV_RECOVERY!" echo   !BV_RB! uploads /app/uploads !BV_STAMP! !BV_UPLOADS_ARG!
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo 3. The database. ONLY if this folder exists:
>>"!BV_RECOVERY!" echo      "!BV_MARKER!"
>>"!BV_RECOVERY!" echo    It is the mark the restore leaves just before it changes the database. If
>>"!BV_RECOVERY!" echo    it does not exist, the database was never touched: skip to step 4.
if /i "!DB_PROVIDER!"=="sqlite" goto :write_recovery_sqlite
>>"!BV_RECOVERY!" echo   docker compose up -d --wait db
>>"!BV_RECOVERY!" echo   !BV_PSQL! -d postgres -c "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault"
>>"!BV_RECOVERY!" echo   !BV_PSQL! -d blackvault_rollback --single-transaction -f - ^< "!BV_DB_SNAPSHOT!"
>>"!BV_RECOVERY!" echo   !BV_PSQL! -d postgres -c "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault"
goto :write_recovery_tail
:write_recovery_sqlite
>>"!BV_RECOVERY!" echo   !BV_RB! sqlite /bv-backups/!BV_DB_SNAPSHOT_NAME! /app/data/vault.db
:write_recovery_tail
>>"!BV_RECOVERY!" echo   !BV_RB! clear-marker /app/uploads !BV_STAMP!
>>"!BV_RECOVERY!" echo.
>>"!BV_RECOVERY!" echo 4. Start BlackVault, check it, then delete this file:
>>"!BV_RECOVERY!" echo   docker compose up -d
>>"!BV_RECOVERY!" echo   del "!BV_RECOVERY!"
goto :eof

:: :run_with_passphrase - starts `docker %BV_DOCKER_ARGS%` with the
:: passphrase on its standard input and leaves its exit code in BV_RC. The
:: PowerShell line is backup.bat's, character for character (see THE
:: PASSPHRASE NEVER TOUCHES cmd.exe there for the details that matter):
:: change both together. BV_MODE is always `verify` here, so it asks once.
:run_with_passphrase
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { if ($env:BV_PASSFILE) { $bytes = [IO.File]::ReadAllBytes($env:BV_PASSFILE) } else { if ([Console]::IsInputRedirected) { [Console]::Error.WriteLine('ERROR: no passphrase: standard input is not a console, so there is nobody to ask. Use --passphrase-file <path>. Nothing was done.'); exit 1 }; $m = [Runtime.InteropServices.Marshal]; $p1 = $m::PtrToStringUni($m::SecureStringToGlobalAllocUnicode((Read-Host 'Backup passphrase' -AsSecureString))); if ($p1.Length -eq 0) { [Console]::Error.WriteLine('ERROR: the passphrase is empty. Nothing was done.'); exit 1 }; if ($env:BV_MODE -ne 'verify') { $p2 = $m::PtrToStringUni($m::SecureStringToGlobalAllocUnicode((Read-Host 'Repeat the passphrase' -AsSecureString))); if ($p1 -cne $p2) { [Console]::Error.WriteLine('ERROR: the two passphrases do not match. Nothing was done.'); exit 1 } }; $bytes = [Text.Encoding]::UTF8.GetBytes($p1) }; $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = 'docker'; $psi.Arguments = $env:BV_DOCKER_ARGS; $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $p = [Diagnostics.Process]::Start($psi); $pipe = $p.StandardInput.BaseStream; $pipe.Write($bytes, 0, $bytes.Length); $pipe.Flush(); $pipe.Close(); $limit = 0; if ($env:BV_LIMIT) { $limit = [int]$env:BV_LIMIT }; if ($limit -gt 0) { if (-not $p.WaitForExit($limit * 1000)) { try { $p.Kill() } catch { }; [Console]::Error.WriteLine('ERROR: the backup did not finish within ' + $limit + ' seconds (BLACKVAULT_BACKUP_TIMEOUT). It may still be running inside the container.'); exit 1 } } else { $p.WaitForExit() }; exit $p.ExitCode } catch { [Console]::Error.WriteLine('ERROR: could not run the backup: ' + $_.Exception.Message); exit 1 }"
set "BV_RC=!errorlevel!"
goto :eof

:: Mirrors :provider_from_env in scripts\db-snapshot.bat and update.bat (and
:: provider_from_env in scripts/compose-provider.sh): change them together.
:provider_from_env
set "_PV="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="BLACKVAULT_DB_PROVIDER" set "_PV=%%B"
  )
)
if defined _PV set "_PV=!_PV: =!"
if defined _PV set "_PV=!_PV:	=!"
if defined _PV set "_PV=!_PV:"=!"
if defined _PV set "_PV=!_PV:'=!"
set "DB_PROVIDER=sqlite"
if not defined _PV goto :eof
if /i "!_PV!"=="sqlite" goto :eof
set "DB_PROVIDER=!_PV!"
if /i "!_PV!"=="postgres" set "DB_PROVIDER=postgres"
if /i "!_PV!"=="postgresql" set "DB_PROVIDER=postgres"
goto :eof

:: :env_value KEY - the value of KEY in .\.env (last line wins) in _EV, with
:: quotes and surrounding spaces and tabs removed, as env_value in
:: scripts/compose-provider.sh does; undefined when unset or no .env.
:env_value
set "_EV="
if not exist ".env" goto :eof
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if "%%A"=="%~1" set "_EV=%%B"
)
if defined _EV set "_EV=!_EV:"=!"
if defined _EV for /f "tokens=* delims=	 " %%V in ("!_EV!") do set "_EV=%%V"
:env_value_trim
if not defined _EV goto :eof
if "!_EV:~-1!"==" " set "_EV=!_EV:~0,-1!" & goto :env_value_trim
if "!_EV:~-1!"=="	" set "_EV=!_EV:~0,-1!" & goto :env_value_trim
goto :eof

:: Mirrors require_compose / compose_version_ok in scripts/compose-provider.sh
:: and the identical :require_compose in install.bat / update.bat / rotate-key.bat -
:: change all four .bat files and the .sh together. Sets COMPOSE=docker compose when
:: `docker compose version --short` is at least 2.20, else leaves COMPOSE
:: undefined and _CV holding the version found.
:require_compose
set "COMPOSE="
set "_CV="
set "_CMAJ="
set "_CMIN="
for /f "usebackq delims=" %%V in (`docker compose version --short 2^>nul`) do if not defined _CV set "_CV=%%V"
if not defined _CV goto :eof
set "_CV=!_CV: =!"
if /i "!_CV:~0,1!"=="v" set "_CV=!_CV:~1!"
for /f "tokens=1,2 delims=.-+" %%A in ("!_CV!") do (
  set "_CMAJ=%%A"
  set "_CMIN=%%B"
)
if not defined _CMAJ goto :eof
if not defined _CMIN goto :eof
for /f "delims=0123456789" %%X in ("!_CMAJ!!_CMIN!") do goto :eof
if !_CMAJ! GTR 2 set "COMPOSE=docker compose"
if !_CMAJ! EQU 2 if !_CMIN! GEQ 20 set "COMPOSE=docker compose"
goto :eof
