@echo off
:: db-snapshot.bat - copy BlackVault's database into backups\ next to
:: docker-compose.yml, before an upgrade or a key rotation. Windows twin of
:: scripts/db-snapshot.sh (field-encryption spec section 3, "Update scripts"
:: and "Rotation"): change them together.
::
:: Called as `call scripts\db-snapshot.bat` by update.bat (before the new
:: image starts) and rotate-key.bat (after it has stopped the app).
::
:: Contract: no arguments; errorlevel 0 only when a snapshot was
:: written (or there is no database yet to copy); any failure returns
:: errorlevel 1 and the caller stops. It never pauses and never exits the
:: caller: only `exit /b`. The caller's variables and folder are untouched
:: (setlocal, pushd/popd).
::
::   SQLite      stops the app (a consistent copy), then copies
::               DATA_DIR\db\vault.db to backups\blackvault-YYYYmmdd-HHMMSS.db.
::               It does NOT start the app again: the caller decides.
::   PostgreSQL  pg_dump through the db container (started if needed) to
::               backups\blackvault-YYYYmmdd-HHMMSS.sql. The app keeps running.
::
:: backups\ is restricted to the current user (icacls) BEFORE anything is
:: copied into it: a snapshot is a plain copy of the database.
::
:: Encrypted files at rest: independent of DB_PROVIDER, this script
:: also copies DATA_DIR\uploads into backups\uploads-<TS>\ (skipped, still
:: errorlevel 0, when uploads\ is missing or has no files), leaving out
:: .pre-encryption-* folders and *.tmp / *.rot files. backups\uploads-
:: <TS>\ is restricted to the current user with icacls BEFORE anything is
:: copied into it, and inheritance does the rest - no per-file icacls needed.
:: On success it writes that path to backups\.uploads-snapshot-marker; the
:: caller (update.bat / rotate-key.bat) reads that file once and removes it.
:: update.bat passes it as BLACKVAULT_UPLOADS_SNAPSHOT to the ONE `up` that
:: follows - never to .env - so the app's own startup step does not take a
:: second snapshot of the same files. See :snapshot_uploads below.
setlocal EnableDelayedExpansion
pushd "%~dp0.." || exit /b 1

:: docker compose must get the BLACKVAULT_* keys from .env only.
set "BLACKVAULT_DATABASE_URL="
set "BLACKVAULT_DB_PROVIDER="
set "BLACKVAULT_POSTGRES_PASSWORD="

:: The caller's Compose command (update.bat / rotate-key.bat set COMPOSE
:: after checking the version); plain `docker compose` when run on its own.
if not defined COMPOSE set "COMPOSE=docker compose"

call :provider_from_env
if "!DB_PROVIDER!"=="unreadable" (
  set "FAIL_MSG=BLACKVAULT_DB_PROVIDER in .env could not be read: see the Note above."
  goto :fail
)
set "TS="
for /f "usebackq delims=" %%T in (`powershell -NoProfile -NonInteractive -Command "[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')" 2^>nul`) do set "TS=%%T"
if not defined TS (
  set "FAIL_MSG=could not read the time for the snapshot name."
  goto :fail
)

if not exist "backups\" mkdir "backups" 2>nul
if not exist "backups\" (
  set "FAIL_MSG=could not create the backups folder."
  goto :fail
)
set "_SID="
for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh 2^>nul') do set "_SID=%%~S"
if not defined _SID goto :acl_failed
icacls "backups" /grant:r "*!_SID!:(OI)(CI)F" >nul 2>&1
if errorlevel 1 goto :acl_failed
icacls "backups" /inheritance:r >nul 2>&1
if errorlevel 1 goto :acl_failed

:: DATA_DIR is read here, before the provider branch, because the uploads
:: snapshot below needs it on BOTH providers (:snapshot_uploads uses it too).
:: A line :env_value refuses is not a missing one: .\data is not assumed.
call :env_value DATA_DIR
if defined _EV_BAD (
  set "FAIL_MSG=DATA_DIR in .env could not be read: see the Note above."
  goto :fail
)
:: docker compose takes DATA_DIR from the console before .env; this script
:: reads .env. If the two differ, the copy below would be of one folder while
:: the caller's compose commands (stop, up) act on another.
if defined DATA_DIR if not "!DATA_DIR!"=="!_EV!" (
  set "FAIL_MSG=DATA_DIR is set in this console and is not the DATA_DIR in .env, so docker compose and this snapshot would use different folders. Run 'set DATA_DIR=' first."
  goto :fail
)
set "DATA_DIR=!_EV!"
if not defined DATA_DIR set "DATA_DIR=.\data"

if /i not "!DB_PROVIDER!"=="sqlite" goto :postgres

