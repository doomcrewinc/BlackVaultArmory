@echo off
:: Mirrors install.sh. The DB_PROVIDER -> compose file rules in
:: :provider_from_env and :compose_file_for (bottom of this file) mirror
:: scripts/compose-provider.sh, which install.sh and update.sh source.
:: Batch cannot source a shell script, so the logic is duplicated here and
:: in update.bat: change scripts/compose-provider.sh and both .bat files
:: together.
::
:: Run from the folder this script lives in, even when launched with
:: "Run as administrator" (which starts in C:\Windows\System32).
setlocal DisableDelayedExpansion
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo ╔══════════════════════════════════════════╗
echo ║      BlackVault — Setup Wizard           ║
echo ╚══════════════════════════════════════════╝
echo.

:: Start from a clean slate: never pick these up from the parent shell.
set "DATA_DIR="
set "PORT="
set "DB_PROVIDER="
set "COMPOSE_FILE="
set "POSTGRES_PASSWORD="
set "ENV_DATA_DIR="
set "ENV_PORT="
set "ENV_ACL_FAILED="

:: ── Prerequisites check ─────────────────────────────────────
where docker >nul 2>&1
if errorlevel 1 (
  echo ERROR: Docker is not installed or not in your PATH.
  echo        Install Docker Desktop from https://www.docker.com/products/docker-desktop/
  pause
  exit /b 1
)

set "COMPOSE="
docker compose version >nul 2>&1
if not errorlevel 1 set "COMPOSE=docker compose"
if not defined COMPOSE (
  docker-compose version >nul 2>&1
  if not errorlevel 1 set "COMPOSE=docker-compose"
)
if not defined COMPOSE (
  echo ERROR: 'docker compose' v2 or 'docker-compose' is required.
  echo        Upgrade Docker Desktop or install the Compose plugin.
  pause
  exit /b 1
)

:: ── Check for existing .env (already configured) ─────────────
:: Mirrors install.sh: start with the existing .env only when its data is
:: actually there. Otherwise fall through to the wizard.
if not exist ".env" goto :check_legacy_env
echo Existing .env found - BlackVault is already configured.
echo To reconfigure, delete .env and re-run this script.
echo.
call :read_env
call :provider_from_env
call :compose_file_for
if not defined ENV_DATA_DIR goto :check_legacy_env
set "EXISTING_OK="
if /i "!DB_PROVIDER!"=="sqlite" (
  if exist "!ENV_DATA_DIR!\db\vault.db" set "EXISTING_OK=1"
) else (
  call :is_dir "!ENV_DATA_DIR!\postgres"
  if defined IS_DIR set "EXISTING_OK=1"
)
if not defined EXISTING_OK goto :check_legacy_env
echo Your data is at: !ENV_DATA_DIR! (!DB_PROVIDER!)
echo Starting with existing configuration...
%COMPOSE% -f "!COMPOSE_FILE!" up -d
if errorlevel 1 goto :compose_failed
goto :summary_existing

:: ── Check for legacy .blackvault.env (migrate it) ────────────
:check_legacy_env
set "DB_PROVIDER="
set "COMPOSE_FILE="
if exist ".env" goto :detect_legacy_data
if not exist ".blackvault.env" goto :detect_legacy_data
echo Found legacy config file: .blackvault.env
echo Migrating to .env (Docker reads .env automatically)...
copy /Y ".blackvault.env" ".env" >nul
if errorlevel 1 (
  echo ERROR: could not copy .blackvault.env to .env.
  pause
  exit /b 1
)
echo Migrated. Original .blackvault.env kept as backup.
echo.
call :read_env
if not defined ENV_DATA_DIR goto :detect_legacy_data
if not exist "!ENV_DATA_DIR!\db\vault.db" goto :detect_legacy_data
:: Legacy configs predate PostgreSQL support: they are always SQLite.
set "DB_PROVIDER=sqlite"
call :compose_file_for
echo Found your existing database at: !ENV_DATA_DIR!
echo Rebuilding with existing configuration (SQLite)...
%COMPOSE% -f "!COMPOSE_FILE!" build
if errorlevel 1 goto :compose_failed
%COMPOSE% -f "!COMPOSE_FILE!" up -d
if errorlevel 1 goto :compose_failed
echo.
echo Update complete. Your data is unchanged.
goto :summary_existing

