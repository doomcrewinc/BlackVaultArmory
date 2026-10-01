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
:: Fix round 1 (task-6-review.md, C1): scripts\rotate-encryption-key.mjs can
:: exit non-zero AFTER its transaction already committed. Treating every
:: non-zero rotation run as "nothing changed" could delete the only copy of
:: a key the database is already encrypted with. So a non-zero rotation run
:: is followed by a read-only --probe (OLD/NEW/NEITHER, by which key opens
:: the database's key check) before anything is deleted or restarted: NEW
:: completes the swap exactly as a normal success would, OLD discards the
:: unused new key and restarts on the old one, and anything else (NEITHER,
:: or the probe producing no answer at all) keeps every key file untouched,
:: does NOT start the app, and prints exact recovery commands.
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

:: I2: a timestamped name, never the bare "secrets\blackvault_encryption_key.old" —
:: the pre-rotation snapshot (step 3) is sealed under THIS run's old key, so a
:: second rotation must never silently overwrite the file that opens it.
set "OLD_TS="
for /f "usebackq delims=" %%T in (`powershell -NoProfile -NonInteractive -Command "[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')" 2^>nul`) do set "OLD_TS=%%T"
if not defined OLD_TS set "OLD_TS=rotate"
set "OLD_KEY_FILE=secrets\blackvault_encryption_key.old-!OLD_TS!"
if exist "!OLD_KEY_FILE!" set "OLD_KEY_FILE=!OLD_KEY_FILE!-%RANDOM%"

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

:: M3: an absolute bind source. A relative ".\secrets" depends on how the
:: Compose engine resolves `run -v` relative paths (version-dependent); %CD%
:: is absolute the moment the `cd /d` above has run.
set "SECRETS_DIR=%CD%\secrets"

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

:: M2: the restrictive ACL is applied to an EMPTY file BEFORE any key
:: material is written, not after — no window where the new key sits in a
:: file still carrying the default (inherited) ACL. A failed icacls aborts
:: the run instead of silently leaving an unhardened key file.
if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
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
%COMPOSE% run --rm -v "%SECRETS_DIR%:/run/rotate:ro" blackvault node scripts/rotate-encryption-key.mjs --old-key-file /run/rotate/blackvault_encryption_key --new-key-file /run/rotate/blackvault_encryption_key.new
if not errorlevel 1 goto :do_swap

:: The rotation command itself exited non-zero. That does NOT mean nothing
:: changed (fix round 1, C1): the transaction may already have committed and
:: only a step after it failed. Ask the database itself before touching
:: anything.
echo.
echo The rotation command exited with an error. Checking which key the database
echo is actually encrypted with before touching any file...
set "PROBE_ANSWER="
for /f "usebackq delims=" %%P in (`%COMPOSE% run --rm -v "%SECRETS_DIR%:/run/rotate:ro" blackvault node scripts/rotate-encryption-key.mjs --probe --old-key-file /run/rotate/blackvault_encryption_key --new-key-file /run/rotate/blackvault_encryption_key.new 2^>nul`) do set "PROBE_ANSWER=%%P"

if "!PROBE_ANSWER!"=="NEW" (
  echo Confirmed: the database is already encrypted with the NEW key.
  echo Completing the key-file swap...
  goto :do_swap
)
if "!PROBE_ANSWER!"=="OLD" (
  echo Confirmed: the database is still encrypted with the OLD key; the
  echo rotation did not take effect.
  if exist "%NEW_KEY_FILE%" del /f /q "%NEW_KEY_FILE%"
  echo Restarting BlackVault on the previous key; nothing was changed.
  %COMPOSE% start blackvault
  pause
  exit /b 1
)
goto :probe_ambiguous

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
echo          1. Make sure Docker/the database are reachable, then re-run:
echo             %COMPOSE% run --rm -v "%SECRETS_DIR%:/run/rotate:ro" blackvault ^
echo               node scripts/rotate-encryption-key.mjs --probe ^
echo               --old-key-file /run/rotate/blackvault_encryption_key ^
echo               --new-key-file /run/rotate/blackvault_encryption_key.new
echo          2. If it answers NEW:  move /y %NEW_KEY_FILE% %KEY_FILE%   then  %COMPOSE% start blackvault
echo          3. If it answers OLD:  del %NEW_KEY_FILE%                 then  %COMPOSE% start blackvault
pause
exit /b 1

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
echo        Recover by hand, then restart:
echo          move /y %NEW_KEY_FILE% %KEY_FILE%
echo          %COMPOSE% start blackvault
echo        Back up %KEY_FILE% once BlackVault is confirmed working.
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
:: first, and only then drop inherited permissions. Sets RESTRICT_OK=1 on
:: success; leaves it undefined on ANY failure (fix round 1, M2 — the caller
:: now aborts instead of silently continuing with an unhardened file).
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
