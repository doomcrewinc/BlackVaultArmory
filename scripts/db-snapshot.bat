@echo off
:: db-snapshot.bat - copy BlackVault's database into backups\ next to
:: docker-compose.yml, before an upgrade or a key rotation. Windows twin of
:: scripts/db-snapshot.sh (field-encryption spec section 3, "Update scripts"
:: and "Rotation"): change them together.
::
:: Called as `call scripts\db-snapshot.bat` by update.bat (before the new
:: image starts) and rotate-key.bat (after it has stopped the app).
::
:: Contract (ruling R4): no arguments; errorlevel 0 only when a snapshot was
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
:: Task 4 (encrypted files at rest): independent of DB_PROVIDER, this script
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
set "DATA_DIR="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="DATA_DIR" set "DATA_DIR=%%B"
  )
)
if defined DATA_DIR set "DATA_DIR=!DATA_DIR:"=!"
:: Trim surrounding spaces and tabs, as env_value in compose-provider.sh does.
if defined DATA_DIR for /f "tokens=* delims=	 " %%V in ("!DATA_DIR!") do set "DATA_DIR=%%V"
:trim_data_dir
if not defined DATA_DIR goto :trim_data_dir_done
if "!DATA_DIR:~-1!"==" " set "DATA_DIR=!DATA_DIR:~0,-1!" & goto :trim_data_dir
if "!DATA_DIR:~-1!"=="	" set "DATA_DIR=!DATA_DIR:~0,-1!" & goto :trim_data_dir
:trim_data_dir_done
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

:: :snapshot_uploads - mirrors the "Uploads snapshot (Task 4)" block in
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
