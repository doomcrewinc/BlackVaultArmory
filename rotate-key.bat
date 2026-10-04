@echo off
:: rotate-key.bat — rotate BlackVault's field-encryption key. Mirrors
:: rotate-key.sh. :require_compose and :restrict_file (bottom of this file)
:: mirror scripts/compose-provider.sh and install.bat's :restrict_env; batch
:: cannot source a shell script, so this logic is duplicated here and must be
:: changed together with scripts/compose-provider.sh and install.bat/update.bat.
::
:: Stops the app, snapshots the database, generates a new key, runs the
:: rotation inside the container in one transaction, and only then swaps the
:: key files and restarts.
::
:: scripts\rotate-encryption-key.mjs can
:: exit non-zero AFTER its transaction already committed. Treating every
:: non-zero rotation run as "nothing changed" could delete the only copy of
:: a key the database is already encrypted with. So a non-zero rotation run
:: is followed by a read-only --probe (OLD/NEW/NEITHER, by which key opens
:: the database's key check) before anything is deleted or restarted: NEW
:: completes the swap exactly as a normal success would, OLD sets the
:: unused new key aside (renamed to .new.unused-<ts>, never deleted)
:: and restarts on the old one, and anything else (NEITHER,
:: or the probe producing no answer at all) keeps every key file untouched,
:: does NOT start the app, and prints exact recovery commands.
:: Exit 3 from the rotation is an up-front refusal: the
:: current key file does not open this database, nothing changed, so no
:: probe; .new is set aside and the app is NOT restarted.
::
:: Run from the folder this script lives in, even when launched with
:: "Run as administrator" (which starts in C:\Windows\System32).
setlocal DisableDelayedExpansion
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo ╔══════════════════════════════════════╗
echo ║   BlackVault — Key Rotation           ║
echo ╚══════════════════════════════════════╝
echo.

set "KEY_FILE=secrets\blackvault_encryption_key"
set "NEW_KEY_FILE=secrets\blackvault_encryption_key.new"

:: A timestamped name, never the bare "secrets\blackvault_encryption_key.old" —
:: the pre-rotation snapshot (step 3) is sealed under THIS run's old key, so a
:: second rotation must never silently overwrite the file that opens it.
set "OLD_TS="
for /f "usebackq delims=" %%T in (`powershell -NoProfile -NonInteractive -Command "[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')" 2^>nul`) do set "OLD_TS=%%T"
if not defined OLD_TS set "OLD_TS=rotate"
set "OLD_KEY_FILE=secrets\blackvault_encryption_key.old-!OLD_TS!"
if exist "!OLD_KEY_FILE!" set "OLD_KEY_FILE=!OLD_KEY_FILE!-%RANDOM%"
:: The wrappers NEVER delete a key file that may
:: have been handed to the rotation. When the probe confirms OLD, .new is
:: renamed to this name instead of deleted, in case the probe was wrong.
set "UNUSED_KEY_FILE=secrets\blackvault_encryption_key.new.unused-!OLD_TS!"
if exist "!UNUSED_KEY_FILE!" set "UNUSED_KEY_FILE=!UNUSED_KEY_FILE!-%RANDOM%"

:: ── 1. Check the current key exists ───────────────────────────
:: Rotation works on the key FILE. A key held in
:: BLACKVAULT_ENCRYPTION_KEY (.env, or set in this console) would still be
:: passed to the app after the swap and conflict with the new file
:: (KEY_CONFLICT), so refuse before anything is stopped.
set "ENV_KEY_SOURCE="
if defined BLACKVAULT_ENCRYPTION_KEY set "ENV_KEY_SOURCE=the console environment"
if defined ENV_KEY_SOURCE goto :env_key_in_use
:: .env is read the way install.bat and update.bat read it. A line that
:: reader refuses still reaches the app through Docker Compose, so it
:: counts as a key held in .env. A value of spaces only is no key (the
:: app trims it). The value is never printed.
call :env_value BLACKVAULT_ENCRYPTION_KEY
:env_key_trim
if not defined _EV goto :env_key_trimmed
if "!_EV:~0,1!"==" " set "_EV=!_EV:~1!" & goto :env_key_trim
if "!_EV:~0,1!"=="	" set "_EV=!_EV:~1!" & goto :env_key_trim
if "!_EV:~-1!"==" " set "_EV=!_EV:~0,-1!" & goto :env_key_trim
if "!_EV:~-1!"=="	" set "_EV=!_EV:~0,-1!" & goto :env_key_trim
:env_key_trimmed
if defined _EV set "ENV_KEY_SOURCE=.env"
set "_EV="
if defined _EV_BAD set "ENV_KEY_SOURCE=.env"
if defined ENV_KEY_SOURCE goto :env_key_in_use
:no_env_key
if not exist "%KEY_FILE%" (
  echo ERROR: %KEY_FILE% not found. Nothing to rotate.
  echo        Run install.bat first, or restore your key file from backup.
  pause
  exit /b 1
)
:: A leftover .new may be the ONLY copy of the key the
:: database is encrypted with (an earlier run that ended ambiguously). Never
:: overwrite or delete it; refuse before anything is stopped.
if exist "%NEW_KEY_FILE%" goto :stale_new_key

:: ── Docker Compose v2.20+ ─────────────────────────────────────
:: Exits before anything is touched when it is missing or older, so the
:: running BlackVault keeps running.
call :require_compose
if not defined COMPOSE goto :compose_too_old

:: A restore that did not finish left its marker in the uploads folder, and
:: BlackVault refuses to start while it is there. Re-keying a half-restored
:: install would only add to what has to be untangled: refuse before the stop.
call :restore_markers
if defined BV_MARKERS goto :restore_marker_left

:: No `-v` mount of secrets\ is needed. docker-compose.yml
:: already mounts the whole secrets\ folder into every blackvault container,
:: `compose run` ones included, and the image's entrypoint copies
:: blackvault_encryption_key and blackvault_encryption_key.new from it into
:: /run/secrets, readable by the app user (uid 1001).

:: ── 2. Stop the app ────────────────────────────────────────────
echo Stopping BlackVault...
%COMPOSE% stop blackvault
if errorlevel 1 goto :stop_failed

:: ── 3. Snapshot the database (same script the update scripts use) ──
:: Called unconditionally; if it fails (or is missing), stop
:: here - never rotate without a snapshot.
echo.
echo Snapshotting database...
call scripts\db-snapshot.bat
if errorlevel 1 goto :snapshot_failed
:: db-snapshot.bat also snapshotted the uploads folder. This script
:: restarts with `compose start`, which does not recreate the container, so
:: the marker would never reach the app anyway - and is not needed: a
:: rotation never leaves plaintext uploads for the app to snapshot again.
del /f /q "backups\.uploads-snapshot-marker" >nul 2>&1

:: ── 4. Generate the new key ─────────────────────────────────────
:: 64 hex characters (32 bytes) from the OS CSPRNG, same approach as
:: install.bat's PostgreSQL password (there 24 bytes / 48 hex chars).
:: PowerShell's built-in random cmdlet is NOT used: it is not
:: cryptographically secure. Never echoed to the terminal.
echo.
echo Generating new encryption key...
set "NEW_KEY="
for /f "usebackq delims=" %%K in (`powershell -NoProfile -NonInteractive -Command "$b = New-Object byte[] 32; [Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })" 2^>nul`) do set "NEW_KEY=%%K"
if not defined NEW_KEY goto :key_gen_failed
if "!NEW_KEY:~63,1!"=="" goto :key_gen_failed
if not "!NEW_KEY:~64!"=="" goto :key_gen_failed
for /f "delims=0123456789abcdef" %%X in ("!NEW_KEY!") do goto :key_gen_failed

:: The restrictive ACL is applied to an EMPTY file BEFORE any key
:: material is written, not after — no window where the new key sits in a
:: file still carrying the default (inherited) ACL. A failed icacls aborts
:: the run instead of silently leaving an unhardened key file. .new cannot
:: exist here (checked in step 1).
type nul > "%NEW_KEY_FILE%"
if errorlevel 1 goto :key_gen_failed
call :restrict_file "%NEW_KEY_FILE%"
if not defined RESTRICT_OK goto :key_restrict_failed
(echo !NEW_KEY!)>"%NEW_KEY_FILE%"
if errorlevel 1 goto :key_gen_failed
set "NEW_KEY="

:: ── 5. Run the rotation inside the container, in one transaction ──
echo.
echo Rotating encryption key (this may take a while on a large inventory)...
%COMPOSE% run --rm blackvault node scripts/rotate-encryption-key.mjs --old-key-file /run/secrets/blackvault_encryption_key --new-key-file /run/secrets/blackvault_encryption_key.new
if not errorlevel 1 goto :do_swap
:: Exit 3 exactly (errorlevel N means "N or more"): refused before any
:: transaction opened.
if errorlevel 3 if not errorlevel 4 goto :rotate_refused

:: The rotation command itself exited non-zero. That does NOT mean nothing
:: changed: the transaction may already have committed and
:: only a step after it failed. Ask the database itself before touching
:: anything.
echo.
echo The rotation command exited with an error. Checking which key the database
echo is actually encrypted with before touching any file...
::
:: The probe prints a SECOND line, "FILES old=<n> new=<n> rot=<n>".
:: Only the FIRST line is the answer: "do set" alone kept the LAST line, which
:: would have read the FILES line as the answer. The second line is kept
:: separately for its staged .rot count.
set "PROBE_ANSWER="
set "PROBE_FILES="
for /f "usebackq delims=" %%P in (`%COMPOSE% run --rm blackvault node scripts/rotate-encryption-key.mjs --probe --old-key-file /run/secrets/blackvault_encryption_key --new-key-file /run/secrets/blackvault_encryption_key.new 2^>nul`) do (
  if not defined PROBE_ANSWER (set "PROBE_ANSWER=%%P") else if not defined PROBE_FILES set "PROBE_FILES=%%P"
)

if "!PROBE_ANSWER!"=="NEW" goto :probe_new
if "!PROBE_ANSWER!"=="OLD" goto :probe_old
goto :probe_ambiguous

:: A crash after the commit can leave re-encrypted uploads staged as
:: <name>.rot. They are left to BlackVault's startup, which runs before it
:: serves anything and renames every .rot under its current key into place,
:: after proving it decrypts (src\lib\files\startup.ts). The swap makes the
:: new key current, so the restart finishes them; the wrapper doing the same
:: renames would only repeat it.
:probe_new
echo Confirmed: the database is already encrypted with the NEW key.
set "PROBE_ROT="
if defined PROBE_FILES for /f "tokens=1,7 delims== " %%A in ("!PROBE_FILES!") do if "%%A"=="FILES" set "PROBE_ROT=%%B"
if defined PROBE_ROT if not "!PROBE_ROT!"=="0" echo !PROBE_ROT! re-encrypted uploaded files are staged as .rot files; BlackVault puts them in place when it starts with the new key.
echo Completing the key-file swap...
goto :do_swap

:: Set the unused .new aside, never delete it.
:probe_old
echo Confirmed: the database is still encrypted with the OLD key; the
echo rotation did not take effect.
move /y "%NEW_KEY_FILE%" "%UNUSED_KEY_FILE%" >nul
if errorlevel 1 goto :probe_old_rename_failed
echo The unused new key was set aside as %UNUSED_KEY_FILE%.
echo It can be deleted once BlackVault has run normally on the old key.
goto :probe_old_restart
:probe_old_rename_failed
echo WARNING: could not rename %NEW_KEY_FILE% to %UNUSED_KEY_FILE%.
echo          Move it out of secrets\ by hand before the next rotation.
:probe_old_restart
echo Restarting BlackVault on the previous key; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:: ── 6. Success: swap the key files and restart ──────────────
:: Reached either from step 5 directly, or from the probe confirming NEW —
:: both are the same recovery from here on.
:do_swap
move /y "%KEY_FILE%" "%OLD_KEY_FILE%" >nul
if errorlevel 1 goto :swap_failed_1
move /y "%NEW_KEY_FILE%" "%KEY_FILE%" >nul
if errorlevel 1 goto :swap_failed_2
%COMPOSE% start blackvault
if errorlevel 1 goto :restart_after_swap_failed
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   Key rotation complete.                                   ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo Back up %KEY_FILE% now.
echo The pre-rotation database snapshot in backups\ is encrypted with the OLD
echo key, now saved as %OLD_KEY_FILE%. That file can only be opened with it, so
echo keep %OLD_KEY_FILE% for as long as you keep that snapshot.
pause
exit /b 0

:: ════════════════════════════════════════════════════════════
:: Failure paths
:: ════════════════════════════════════════════════════════════

:probe_ambiguous
if not defined PROBE_ANSWER set "PROBE_ANSWER=(no answer)"
echo.
echo ERROR: could not determine whether the database is encrypted with the OLD
echo        or the NEW key (probe answered "!PROBE_ANSWER!").
echo        Nothing was deleted. BlackVault was NOT restarted.
echo        Do NOT delete %KEY_FILE% or %NEW_KEY_FILE%.
echo        To resolve by hand:
:: The probe command is printed on ONE line. A trailing caret would
:: escape the newline and join the following echo lines into this one.
:: In this state the active key file still holds the OLD key, the only key for
:: the pre-rotation snapshot, so step 2 moves it aside first.
echo          1. Make sure Docker/the database are reachable, then re-run this one line:
echo             %COMPOSE% run --rm blackvault node scripts/rotate-encryption-key.mjs --probe --old-key-file /run/secrets/blackvault_encryption_key --new-key-file /run/secrets/blackvault_encryption_key.new
echo          2. If it answers NEW:
echo               move /y %KEY_FILE% %OLD_KEY_FILE%
echo               move /y %NEW_KEY_FILE% %KEY_FILE%
echo               %COMPOSE% start blackvault
echo             Keep %OLD_KEY_FILE% for as long as you keep the pre-rotation snapshot.
echo          3. If it answers OLD:
echo               move /y %NEW_KEY_FILE% %UNUSED_KEY_FILE%
echo               %COMPOSE% start blackvault
echo          4. If it answers NEITHER: %KEY_FILE% is not this database's key.
echo             Restore the right key file as %KEY_FILE%, then run the probe again.
pause
exit /b 1

:: The rotation refused up front (exit 3). Nothing changed
:: and nothing could have, so no probe. The unused .new is set aside, never
:: deleted, and the app is NOT restarted: with a key file that is not
:: this database's key it would refuse to start anyway. Exit 3 also
:: means an uploaded file is under neither key (or damaged, or behind a
:: symlinked folder); the app refuses to start on that file too.
:rotate_refused
echo.
echo ERROR: the rotation refused before changing anything; the reason is printed above.
echo        Nothing was changed. BlackVault was NOT restarted.
move /y "%NEW_KEY_FILE%" "%UNUSED_KEY_FILE%" >nul
if errorlevel 1 goto :rotate_refused_rename_failed
echo        The unused new key was set aside as %UNUSED_KEY_FILE%; it can be deleted.
goto :rotate_refused_hint
:rotate_refused_rename_failed
echo        WARNING: could not rename %NEW_KEY_FILE% to %UNUSED_KEY_FILE%.
echo        Move it out of secrets\ by hand before the next rotation.
:rotate_refused_hint
echo        If it says the old key does not match:
echo          %KEY_FILE% does not open this database (wrong or replaced key).
echo          Restore the key this database was encrypted with as %KEY_FILE%
echo          (BlackVault's startup log names its key id: %COMPOSE% logs blackvault),
echo          start BlackVault, then run rotate-key.bat again.
echo        If it names an uploaded file or folder: restore that file from a backup,
echo          or move it out of the uploads folder (or follow the hint above), then
echo          start BlackVault and run rotate-key.bat again.
pause
exit /b 1

:snapshot_failed
echo ERROR: database snapshot failed. See the output above.
echo Restarting BlackVault; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:: The .new deleted here was created by THIS run a moment ago and never
:: handed to the rotation, so the database cannot be using it (a stale .new
:: from an earlier run is refused in step 1 and never reaches this point).
:key_gen_failed
echo ERROR: could not generate a new encryption key.
if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
echo Restarting BlackVault; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:key_restrict_failed
echo ERROR: could not restrict the new key file to your user account with icacls.
echo        Refusing to write key material to an unhardened file.
if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
echo Restarting BlackVault; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:swap_failed_1
echo.
echo ERROR: rotation succeeded, but renaming the key files failed.
echo        %KEY_FILE% should still hold the OLD key, unchanged.
echo        The database itself is now encrypted with the NEW key, in %NEW_KEY_FILE%.
:: Move the OLD key aside FIRST - it is the only key that opens the
:: pre-rotation snapshot taken in step 3.
echo        Recover by hand, then restart:
echo          move /y %KEY_FILE% %OLD_KEY_FILE%
echo          move /y %NEW_KEY_FILE% %KEY_FILE%
echo          %COMPOSE% start blackvault
echo        Back up %KEY_FILE% once BlackVault is confirmed working, and keep
echo        %OLD_KEY_FILE% for as long as you keep the pre-rotation snapshot.
pause
exit /b 1

:swap_failed_2
echo.
echo ERROR: rotation succeeded, but finishing the key-file swap failed.
echo        %KEY_FILE% is now MISSING. %OLD_KEY_FILE% holds the ORIGINAL (old) key.
echo        %NEW_KEY_FILE% holds the key the database is now actually encrypted with.
echo        Recover by hand, then restart:
echo          move /y %NEW_KEY_FILE% %KEY_FILE%
echo          %COMPOSE% start blackvault
echo        Back up %KEY_FILE% once BlackVault is confirmed working.
pause
exit /b 1

:restart_after_swap_failed
echo.
echo Key rotation succeeded and the key files were swapped, but BlackVault
echo failed to restart.
echo Back up %KEY_FILE% now - the pre-rotation database snapshot in backups\ is
echo encrypted with the OLD key, now at %OLD_KEY_FILE%; keep that file for as
echo long as you keep that snapshot.
echo Start BlackVault by hand once you've checked the logs: %COMPOSE% start blackvault
pause
exit /b 1

:env_key_in_use
echo ERROR: Key rotation works on %KEY_FILE%. Your key is in
echo        BLACKVAULT_ENCRYPTION_KEY (from !ENV_KEY_SOURCE!): move it into that file
echo        (and remove it from .env / the console) first: put the same 64 hex
echo        characters in %KEY_FILE%, delete the BLACKVAULT_ENCRYPTION_KEY line
echo        from .env, and start BlackVault once to check it.
echo        Nothing was changed; BlackVault was not stopped.
pause
exit /b 1

:restore_marker_left
echo ERROR: the uploads folder holds a marker left by a restore: !BV_MARKERS!.
echo        This version of BlackVault refuses to start while a marker exists: the
echo        restore that left it may not have finished. If backups\ holds a
echo        restore-[time]-RECOVERY.txt file, follow it. If BlackVault is running
echo        and its records, photos and documents are what you expect, remove
echo        every marker with:
echo          !BV_MARKER_CMDS!
echo        Then run rotate-key.bat again. Nothing was changed; BlackVault was not stopped.
pause
exit /b 1

:stale_new_key
echo ERROR: %NEW_KEY_FILE% already exists, left by an earlier rotation.
echo        It may hold the key the database is encrypted with, so this script
echo        will not overwrite it. Nothing was changed; BlackVault was not stopped.
echo        Resolve it first (see the earlier run's output, or check which key
echo        the database uses with the --probe command in rotate-key.bat), then
echo        move it out of secrets\ and run this script again.
pause
exit /b 1

:stop_failed
echo.
echo ERROR: could not stop BlackVault. See the output above.
echo        Nothing was changed.
pause
exit /b 1

:compose_too_old
if defined _CV (
  echo ERROR: Docker Compose !_CV! is too old. BlackVault needs v2.20 or newer.
) else (
  echo ERROR: BlackVault needs Docker Compose v2.20 or newer, run as
  echo        'docker compose' ^(the Compose v2 plugin^).
)
echo        Upgrade Docker Desktop: https://docs.docker.com/desktop/
echo        Nothing was changed.
pause
exit /b 1

:: ════════════════════════════════════════════════════════════
:: Subroutines
:: ════════════════════════════════════════════════════════════

:: Mirrors require_compose / compose_version_ok in scripts/compose-provider.sh
:: and the identical :require_compose in install.bat / update.bat — change all
:: three .bat files and the .sh together. Sets COMPOSE=docker compose when
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

:: :restore_markers - looks in the uploads folder of the DATA_DIR in .env for
:: markers left by a restore: anything named .restore-[stamp].db-started with
:: a stamp that is not empty, a folder (what the restore program creates) or a
:: file. The rule of restore.bat, scripts\snapshot-restore.sh and the app's
:: own start. Sets BV_MARKERS to their paths (left undefined when there is
:: none) and BV_MARKER_CMDS to ONE command line that removes them all. A
:: DATA_DIR line :env_value refuses gives no marker here (the snapshot step
:: refuses that line), and neither does an uploads folder that is not there.
:: update.bat and rotate-key.bat carry the same copy: change them together.
:restore_markers
set "BV_MARKERS="
set "BV_MARKER_CMDS="
call :env_value DATA_DIR
if defined _EV_BAD goto :eof
set "BV_UP=!_EV!"
if not defined BV_UP set "BV_UP=.\data"
:: .env may spell the folder with forward slashes; `if exist` and `for` need backslashes.
set "BV_UP=!BV_UP:/=\!\uploads"
if not exist "!BV_UP!\" goto :eof
for /d %%M in ("!BV_UP!\.restore-*.db-started") do (set "BV_ONE=%%~nxM"& call :restore_marker_add)
for %%M in ("!BV_UP!\.restore-*.db-started") do (set "BV_ONE=%%~nxM"& call :restore_marker_add)
goto :eof

:: :restore_marker_add - adds the marker named in BV_ONE to BV_MARKERS and its
:: clear-marker command to BV_MARKER_CMDS, joined with ^&^& so that the whole
:: is one command line. The stamp is quoted: a hand-made name may hold a space.
:restore_marker_add
:: The stamp is the name without ".restore-" (9 characters) and ".db-started" (11).
set "BV_ONE=!BV_ONE:~9,-11!"
if not defined BV_ONE goto :eof
if defined BV_MARKERS set "BV_MARKERS=!BV_MARKERS!, "
set "BV_MARKERS=!BV_MARKERS!!BV_UP!\.restore-!BV_ONE!.db-started"
if defined BV_MARKER_CMDS set "BV_MARKER_CMDS=!BV_MARKER_CMDS! && "
set "BV_MARKER_CMDS=!BV_MARKER_CMDS!docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\backups:/bv-backups:ro" -v "!CD!\scripts\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh clear-marker /app/uploads "!BV_ONE!""
goto :eof

:: :env_value KEY - the value of KEY in .\.env in _EV, read the way Docker
:: Compose reads the file. Mirrors env_value in scripts/compose-provider.sh:
:: change them together. _EV is undefined when KEY is unset or empty, or there
:: is no .env; _EV_SET is 1 when .env assigns KEY at all, even to nothing.
:: Forms read:
::   KEY=value      export KEY=value      KEY = value   (spaces or tabs)
::   KEY="value"    KEY='value'           one pair of quotes removed
::   KEY=value # comment                  cut at the first space before a #
:: with leading whitespace and CRLF allowed, lines starting with # ignored,
:: and the LAST assignment winning. A Windows path is best written unquoted.
:: A line whose value Compose would change or reject, or that batch cannot
:: split, is REFUSED: _EV stays undefined, _EV_BAD is set and a Note says how
:: to write the line. The caller must not go on as if the key were unset.
:: Refused:
::   a $ in an unquoted or double-quoted value (Compose substitutes $VAR);
::   in double quotes, a \ before a b f n r t v 0 or another \ (Compose
::   unescapes those: "C:\new" holds a newline) or before the closing quote;
::   any other \ there is text, so "C:\BlackVault\Data" is read;
::   in single quotes, an apostrophe inside the value or a \ before the
::   closing quote; KEY: value when no KEY= line follows it; a quoted value
::   followed by a comment or other text; a double quote anywhere except as
::   the one pair around the whole value; a value that starts with =.
::   a ! anywhere on a line assigning KEY, a comment on it included:
::   delayed expansion would drop it from the value without a trace;
::   a leading ~ in a folder key (one whose name ends in _DIR: DATA_DIR,
::   BLACKVAULT_BACKUP_DIR): Compose puts the home folder in its place.
::   a KEY line that is the first line of a .env starting with a byte order
::   mark (a mark before a comment line or before another key is harmless).
:: Not told apart: a bare KEY line (no = at all) reads here as KEY= (set to
:: nothing); Compose takes the value from the environment for such a line.
:: The backslash rules were probed against one version of Compose (compose-go
:: v2.16.1); an older Docker Compose was not run.
:env_value
set "_EV="
set "_EV_SET="
set "_EV_BAD="
set "_EV_CUT="
if not exist ".env" goto :eof
:: A .env saved with a byte order mark, whose FIRST line sets the key (KEY=,
:: KEY:, with or without export), refuses the key. The mark is one or three
:: characters to this script, depending on the code page, and `if` treats it
:: as no character at all on a UTF-8 code page, so nothing below can be
:: relied on to see the key behind it, or to miss it. Found here by what is
:: NOT at the start of line 1: a letter, a digit, _, # or white space.
findstr /n /r /c:"^[^a-zA-Z0-9_# 	][ 	]*%~1[ 	]*[=:]" /c:"^[^a-zA-Z0-9_# 	][^a-zA-Z0-9_# 	][^a-zA-Z0-9_# 	][ 	]*%~1[ 	]*[=:]" /c:"^[^a-zA-Z0-9_# 	][ 	]*export[ 	][ 	]*%~1[ 	]*[=:]" /c:"^[^a-zA-Z0-9_# 	][^a-zA-Z0-9_# 	][^a-zA-Z0-9_# 	][ 	]*export[ 	][ 	]*%~1[ 	]*[=:]" ".env" 2>nul | findstr /b /c:"1:" >nul 2>&1
if not errorlevel 1 goto :env_value_bom
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do for /f "tokens=1,2,3" %%K in ("%%A") do (
  if "%%L"=="" if "%%K"=="%~1" (set "_EV=%%B"& set "_EV_SET=1")
  if "%%M"=="" if "%%K"=="export" if "%%L"=="%~1" (set "_EV=%%B"& set "_EV_SET=1")
)
:: for /f took every = after the key as one separator, so a value that
:: starts with = has lost it: such a line, anywhere in the file, refuses the key.
findstr /r /c:"^[ 	]*%~1[ 	]*==" /c:"^[ 	]*export[ 	][ 	]*%~1[ 	]*==" ".env" >nul 2>&1
if not errorlevel 1 set "_EV_SET=1" & goto :env_value_bad
:: A ! on a line assigning the key, anywhere in the file, refuses the key.
:: The pattern holds a ! of its own, so it is searched for with delayed
:: expansion off.
setlocal DisableDelayedExpansion
findstr /r /c:"^[ 	]*%~1[ 	]*=.*!" /c:"^[ 	]*export[ 	][ 	]*%~1[ 	]*=.*!" ".env" >nul 2>&1
if not errorlevel 1 (endlocal & set "_EV_SET=1" & goto :env_value_bad)
endlocal
:: A KEY: value line never reached the loop above as KEY. Compose uses the
:: LAST assignment of a key, so such a line refuses the key only when no
:: KEY= line comes after it (line numbers from findstr /n).
set "_EVY=0"
set "_EVA=0"
for /f "usebackq delims=:" %%N in (`findstr /n /r /c:"^[ 	]*%~1[ 	]*:" /c:"^[ 	]*export[ 	][ 	]*%~1[ 	]*:" ".env" 2^>nul`) do set "_EVY=%%N"
if "!_EVY!"=="0" goto :env_value_trim
for /f "usebackq delims=:" %%N in (`findstr /n /r /c:"^[ 	]*%~1[ 	]*=" /c:"^[ 	]*export[ 	][ 	]*%~1[ 	]*=" ".env" 2^>nul`) do set "_EVA=%%N"
if !_EVY! GTR !_EVA! set "_EV_SET=1" & goto :env_value_bad
:env_value_trim
if not defined _EV goto :env_value_done
if "!_EV:~0,1!"==" " set "_EV=!_EV:~1!" & goto :env_value_trim
if "!_EV:~0,1!"=="	" set "_EV=!_EV:~1!" & goto :env_value_trim
if "!_EV:~-1!"==" " set "_EV=!_EV:~0,-1!" & goto :env_value_trim
if "!_EV:~-1!"=="	" set "_EV=!_EV:~0,-1!" & goto :env_value_trim
if defined _EV_CUT goto :env_value_dollar
set "_EVQ=!_EV:"=!"
if not "!_EVQ!"=="!_EV!" goto :env_value_dquote
if "!_EV:~0,1!"=="'" goto :env_value_squote
:: Unquoted: cut at the first space that is followed by #. A tab before the
:: # does not start a comment, and neither does a # that opens the value.
set "_EV_CUT=1"
if "!_EV:#=!"=="!_EV!" goto :env_value_dollar
set "_EVI=1"
:env_value_scan
if "!_EV:~%_EVI%,1!"=="" goto :env_value_dollar
if "!_EV:~%_EVI%,2!"==" #" set "_EV=!_EV:~0,%_EVI%!" & goto :env_value_trim
set /a _EVI+=1
goto :env_value_scan
:env_value_dollar
if not "!_EV:$=!"=="!_EV!" goto :env_value_bad
goto :env_value_done
:env_value_dquote
:: Without its double quotes the value must equal the value without its
:: first and last characters: exactly one pair, around the whole value.
if not "!_EV:~1,-1!"=="!_EVQ!" goto :env_value_bad
set "_EV=!_EVQ!"
if not defined _EV goto :env_value_done
if not "!_EV:$=!"=="!_EV!" goto :env_value_bad
if "!_EV:\=!"=="!_EV!" goto :env_value_done
:: Each \ and the character after it. IF compares with case, as Compose
:: does: \r is a carriage return to Compose, \R is two characters.
set "_EVI=0"
:env_value_escape
set "_EVC=!_EV:~%_EVI%,2!"
if not defined _EVC goto :env_value_done
set /a _EVI+=1
if not "!_EVC:~0,1!"=="\" goto :env_value_escape
if "!_EVC!"=="\" goto :env_value_bad
if "!_EVC!"=="\\" goto :env_value_bad
for %%E in (a b f n r t v 0) do if "!_EVC!"=="\%%E" goto :env_value_bad
goto :env_value_escape
:env_value_squote
if "!_EV:~1,1!"=="" goto :env_value_bad
if not "!_EV:~-1!"=="'" goto :env_value_bad
set "_EV=!_EV:~1,-1!"
if not defined _EV goto :env_value_done
if not "!_EV:'=!"=="!_EV!" goto :env_value_bad
if "!_EV:~-1!"=="\" goto :env_value_bad
goto :env_value_done
:env_value_bom
set "_EV="
set "_EV_SET=1"
set "_EV_BAD=1"
echo Note: the %~1 line in .env is written in a form this script does not read:
echo       .env starts with a byte order mark, and that line is its first.
echo       Save .env without a byte order mark (in Notepad: Save As, encoding
echo       UTF-8, not UTF-8 with BOM), or put a comment line first.
goto :env_value_done
:env_value_bad
set "_EV="
set "_EV_BAD=1"
echo Note: the %~1 line in .env is written in a form this script does not read:
echo       Docker Compose would change its value, or reject the line. Rewrite
echo       that line, or delete it, as %~1=value with the final value spelled
echo       out and no $ in it: best for a Windows path. In single quotes the
echo       value must hold no apostrophe and not end in a backslash. In double
echo       quotes it must hold no $ and no backslash before a b f n r t v 0,
echo       another backslash or the closing quote. Nothing may follow a
echo       closing quote, and a %~1: value line must become %~1=value. The
echo       line must hold no exclamation mark, and a folder must not start
echo       with ~: write the full path.
:env_value_done
set "_EVK=%~1"
if defined _EV if "!_EVK:~-4!"=="_DIR" if "!_EV:~0,1!"=="~" goto :env_value_bad
set "_EVK="
set "_EVQ="
set "_EVC="
goto :eof

:: :restrict_file PATH - restricts PATH to the current user, the same way
:: install.bat's :restrict_env restricts .env: grant the user full control
:: first, and only then drop inherited permissions. Sets RESTRICT_OK=1 on
:: success; leaves it undefined on ANY failure (the caller
:: aborts instead of silently continuing with an unhardened file).
:restrict_file
set "RESTRICT_OK="
set "_SID="
for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh 2^>nul') do set "_SID=%%~S"
if not defined _SID goto :eof
icacls "%~1" /grant:r "*!_SID!:F" >nul 2>&1
if errorlevel 1 goto :eof
icacls "%~1" /inheritance:r >nul 2>&1
if errorlevel 1 goto :eof
set "RESTRICT_OK=1"
goto :eof