:: ── SQLite ────────────────────────────────────────────────────
set "DB=!DATA_DIR!\db\vault.db"
if not exist "!DB!" (
  echo No SQLite database at !DB! yet; nothing to snapshot.
  goto :ok_nothing
)
set "OUT=backups\blackvault-!TS!.db"
echo Stopping BlackVault for a consistent copy of the database...
%COMPOSE% stop blackvault
if errorlevel 1 (
  set "FAIL_MSG=could not stop BlackVault."
  goto :fail
)
:: A leftover rollback journal or WAL (after a crash) belongs to the
:: database, so it is copied beside it.
copy /b /y "!DB!" "!OUT!.partial" >nul
if errorlevel 1 goto :copy_failed
if exist "!DB!-journal" (
  copy /b /y "!DB!-journal" "!OUT!-journal" >nul
  if errorlevel 1 goto :copy_failed
)
if exist "!DB!-wal" (
  copy /b /y "!DB!-wal" "!OUT!-wal" >nul
  if errorlevel 1 goto :copy_failed
)
move /y "!OUT!.partial" "!OUT!" >nul
if errorlevel 1 goto :copy_failed
goto :ok

:: ── PostgreSQL ────────────────────────────────────────────────
:postgres
set "OUT=backups\blackvault-!TS!.sql"
echo Making sure the database container is running...
%COMPOSE% up -d --wait db
if errorlevel 1 (
  set "FAIL_MSG=could not start the database container."
  goto :fail
)
echo Dumping the PostgreSQL database...
%COMPOSE% exec -T db pg_dump -U blackvault -d blackvault > "!OUT!.partial"
if errorlevel 1 (
  if exist "!OUT!.partial" del /f /q "!OUT!.partial"
  set "FAIL_MSG=pg_dump failed."
  goto :fail
)
for %%F in ("!OUT!.partial") do if %%~zF EQU 0 (
  del /f /q "!OUT!.partial"
  set "FAIL_MSG=pg_dump wrote nothing."
  goto :fail
)
move /y "!OUT!.partial" "!OUT!" >nul
if errorlevel 1 (
  set "FAIL_MSG=could not finish writing !OUT!."
  goto :fail
)

:ok
echo.
echo Database snapshot saved: !OUT!
echo WARNING: this snapshot is a plain, unencrypted copy of the database file. Names,
echo          notes and everything else in it can be read by anyone who can read the
echo          file. Serial numbers and NFA records too, if it was taken before field
echo          encryption was first turned on; otherwise they need the encryption key
echo          that was in use when it was taken.
echo          Delete it once BlackVault is confirmed working:  del "!OUT!"

call :snapshot_uploads
if errorlevel 1 goto :fail

:ok_nothing
popd
exit /b 0

:copy_failed
if exist "!OUT!.partial" del /f /q "!OUT!.partial"
set "FAIL_MSG=could not copy !DB! (permissions? free disk space?)."
goto :fail

:acl_failed
set "FAIL_MSG=could not restrict the backups folder to your user account with icacls."
goto :fail

:fail
echo ERROR: database snapshot failed: !FAIL_MSG!
popd
exit /b 1

:: :snapshot_uploads - mirrors the "Uploads snapshot" block in
:: scripts/db-snapshot.sh: change them together. Needs DATA_DIR and TS
:: (both set above, before the provider branch). Sets FAIL_MSG and returns
:: errorlevel 1 on any failure (the caller does `if errorlevel 1 goto :fail`);
:: errorlevel 0 otherwise, including when there was nothing to snapshot.
::
:: A reparse point (symbolic link or junction) anywhere under uploads\ is
:: never followed and never copied: the PowerShell walk below checks
:: ReparsePoint on every item itself and skips it, rather than using
:: Get-ChildItem -Recurse - which, on Windows PowerShell 5.1 (what these
:: scripts invoke; there is no pwsh dependency), follows a directory
:: symlink/junction by default and could escape the uploads folder entirely.
:: Like scripts/uploads-snapshot.sh, the walk also skips the app's own
:: .pre-encryption-* snapshot folders (plain text, already a copy), a full
:: restore's .restore-* and .pre-restore-* folders, and every
:: *.tmp / *.rot file (half-written or mid-rotation work files).
:: The same walk also copies: a single PowerShell call both counts and
:: copies every other non-reparse-point file, and prints that count on success, so
:: "no files to snapshot" (count 0) and "the copy failed" (no output at all,
:: because the catch block's `exit 1` suppresses the normal `Write-Output`)
:: are told apart by whether UPLOADS_COPIED ends up defined at all - not by
:: errorlevel, which a `for /f` loop over a backquoted command does not
:: reliably reflect in cmd.exe (the same reason update.bat's :require_compose
:: checks "if not defined _CV" rather than errorlevel, for `docker compose
:: version`'s own for /f).
:snapshot_uploads
del /f /q "backups\.uploads-snapshot-marker" >nul 2>&1
for /d %%P in ("backups\uploads-*.partial") do rd /s /q "%%P" 2>nul
set "UPLOADS_SRC=!DATA_DIR!\uploads"
if not exist "!UPLOADS_SRC!\" (
  echo No uploads folder at !UPLOADS_SRC! yet; skipping the uploads snapshot.
  exit /b 0
)
set "UPLOADS_OUT=backups\uploads-!TS!"
if exist "!UPLOADS_OUT!" set "UPLOADS_OUT=!UPLOADS_OUT!-%RANDOM%"
set "UPLOADS_PARTIAL=!UPLOADS_OUT!.partial"
mkdir "!UPLOADS_PARTIAL!" 2>nul
if not exist "!UPLOADS_PARTIAL!\" (
  set "FAIL_MSG=could not create !UPLOADS_PARTIAL!."
  exit /b 1
)
set "_UP_SID="
for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh 2^>nul') do set "_UP_SID=%%~S"
if not defined _UP_SID (
  rd /s /q "!UPLOADS_PARTIAL!" 2>nul
  set "FAIL_MSG=could not restrict !UPLOADS_PARTIAL! to your user account with icacls."
  exit /b 1
)
icacls "!UPLOADS_PARTIAL!" /grant:r "*!_UP_SID!:(OI)(CI)F" >nul 2>&1
if errorlevel 1 goto :uploads_acl_failed
icacls "!UPLOADS_PARTIAL!" /inheritance:r >nul 2>&1
if errorlevel 1 goto :uploads_acl_failed