:: ── Detect data in legacy locations ──────────────────────────
:detect_legacy_data
set "LEGACY_DATA="
if exist "data\db\vault.db" set "LEGACY_DATA=!CD!\data"
if not defined LEGACY_DATA if exist "!USERPROFILE!\.blackvault\db\vault.db" set "LEGACY_DATA=!USERPROFILE!\.blackvault"
if not defined LEGACY_DATA goto :ask_data_dir
echo WARNING: Existing BlackVault data found at: !LEGACY_DATA!
echo    Would you like to keep using this location?
set "KEEP_INPUT="
set /p "KEEP_INPUT=   Keep existing data location? [Y/n]: "
if defined KEEP_INPUT set "KEEP_INPUT=!KEEP_INPUT:"=!"
if defined KEEP_INPUT set "KEEP_INPUT=!KEEP_INPUT: =!"
if not defined KEEP_INPUT set "KEEP_INPUT=Y"
if /i "!KEEP_INPUT:~0,1!"=="Y" (
  set "DATA_DIR=!LEGACY_DATA!"
  echo    Using existing data at: !DATA_DIR!
)

:: ── Data directory (if not already chosen) ───────────────────
:ask_data_dir
if defined DATA_DIR goto :ask_port
set "DEFAULT_DATA=!CD!\data"
echo Where should BlackVault store its data?
echo   This folder will contain your database and uploaded images.
echo   Default: !DEFAULT_DATA!
set "DATA_DIR_INPUT="
set /p "DATA_DIR_INPUT=  Data directory [press Enter for default]: "
if defined DATA_DIR_INPUT set "DATA_DIR_INPUT=!DATA_DIR_INPUT:"=!"
if defined DATA_DIR_INPUT (set "DATA_DIR=!DATA_DIR_INPUT!") else set "DATA_DIR=!DEFAULT_DATA!"
:: Strip one trailing slash, but never from a drive root such as C:\
if "!DATA_DIR:~-1!"=="\" if not "!DATA_DIR:~-2!"==":\" set "DATA_DIR=!DATA_DIR:~0,-1!"
if "!DATA_DIR:~-1!"=="/" set "DATA_DIR=!DATA_DIR:~0,-1!"

:: ── Port ─────────────────────────────────────────────────────
:ask_port
echo.
set "PORT_INPUT="
set /p "PORT_INPUT=Port to run BlackVault on [3000]: "
if defined PORT_INPUT set "PORT_INPUT=!PORT_INPUT:"=!"
if defined PORT_INPUT set "PORT_INPUT=!PORT_INPUT: =!"
if defined PORT_INPUT (set "PORT=!PORT_INPUT!") else set "PORT=3000"

:: ── Database ─────────────────────────────────────────────────
:: Existing SQLite data that the user chose to keep defaults to SQLite, so the
:: installer never silently starts an empty PostgreSQL database beside it.
set "DB_DEFAULT=1"
if exist "!DATA_DIR!\db\vault.db" set "DB_DEFAULT=2"
echo.
echo Which database should BlackVault use?
echo   1) PostgreSQL - recommended (runs as a second container)
echo   2) SQLite     - single file, single container
if "!DB_DEFAULT!"=="2" (
  echo   Existing SQLite data found, so SQLite is the default.
  echo   To move it to PostgreSQL later, see "Moving from SQLite to PostgreSQL" in README.md.
)

