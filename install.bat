@echo off
:: Mirrors install.sh. :provider_from_env and :check_postgres_env (bottom of
:: this file) mirror scripts/compose-provider.sh, which install.sh and
:: update.sh source. Batch cannot source a shell script, so the logic is
:: duplicated here and in update.bat: change scripts/compose-provider.sh and
:: both .bat files together.
::
:: There is one compose file. Plain %COMPOSE% reads .env, where
:: COMPOSE_PROFILES=postgres turns PostgreSQL on and no profile means SQLite.
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
:: The BLACKVAULT_* keys are cleared too, so docker compose (a child of this
:: script) only ever gets them from .env.
set "BLACKVAULT_DATABASE_URL="
set "BLACKVAULT_DB_PROVIDER="
set "BLACKVAULT_POSTGRES_PASSWORD="
set "DATA_DIR="
set "PORT="
set "DB_PROVIDER="
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

:: Docker Compose v2.20+ (docker-compose.yml needs it). Stops before
:: anything is written when it is missing or older.
call :require_compose
if not defined COMPOSE goto :compose_too_old

:: ── Check for existing .env (already configured) ─────────────
:: Mirrors install.sh: start with the existing .env only when its data is
:: actually there. Otherwise fall through to the wizard.
if not exist ".env" goto :check_legacy_env
echo Existing .env found - BlackVault is already configured.
echo To reconfigure, delete .env and re-run this script.
echo.
call :read_env
call :provider_from_env
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
if /i not "!DB_PROVIDER!"=="sqlite" call :check_postgres_env
:: This image refuses to start without the field-encryption key; an
:: existing key is never touched.
call :ensure_encryption_key
if errorlevel 1 goto :key_failed
echo Starting with existing configuration...
%COMPOSE% up -d
if errorlevel 1 goto :compose_failed
goto :summary_existing

:: ── Check for legacy .blackvault.env (migrate it) ────────────
:check_legacy_env
set "DB_PROVIDER="
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
:: Legacy configs predate PostgreSQL support: they are always SQLite, and a
:: .env with no COMPOSE_PROFILES line runs SQLite on the one compose file.
set "DB_PROVIDER=sqlite"
echo Found your existing database at: !ENV_DATA_DIR!
call :ensure_encryption_key
if errorlevel 1 goto :key_failed
echo Rebuilding with existing configuration (SQLite)...
%COMPOSE% build
if errorlevel 1 goto :compose_failed
%COMPOSE% up -d
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

:: ── Public URL, trusted proxies, direct access ────────────────
:: Mirrors install.sh and scripts/public-url-prompts.sh: change them together.
:: The app validates the URL authoritatively at startup; this is a shape check
:: to catch typos before a build.
::
:: End of input: the .sh prompt aborts when `read` hits EOF. `set /p` cannot
:: tell EOF from an empty line (both leave the variable unset and set
:: errorlevel 1), so a plain retry loop would spin forever once stdin is
:: exhausted. Three blank answers in a row abort instead: the same outcome
:: for a closed stdin, and a clear exit for someone who keeps pressing Enter.
echo.
echo Public URL: the address people open BlackVault at, normally your reverse
echo proxy's HTTPS address, e.g. https://vault.example.com
set "URL_BLANKS=0"
:ask_public_url
set "PUBLIC_URL="
set /p "PUBLIC_URL=Public URL: "
if defined PUBLIC_URL set "PUBLIC_URL=!PUBLIC_URL: =!"
if defined PUBLIC_URL set "PUBLIC_URL=!PUBLIC_URL:	=!"
if defined PUBLIC_URL (set "URL_BLANKS=0") else set /a URL_BLANKS+=1
if !URL_BLANKS! GEQ 3 goto :public_url_missing
call :valid_public_url PUBLIC_URL
if not errorlevel 1 goto :ask_trusted_proxies
echo   The URL must start with http:// or https:// and have no path, e.g. https://vault.example.com
goto :ask_public_url

