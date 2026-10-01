@echo off
:: rotate-key.bat — rotate BlackVault's field-encryption key. Mirrors
:: rotate-key.sh. :require_compose and :restrict_file (bottom of this file)
:: mirror scripts/compose-provider.sh and install.bat's :restrict_env; batch
:: cannot source a shell script, so this logic is duplicated here and must be
:: changed together with scripts/compose-provider.sh and install.bat/update.bat.
::
:: Stops the app, snapshots the database, generates a new key, runs the
:: rotation inside the container in one transaction, and only then swaps the
:: key files and restarts. Any failure along the way restarts BlackVault on
:: the OLD key and leaves the key files exactly as they were.
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
set "OLD_KEY_FILE=secrets\blackvault_encryption_key.old"

:: ── 1. Check the current key exists ───────────────────────────
if not exist "%KEY_FILE%" (
  echo ERROR: %KEY_FILE% not found. Nothing to rotate.
  echo        Run install.bat first, or restore your key file from backup.
  pause
  exit /b 1
)

:: ── Docker Compose v2.20+ ─────────────────────────────────────
:: Exits before anything is touched when it is missing or older, so the
:: running BlackVault keeps running.
call :require_compose
if not defined COMPOSE goto :compose_too_old

:: ── 2. Stop the app ────────────────────────────────────────────
echo Stopping BlackVault...
%COMPOSE% stop blackvault
if errorlevel 1 goto :stop_failed

:: ── 3. Snapshot the database (same script the update scripts use) ──
:: Ruling R4: called unconditionally; if it is missing or fails, stop here -
:: never rotate without a snapshot. Task 7 creates scripts\db-snapshot.bat;
:: until then this step always fails loudly, by design.
echo.
echo Snapshotting database...
if not exist "scripts\db-snapshot.bat" goto :no_snapshot_script
call scripts\db-snapshot.bat
if errorlevel 1 goto :snapshot_failed

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

if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
(echo !NEW_KEY!)>"%NEW_KEY_FILE%"
if errorlevel 1 goto :key_gen_failed
call :restrict_file "%NEW_KEY_FILE%"
set "NEW_KEY="

:: ── 5. Run the rotation inside the container, in one transaction ──
echo.
echo Rotating encryption key (this may take a while on a large inventory)...
%COMPOSE% run --rm -v "./secrets:/run/rotate:ro" blackvault node scripts/rotate-encryption-key.mjs --old-key-file /run/rotate/blackvault_encryption_key --new-key-file /run/rotate/blackvault_encryption_key.new
if errorlevel 1 goto :rotation_failed

:: ── 6. Success: swap the key files and restart ──────────────
move /y "%KEY_FILE%" "%OLD_KEY_FILE%" >nul
if errorlevel 1 goto :swap_failed
move /y "%NEW_KEY_FILE%" "%KEY_FILE%" >nul
if errorlevel 1 goto :swap_failed
%COMPOSE% start blackvault
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   Key rotation complete.                                   ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo Back up the new key file now. Delete %OLD_KEY_FILE% once you have
echo confirmed everything works.
pause
exit /b 0

:: ════════════════════════════════════════════════════════════
:: Failure paths — every one restarts BlackVault on the previous key
:: (except where the app was never successfully stopped) and changes nothing.
:: ════════════════════════════════════════════════════════════

:no_snapshot_script
echo ERROR: scripts\db-snapshot.bat is missing. Refusing to rotate the encryption
echo        key without a database snapshot taken first.
echo Restarting BlackVault; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:snapshot_failed
echo ERROR: database snapshot failed. See the output above.
echo Restarting BlackVault; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:key_gen_failed
echo ERROR: could not generate a new encryption key.
if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
echo Restarting BlackVault; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:rotation_failed
echo.
echo ERROR: key rotation failed. See the output above.
if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
echo Restarting BlackVault on the previous key; nothing was changed.
%COMPOSE% start blackvault
pause
exit /b 1

:swap_failed
echo.
echo ERROR: could not replace the key file after a successful rotation.
echo        The database is now encrypted with the NEW key, but %KEY_FILE%
echo        may still hold the OLD one. Check %NEW_KEY_FILE% and %KEY_FILE%
echo        by hand before starting BlackVault again.
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

:: :restrict_file PATH - restricts PATH to the current user, the same way
:: install.bat's :restrict_env restricts .env: grant the user full control
:: first, and only then drop inherited permissions, so a failure never leaves
:: the file unreadable. Never fails the script; a key file that could not be
:: restricted is still usable, just not hardened.
:restrict_file
set "_SID="
for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh 2^>nul') do set "_SID=%%~S"
if not defined _SID goto :eof
icacls "%~1" /grant:r "*!_SID!:F" >nul 2>&1
icacls "%~1" /inheritance:r >nul 2>&1
goto :eof