:ask_db
set "DB_INPUT="
set "DB_PROVIDER="
set /p "DB_INPUT=Database [!DB_DEFAULT!]: "
if defined DB_INPUT set "DB_INPUT=!DB_INPUT:"=!"
if defined DB_INPUT set "DB_INPUT=!DB_INPUT: =!"
if not defined DB_INPUT set "DB_INPUT=!DB_DEFAULT!"
for %%V in (1 p postgres postgresql) do if /i "!DB_INPUT!"=="%%V" set "DB_PROVIDER=postgres"
for %%V in (2 s sqlite) do if /i "!DB_INPUT!"=="%%V" set "DB_PROVIDER=sqlite"
if not defined DB_PROVIDER (
  echo   Please enter 1 ^(PostgreSQL^) or 2 ^(SQLite^).
  goto :ask_db
)
call :compose_file_for

set "POSTGRES_PASSWORD="
if not "!DB_PROVIDER!"=="postgres" goto :make_dirs
if exist "!DATA_DIR!\postgres\PG_VERSION" (
  echo.
  echo ERROR: PostgreSQL data already exists at !DATA_DIR!\postgres,
  echo        but there is no .env holding its password. A new password
  echo        would not match it. Restore your previous .env, or move
  echo        that folder aside to start fresh, then re-run this script.
  pause
  exit /b 1
)
:: 48 hex characters from the OS CSPRNG. PowerShell's built-in random cmdlet is NOT used:
:: it is not cryptographically secure. Never echoed to the terminal.
for /f "usebackq delims=" %%P in (`powershell -NoProfile -NonInteractive -Command "$b = New-Object byte[] 24; [Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })" 2^>nul`) do set "POSTGRES_PASSWORD=%%P"
if not defined POSTGRES_PASSWORD goto :password_failed
if "!POSTGRES_PASSWORD:~47,1!"=="" goto :password_failed
if not "!POSTGRES_PASSWORD:~48!"=="" goto :password_failed
for /f "delims=0123456789abcdef" %%X in ("!POSTGRES_PASSWORD!") do goto :password_failed

:: ── Create directories ────────────────────────────────────────
:make_dirs
echo.
echo Creating data directories...
if not exist "!DATA_DIR!\db" mkdir "!DATA_DIR!\db"
if not exist "!DATA_DIR!\uploads" mkdir "!DATA_DIR!\uploads"
if "!DB_PROVIDER!"=="postgres" if not exist "!DATA_DIR!\postgres" mkdir "!DATA_DIR!\postgres"
call :is_dir "!DATA_DIR!\db"
if not defined IS_DIR goto :mkdir_failed
call :is_dir "!DATA_DIR!\uploads"
if not defined IS_DIR goto :mkdir_failed
if not "!DB_PROVIDER!"=="postgres" goto :write_env
call :is_dir "!DATA_DIR!\postgres"
if not defined IS_DIR goto :mkdir_failed

:: ── Write .env ────────────────────────────────────────────────
:: .env holds the database password: restrict it to this user before and
:: after writing it.
:write_env
type nul > ".env"
call :restrict_env
(
  echo # BlackVault configuration - generated by install.bat
  echo DATA_DIR=!DATA_DIR!
  echo PORT=!PORT!
  echo DB_PROVIDER=!DB_PROVIDER!
  echo POSTGRES_PASSWORD=!POSTGRES_PASSWORD!
) > ".env"
call :restrict_env

echo Configuration written to .env
if "!DB_PROVIDER!"=="postgres" (
  echo A random PostgreSQL password was generated and saved in .env, not shown.
  echo Keep .env safe: your database cannot be opened without it.
)
if defined ENV_ACL_FAILED (
  echo WARNING: could not restrict .env to your user account with icacls.
  echo          Other accounts on this PC may be able to read it.
)

:: ── Build and start ───────────────────────────────────────────
echo.
echo Building BlackVault image (this may take a few minutes)...
%COMPOSE% -f "!COMPOSE_FILE!" build
if errorlevel 1 goto :compose_failed

echo.
echo Starting BlackVault...
%COMPOSE% -f "!COMPOSE_FILE!" up -d
if errorlevel 1 goto :compose_failed

echo.
echo Waiting for health check...
timeout /t 5 /nobreak >nul