:ask_trusted_proxies
call :prompt_trusted_proxies
set "DIRECT_ACCESS_INITIAL="
if defined TRUSTED_PROXIES goto :public_settings_done
echo.
echo No trusted proxy set. With direct access off, every connection to
echo BlackVault would be reset until you configure one.
set "YN_Q=Allow direct access until your proxy is set up?"
call :prompt_yes_no y
if "!YN!"=="y" set "DIRECT_ACCESS_INITIAL=on"
:public_settings_done

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
:: after writing it. Mirrors install.sh:
::   PostgreSQL: COMPOSE_PROFILES=postgres turns on the db service in the
::   single docker-compose.yml. The password is hex, so it goes into the
::   URL as-is.
::   SQLite: no profile and no database keys, so the compose defaults apply.
:: The keys are BLACKVAULT_* so a DATABASE_URL set in the user's environment
:: can never override them (see docker-compose.yml).
:write_env
type nul > ".env"
call :restrict_env
if "!DB_PROVIDER!"=="postgres" goto :write_env_postgres
(
  echo # BlackVault configuration - generated by install.bat
  echo DATA_DIR=!DATA_DIR!
  echo PORT=!PORT!
  echo BLACKVAULT_DB_PROVIDER=sqlite
  echo BLACKVAULT_PUBLIC_URL=!PUBLIC_URL!
  echo BLACKVAULT_TRUSTED_PROXIES=!TRUSTED_PROXIES!
  echo BLACKVAULT_DIRECT_ACCESS_INITIAL=!DIRECT_ACCESS_INITIAL!
) > ".env"
goto :env_written
:write_env_postgres
(
  echo # BlackVault configuration - generated by install.bat
  echo DATA_DIR=!DATA_DIR!
  echo PORT=!PORT!
  echo COMPOSE_PROFILES=postgres
  echo BLACKVAULT_DB_PROVIDER=postgres
  echo BLACKVAULT_POSTGRES_PASSWORD=!POSTGRES_PASSWORD!
  echo BLACKVAULT_DATABASE_URL=postgresql://blackvault:!POSTGRES_PASSWORD!@db:5432/blackvault
  echo BLACKVAULT_PUBLIC_URL=!PUBLIC_URL!
  echo BLACKVAULT_TRUSTED_PROXIES=!TRUSTED_PROXIES!
  echo BLACKVAULT_DIRECT_ACCESS_INITIAL=!DIRECT_ACCESS_INITIAL!
) > ".env"
:env_written
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

:: ── Field-encryption key ───────────────────────────────────────
:: secrets\blackvault_encryption_key, restricted to this user; never
:: overwritten if it is already there. Mirrors install.sh.
echo.
call :ensure_encryption_key
if errorlevel 1 goto :key_failed

:: ── Build and start ───────────────────────────────────────────
echo.
echo Building BlackVault image (this may take a few minutes)...
%COMPOSE% build
if errorlevel 1 goto :compose_failed

echo.
echo Starting BlackVault...
%COMPOSE% up -d
if errorlevel 1 goto :compose_failed

echo.
echo Waiting for health check...
:: Polled for up to two minutes, as in install.sh. A first start runs the
:: migrations (and on PostgreSQL waits for the database) and the app logs the
:: first-time setup token while it starts, so once it is healthy
:: :show_setup_token below finds the token in the log.
:: Pipes run each side in a new cmd without delayed expansion: use %VAR% here.
set "_HW=0"
:health_wait
%COMPOSE% ps --format "{{.Status}}" blackvault 2>nul | findstr /i "healthy" >nul
if not errorlevel 1 goto :health_ok
set /a _HW+=1
if !_HW! GEQ 60 goto :health_timed_out
timeout /t 2 /nobreak >nul
goto :health_wait
:health_timed_out
echo Container started - check logs with:
echo   %COMPOSE% logs -f
goto :health_done
:health_ok
echo BlackVault is running.
:health_done

:: ── Summary ───────────────────────────────────────────────────
echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║  BlackVault is ready^^!                                    ║
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo   URL:         !PUBLIC_URL!
echo   Data stored: !DATA_DIR!
echo   Database:    !DB_PROVIDER!
if "!DIRECT_ACCESS_INITIAL!"=="on" echo   Direct:      http://^<this machine's IP^>:!PORT! (direct access on)
echo.
echo   To stop BlackVault:    %COMPOSE% down
echo   To update BlackVault:  update.bat
echo.
:: ── First-time setup token (only while no admin account exists) ──
call :show_setup_token PUBLIC_URL
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

:public_url_missing
echo.
echo No input received; BLACKVAULT_PUBLIC_URL is required. Aborting.
pause
exit /b 1

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