set "UPLOADS_COPIED="
set "BV_UP_SRC=!UPLOADS_SRC!"
set "BV_UP_DST=!UPLOADS_PARTIAL!"
for /f "usebackq delims=" %%N in (`powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $count = 0; function Copy-BVTree([string]$s, [string]$d) { Get-ChildItem -LiteralPath $s -Force | ForEach-Object { if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { return }; if ($_.PSIsContainer -and ($_.Name -like '.pre-encryption-*' -or $_.Name -like '.restore-*' -or $_.Name -like '.pre-restore-*')) { return }; if (-not $_.PSIsContainer -and ($_.Name -like '*.tmp' -or $_.Name -like '*.rot')) { return }; $dp = Join-Path $d $_.Name; if ($_.PSIsContainer) { New-Item -ItemType Directory -Force -Path $dp | Out-Null; Copy-BVTree $_.FullName $dp } else { [IO.File]::WriteAllBytes($dp, [byte[]]@()); Copy-Item -LiteralPath $_.FullName -Destination $dp -Force; $script:count++ } } }; try { Copy-BVTree $env:BV_UP_SRC $env:BV_UP_DST; Write-Output $count } catch { Write-Error $_; exit 1 }" 2^>nul`) do set "UPLOADS_COPIED=%%N"
set "BV_UP_SRC="
set "BV_UP_DST="
if not defined UPLOADS_COPIED (
  rd /s /q "!UPLOADS_PARTIAL!" 2>nul
  set "FAIL_MSG=could not copy !UPLOADS_SRC! (permissions? free disk space?)."
  exit /b 1
)
if "!UPLOADS_COPIED!"=="0" (
  rd /s /q "!UPLOADS_PARTIAL!" 2>nul
  echo No files in !UPLOADS_SRC! to snapshot; skipping the uploads snapshot.
  exit /b 0
)
move /y "!UPLOADS_PARTIAL!" "!UPLOADS_OUT!" >nul
if errorlevel 1 (
  rd /s /q "!UPLOADS_PARTIAL!" 2>nul
  set "FAIL_MSG=could not finish writing !UPLOADS_OUT!."
  exit /b 1
)
(echo !UPLOADS_OUT!)>"backups\.uploads-snapshot-marker" 2>nul
echo.
echo Uploads snapshot saved: !UPLOADS_OUT!
exit /b 0

:uploads_acl_failed
rd /s /q "!UPLOADS_PARTIAL!" 2>nul
set "FAIL_MSG=could not restrict !UPLOADS_PARTIAL! to your user account with icacls."
exit /b 1

:: Mirrors :provider_from_env in update.bat (and provider_from_env in
:: scripts/compose-provider.sh): change them together.
:provider_from_env
call :env_value BLACKVAULT_DB_PROVIDER
set "DB_PROVIDER=unreadable"
if defined _EV_BAD goto :eof
set "_PV=!_EV!"
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
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do for /f "tokens=1,2,3" %%K in ("%%A") do (
  if "%%L"=="" if "%%K"=="%~1" (set "_EV=%%B"& set "_EV_SET=1")
  if "%%M"=="" if "%%K"=="export" if "%%L"=="%~1" (set "_EV=%%B"& set "_EV_SET=1")
  if "%%L"=="" if "%%K"=="﻿%~1" (set "_EV=%%B"& set "_EV_SET=1")
  if "%%M"=="" if "%%K"=="﻿export" if "%%L"=="%~1" (set "_EV=%%B"& set "_EV_SET=1")
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