:: Pipes run each side in a new cmd without delayed expansion: use %VAR% here.
%COMPOSE% -f "%COMPOSE_FILE%" ps | findstr /i "healthy running" >nul
if errorlevel 1 (
  echo Container started - check logs with:
  echo   %COMPOSE% -f %COMPOSE_FILE% logs -f
) else (
  echo BlackVault is running.
)

:: ── Summary ───────────────────────────────────────────────────
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║  BlackVault is ready^^!                                    ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo   URL:         http://localhost:!PORT!
echo   Data stored: !DATA_DIR!
echo   Database:    !DB_PROVIDER!
echo.
echo   To stop BlackVault:    %COMPOSE% -f %COMPOSE_FILE% down
echo   To update BlackVault:  update.bat
echo.
pause
exit /b 0

:summary_existing
set "SUMMARY_PORT=3000"
if defined ENV_PORT set "SUMMARY_PORT=!ENV_PORT!"
echo.
echo ╔══════════════════════════════════════╗
echo ║   BlackVault is running.             ║
echo ╚══════════════════════════════════════╝
echo.
echo   URL: http://localhost:!SUMMARY_PORT!
echo.
pause
exit /b 0

:password_failed
set "POSTGRES_PASSWORD="
echo ERROR: could not generate a database password.
echo        Windows PowerShell is required to generate it securely.
pause
exit /b 1

:mkdir_failed
echo ERROR: could not create the data directories under: !DATA_DIR!
pause
exit /b 1

:compose_failed
echo.
echo ERROR: docker compose failed. See the output above.
pause
exit /b 1

:: ════════════════════════════════════════════════════════════
:: Subroutines
:: ════════════════════════════════════════════════════════════

:: Mirrors provider_from_env in scripts/compose-provider.sh. Sets DB_PROVIDER
:: from the last DB_PROVIDER= line in .env, ignoring case, whitespace and
:: quotes. Installs made before PostgreSQL support have no DB_PROVIDER line
:: (or no .env at all) and were always SQLite.
:provider_from_env
set "_PV="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="DB_PROVIDER" set "_PV=%%B"
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

:: Mirrors compose_file_for in scripts/compose-provider.sh. Sets COMPOSE_FILE
:: for DB_PROVIDER. PostgreSQL is the default.
:compose_file_for
if /i "!DB_PROVIDER!"=="sqlite" (
  set "COMPOSE_FILE=docker-compose.sqlite.yml"
) else (
  set "COMPOSE_FILE=docker-compose.yml"
)
goto :eof

:: Sets ENV_DATA_DIR and ENV_PORT from .env (last matching line wins).
:read_env
set "ENV_DATA_DIR="
set "ENV_PORT="
if not exist ".env" goto :eof
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if "%%A"=="DATA_DIR" set "ENV_DATA_DIR=%%B"
  if "%%A"=="PORT" set "ENV_PORT=%%B"
)
if defined ENV_DATA_DIR set "ENV_DATA_DIR=!ENV_DATA_DIR:"=!"
goto :eof

:: Sets IS_DIR=1 when %1 is an existing directory, else clears it.
:is_dir
set "IS_DIR="
set "_ATTR="
for %%I in ("%~1") do set "_ATTR=%%~aI"
if defined _ATTR if /i "!_ATTR:~0,1!"=="d" set "IS_DIR=1"
goto :eof

:: Restricts .env to the current user: grant the user full control first,
:: and only then drop inherited permissions, so a failure never leaves the
:: file unreadable. Sets ENV_ACL_FAILED on failure.
:restrict_env
set "_SID="
for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh 2^>nul') do set "_SID=%%~S"
if not defined _SID (
  set "ENV_ACL_FAILED=1"
  goto :eof
)
icacls ".env" /grant:r "*!_SID!:F" >nul 2>&1
if errorlevel 1 (
  set "ENV_ACL_FAILED=1"
  goto :eof
)
icacls ".env" /inheritance:r >nul 2>&1
if errorlevel 1 set "ENV_ACL_FAILED=1"
goto :eof