:compose_too_old
if defined _CV (
  echo ERROR: Docker Compose !_CV! is too old. BlackVault needs v2.20 or newer.
) else (
  echo ERROR: BlackVault needs Docker Compose v2.20 or newer, run as
  echo        'docker compose' ^(the Compose v2 plugin^).
  docker-compose version >nul 2>&1
  if not errorlevel 1 (
    echo        Only the old 'docker-compose' was found; it cannot read
    echo        BlackVault's docker-compose.yml.
  )
)
echo        Upgrade Docker Desktop: https://docs.docker.com/desktop/
echo        Nothing was changed.
pause
exit /b 1

:compose_failed
echo.
echo ERROR: docker compose failed. See the output above.
pause
exit /b 1

:key_failed
echo        BlackVault was not started.
pause
exit /b 1

:: ════════════════════════════════════════════════════════════
:: Subroutines
:: ════════════════════════════════════════════════════════════

:: Mirrors require_compose / compose_version_ok in scripts/compose-provider.sh
:: (install.sh and update.sh source it; batch cannot, so change all three
:: together). docker-compose.yml uses depends_on.required: false, which needs
:: Docker Compose v2.20 or newer: older v2 rejects the file and v1
:: (docker-compose) cannot parse it, so the v1 fallback is gone on purpose.
:: Sets COMPOSE=docker compose when `docker compose version --short` is at
:: least 2.20 (a leading v is allowed), else leaves COMPOSE undefined and
:: _CV holding the version found (empty when there is no Compose v2).
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

:: Mirrors provider_from_env in scripts/compose-provider.sh. Sets DB_PROVIDER
:: (a variable of this script only) from the last BLACKVAULT_DB_PROVIDER= line
:: in .env, ignoring case, whitespace and quotes. Installs made before
:: PostgreSQL support have no such line (or no .env at all) and were always
:: SQLite. A plain DB_PROVIDER line is ignored, as docker-compose.yml ignores it.
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

:: Mirrors check_postgres_env in scripts/compose-provider.sh. Warns when .env
:: says BLACKVAULT_DB_PROVIDER=postgres but lacks a key the single compose file needs to
:: run PostgreSQL. Only warns; never stops the script.
:check_postgres_env
set "_CP="
set "_PW="
set "_DU="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="COMPOSE_PROFILES" set "_CP=%%B"
    if "%%A"=="BLACKVAULT_POSTGRES_PASSWORD" set "_PW=%%B"
    if "%%A"=="BLACKVAULT_DATABASE_URL" set "_DU=%%B"
  )
)
if defined _CP set "_CP=!_CP: =!"
if defined _CP set "_CP=!_CP:"=!"
if defined _DU set "_DU=!_DU:"=!"
set "_MISSING="
if not defined _CP (
  set "_MISSING=!_MISSING! COMPOSE_PROFILES=postgres"
) else (
  if "!_CP:postgres=!"=="!_CP!" set "_MISSING=!_MISSING! COMPOSE_PROFILES=postgres"
)
if not defined _PW set "_MISSING=!_MISSING! BLACKVAULT_POSTGRES_PASSWORD"
set "_DU_OK="
if defined _DU if /i "!_DU:~0,11!"=="postgres://" set "_DU_OK=1"
if defined _DU if /i "!_DU:~0,13!"=="postgresql://" set "_DU_OK=1"
if not defined _DU_OK set "_MISSING=!_MISSING! BLACKVAULT_DATABASE_URL=postgresql://..."
set "_PW="
if not defined _MISSING goto :eof
echo WARNING: .env says BLACKVAULT_DB_PROVIDER=postgres but is missing:!_MISSING!
echo    A PostgreSQL install needs all four of these in .env:
echo      COMPOSE_PROFILES=postgres
echo      BLACKVAULT_DB_PROVIDER=postgres
echo      BLACKVAULT_POSTGRES_PASSWORD=^<48 hex characters^>
echo      BLACKVAULT_DATABASE_URL=postgresql://blackvault:^<same password^>@db:5432/blackvault
echo    See .env.example. If this is a SQLite install, set BLACKVAULT_DB_PROVIDER=sqlite instead.
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

:: :valid_public_url VAR - errorlevel 0 when the value of VAR is
:: http(s)://host[:port][/], else 1. Mirrors valid_public_url in
:: scripts/public-url-prompts.sh (^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$,
:: case-sensitive like the bash regex): change them together.
:: Takes a variable NAME, not a value: CALL re-expands its arguments, which
:: would mangle ^, %% and ! in whatever the user typed.
:valid_public_url
set "VPU=!%~1!"
if not defined VPU exit /b 1
:: A double quote would break the FOR /F below; the regex rejects it anyway.
set "VPU_NQ=!VPU:"=!"
if not "!VPU_NQ!"=="!VPU!" exit /b 1
set "VPU_REST="
if "!VPU:~0,8!"=="https://" set "VPU_REST=!VPU:~8!"
if "!VPU:~0,7!"=="http://" set "VPU_REST=!VPU:~7!"
if not defined VPU_REST exit /b 1
if "!VPU_REST:~-1!"=="/" set "VPU_REST=!VPU_REST:~0,-1!"
if not defined VPU_REST exit /b 1
if "!VPU_REST:~0,1!"==":" exit /b 1
:: Every allowed character is a delimiter, so any token left over is a
:: character the regex does not allow. eol is set to a delimiter so no line
:: is ever skipped as a comment (the default eol, ;, is not allowed).
for /f "eol=: delims=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-:" %%X in ("!VPU_REST!") do exit /b 1
:: No colon: host only, and the host is already known to be non-empty.
set "VPU_PORT=!VPU_REST:*:=!"
if "!VPU_PORT!"=="!VPU_REST!" exit /b 0
:: After the first colon: 1-5 digits and nothing else (a second colon fails).
if not defined VPU_PORT exit /b 1
if not "!VPU_PORT:~5!"=="" exit /b 1
for /f "delims=0123456789" %%X in ("!VPU_PORT!") do exit /b 1
exit /b 0

:: :prompt_yes_no DEFAULT - asks the question in YN_Q and sets YN to y or n.
:: Mirrors prompt_yes_no in scripts/public-url-prompts.sh: Enter (or end of
:: input, which set /p cannot tell apart from Enter) takes DEFAULT, so this
:: never loops at end of input.
:prompt_yes_no
set "YN_HINT=[y/N]"
if "%~1"=="y" set "YN_HINT=[Y/n]"
:prompt_yes_no_again
set "YN_INPUT="
set /p "YN_INPUT=!YN_Q! !YN_HINT!: "
if defined YN_INPUT set "YN_INPUT=!YN_INPUT:"=!"
if defined YN_INPUT set "YN_INPUT=!YN_INPUT: =!"
if not defined YN_INPUT set "YN_INPUT=%~1"
set "YN="
for %%V in (y yes) do if /i "!YN_INPUT!"=="%%V" set "YN=y"
for %%V in (n no) do if /i "!YN_INPUT!"=="%%V" set "YN=n"
if defined YN goto :eof
echo   Please answer y or n.
goto :prompt_yes_no_again

:: Mirrors prompt_trusted_proxies in scripts/public-url-prompts.sh. Sets
:: TRUSTED_PROXIES with spaces and tabs removed; undefined when left blank.
:prompt_trusted_proxies
echo.
echo Trusted proxies: IPs, CIDR ranges or host names your reverse proxy connects
echo from, comma-separated (e.g. 172.28.0.0/16). Leave blank if you have none yet.
set "TRUSTED_PROXIES="
set /p "TRUSTED_PROXIES=Trusted proxies []: "
if defined TRUSTED_PROXIES set "TRUSTED_PROXIES=!TRUSTED_PROXIES: =!"
if defined TRUSTED_PROXIES set "TRUSTED_PROXIES=!TRUSTED_PROXIES:	=!"
goto :eof

:: :show_setup_token VAR - prints the first-time setup token from the
:: container log in a boxed block, with the public URL held in VAR; prints
:: nothing when the log has no token line (an admin already exists). Mirrors
:: show_setup_token in scripts/setup-token.sh: change them together. The app
:: prints a new token at every start while no admin exists, so the LAST
:: matching line wins. Only the XXXX-XXXX-XXXX-XXXX code is taken from it; the
:: text around it is ASCII, because the log line's em dash garbles in the
:: console code page. Takes a variable NAME, like :valid_public_url.
:show_setup_token
set "_ST_URL=!%~1!"
set "_ST_LINE="
set "_ST_CODE="
for /f "usebackq delims=" %%L in (`%COMPOSE% logs blackvault 2^>nul ^| findstr /l /c:"[auth] Setup token:"`) do set "_ST_LINE=%%L"
if not defined _ST_LINE goto :eof
:: Everything after "Setup token", then the first word after ": ".
set "_ST_REST=!_ST_LINE:*Setup token=!"
for /f "tokens=1 delims=: " %%T in ("!_ST_REST!") do set "_ST_CODE=%%T"
if not defined _ST_CODE goto :eof
:: Exactly XXXX-XXXX-XXXX-XXXX: 19 characters, dashes at 5, 10 and 15, and
:: only capital letters and digits otherwise. eol is a character that cannot
:: be left after the dashes are removed, so no value is skipped as a comment.
if "!_ST_CODE:~18,1!"=="" goto :eof
if not "!_ST_CODE:~19!"=="" goto :eof
if not "!_ST_CODE:~4,1!!_ST_CODE:~9,1!!_ST_CODE:~14,1!"=="---" goto :eof
set "_ST_ALNUM=!_ST_CODE:-=!"
if "!_ST_ALNUM:~15,1!"=="" goto :eof
for /f "eol=- delims=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" %%X in ("!_ST_ALNUM!") do goto :eof
if defined _ST_URL if "!_ST_URL:~-1!"=="/" set "_ST_URL=!_ST_URL:~0,-1!"
echo   ============================================================
echo    First-time setup: open !_ST_URL!/setup
echo    and enter the setup token: !_ST_CODE!
echo   ============================================================
goto :eof

:: :ensure_encryption_key - mirrors ensure_encryption_key in
:: scripts/encryption-key.sh; install.bat and update.bat carry identical
:: copies (scripts/bat-shared-subroutines.test.ts): change all three together.
:: Creates secrets\blackvault_encryption_key (64 lowercase hex characters from
:: the OS CSPRNG; PowerShell's random cmdlet is NOT used, it is not
:: cryptographically secure) only when it does not exist: an existing key
:: is never touched, it may be the only key the database is encrypted with.
:: The ACL is restricted to the current user on the EMPTY file before any
:: key material is written (as rotate-key.bat does); a failed icacls aborts.
:: errorlevel 0 when the key file exists afterwards, 1 with a message when it
:: could not be created. Never echoes the key.
:ensure_encryption_key
set "_EK=secrets\blackvault_encryption_key"
if exist "!_EK!" (
  echo Encryption key: secrets\blackvault_encryption_key ^(existing, unchanged^)
  exit /b 0
)
if not exist "secrets\" mkdir "secrets" 2>nul
if not exist "secrets\" goto :ensure_key_failed
set "_KEY="
for /f "usebackq delims=" %%K in (`powershell -NoProfile -NonInteractive -Command "$b = New-Object byte[] 32; [Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') })" 2^>nul`) do set "_KEY=%%K"
if not defined _KEY goto :ensure_key_failed
if "!_KEY:~63,1!"=="" goto :ensure_key_failed
if not "!_KEY:~64!"=="" goto :ensure_key_failed
for /f "delims=0123456789abcdef" %%X in ("!_KEY!") do goto :ensure_key_failed
type nul > "!_EK!"
if errorlevel 1 goto :ensure_key_failed
set "_SID="
for /f "tokens=2 delims=," %%S in ('whoami /user /fo csv /nh 2^>nul') do set "_SID=%%~S"
if not defined _SID goto :ensure_key_acl_failed
icacls "!_EK!" /grant:r "*!_SID!:F" >nul 2>&1
if errorlevel 1 goto :ensure_key_acl_failed
icacls "!_EK!" /inheritance:r >nul 2>&1
if errorlevel 1 goto :ensure_key_acl_failed
(echo !_KEY!)>"!_EK!"
if errorlevel 1 goto :ensure_key_failed
set "_KEY="
echo.
echo ==========================================================================
echo   Encryption key created: !CD!\secrets\blackvault_encryption_key
echo.
echo   BACK THIS FILE UP. Without it your serial numbers and NFA records cannot be recovered.
echo.
echo   Keep a copy somewhere other than this machine ^(a password manager, a USB
echo   drive^). Anyone with this file AND your database can read those records.
echo ==========================================================================
echo.
exit /b 0
:ensure_key_acl_failed
echo ERROR: could not restrict the key file to your user account with icacls.
echo        Refusing to write key material to an unhardened file.
:ensure_key_failed
set "_KEY="
if exist "!_EK!" for %%F in ("!_EK!") do if %%~zF EQU 0 del /f /q "!_EK!"
echo ERROR: could not create the encryption key file secrets\blackvault_encryption_key.
exit /b 1
