@echo off
:: Mirrors update.sh. The DB_PROVIDER -> compose file rules in
:: :provider_from_env and :compose_file_for (bottom of this file) mirror
:: scripts/compose-provider.sh, which install.sh and update.sh source.
:: Batch cannot source a shell script, so the logic is duplicated here and
:: in install.bat: change scripts/compose-provider.sh and both .bat files
:: together.
::
:: Run from the folder this script lives in, even when launched with
:: "Run as administrator" (which starts in C:\Windows\System32).
setlocal DisableDelayedExpansion
cd /d "%~dp0"
setlocal EnableDelayedExpansion

echo ╔══════════════════════════════════════╗
echo ║   BlackVault — Update Script         ║
echo ╚══════════════════════════════════════╝
echo.

:: ── Docker compose v1/v2 detection ────────────────────────────
set "COMPOSE="
docker compose version >nul 2>&1
if not errorlevel 1 set "COMPOSE=docker compose"
if not defined COMPOSE (
  docker-compose version >nul 2>&1
  if not errorlevel 1 set "COMPOSE=docker-compose"
)
if not defined COMPOSE (
  echo ERROR: Docker with Compose is required.
  pause
  exit /b 1
)

:: ── Migrate .blackvault.env to .env ──────────────────────────
if not exist ".env" if exist ".blackvault.env" (
  echo Migrating .blackvault.env to .env ^(one-time^)...
  copy /Y ".blackvault.env" ".env" >nul
  echo Done. .blackvault.env kept as backup.
  echo.
)

:: ── Check for .env at all ─────────────────────────────────────
if not exist ".env" (
  echo WARNING: No .env file found. BlackVault may not be configured.
  echo    If this is a fresh clone, run install.bat first.
  echo    Continuing with Docker defaults, DATA_DIR=./data ...
  echo.
)

:: ── Database provider and compose file ────────────────────────
:: Comes from .env only. A missing DB_PROVIDER line means SQLite, and a
:: stray vault.db never switches a PostgreSQL install to SQLite.
call :provider_from_env
call :compose_file_for
echo Database provider: !DB_PROVIDER! (using !COMPOSE_FILE!)

:: ── Read DATA_DIR from .env ────────────────────────────────────
set "ACTIVE_DATA_DIR="
set "ENV_PORT="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="DATA_DIR" set "ACTIVE_DATA_DIR=%%B"
    if "%%A"=="PORT" set "ENV_PORT=%%B"
  )
)
if defined ACTIVE_DATA_DIR set "ACTIVE_DATA_DIR=!ACTIVE_DATA_DIR:"=!"

:: ── Preflight: verify the database exists ─────────────────────
if not defined ACTIVE_DATA_DIR goto :preflight_done
if /i "!DB_PROVIDER!"=="sqlite" goto :preflight_sqlite

:: PostgreSQL keeps its cluster in DATA_DIR\postgres. DATA_DIR is never
:: relocated here: moving it would bring up a new, empty database.
call :is_dir "!ACTIVE_DATA_DIR!\postgres"
if defined IS_DIR (
  echo PostgreSQL data verified at: !ACTIVE_DATA_DIR!\postgres
) else (
  echo WARNING: No PostgreSQL data found at: !ACTIVE_DATA_DIR!\postgres
  echo    DATA_DIR in .env is left unchanged. If your data lives elsewhere,
  echo    fix DATA_DIR in .env and re-run update.bat.
)
goto :preflight_done

:preflight_sqlite
set "DB_PATH=!ACTIVE_DATA_DIR!\db\vault.db"
if exist "!DB_PATH!" (
  echo Database verified at: !DB_PATH!
  goto :preflight_done
)
echo WARNING: No database found at expected location:
echo    !DB_PATH!
echo.
:: Check legacy locations (SQLite installs only)
set "LEGACY_DATA_DIR="
if exist "data\db\vault.db" set "LEGACY_DATA_DIR=!CD!\data"
if not defined LEGACY_DATA_DIR if exist "!USERPROFILE!\.blackvault\db\vault.db" set "LEGACY_DATA_DIR=!USERPROFILE!\.blackvault"
if not defined LEGACY_DATA_DIR (
  echo    No existing database found in any known location.
  echo    This may be a fresh install - continuing.
  goto :preflight_done
)
echo    Data found at: !LEGACY_DATA_DIR!\db\vault.db
echo    Auto-updating DATA_DIR in .env:
echo      from: !ACTIVE_DATA_DIR!
echo      to:   !LEGACY_DATA_DIR!
copy /Y ".env" ".env.bak" >nul
if errorlevel 1 goto :env_update_failed
:: Rewrite only the DATA_DIR= line; every other line is kept as-is.
:: The new path is passed through the environment, never through quoting.
set "BV_NEW_DATA_DIR=!LEGACY_DATA_DIR!"
powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $p = Join-Path (Get-Location) '.env'; $l = [IO.File]::ReadAllLines($p) | ForEach-Object { if ($_ -match '^DATA_DIR=') { 'DATA_DIR=' + $env:BV_NEW_DATA_DIR } else { $_ } }; [IO.File]::WriteAllLines($p, [string[]]$l)"
if errorlevel 1 goto :env_update_failed
set "BV_NEW_DATA_DIR="
set "ACTIVE_DATA_DIR=!LEGACY_DATA_DIR!"
echo    .env updated, backup in .env.bak. Continuing update...
echo.

:preflight_done
echo.

:: ── Pull latest code ──────────────────────────────────────────
git rev-parse --git-dir >nul 2>&1
if errorlevel 1 goto :rebuild
echo Pulling latest updates from GitHub...
git pull
if errorlevel 1 (
  echo ERROR: git pull failed. See the output above.
  pause
  exit /b 1
)
echo.

:: ── Rebuild and restart ───────────────────────────────────────
:rebuild
echo Rebuilding BlackVault image...
%COMPOSE% -f "!COMPOSE_FILE!" build --pull
if errorlevel 1 goto :compose_failed

echo.
echo Restarting...
%COMPOSE% -f "!COMPOSE_FILE!" up -d
if errorlevel 1 goto :compose_failed

echo.
echo Waiting for health check...
timeout /t 5 /nobreak >nul

:: Pipes run each side in a new cmd without delayed expansion: use %VAR% here.
set "STATUS=started, check logs if the app doesn't load"
%COMPOSE% -f "%COMPOSE_FILE%" ps | findstr /i "healthy running" >nul
if not errorlevel 1 set "STATUS=running"

:: ── Summary ───────────────────────────────────────────────────
set "SUMMARY_PORT=3000"
if defined ENV_PORT set "SUMMARY_PORT=!ENV_PORT!"
echo.
echo ╔══════════════════════════════════════╗
echo ║   Update complete.                   ║
echo ╚══════════════════════════════════════╝
echo.
echo   Status:   !STATUS!
if defined ACTIVE_DATA_DIR echo   Data:     !ACTIVE_DATA_DIR!
echo   URL:      http://localhost:!SUMMARY_PORT!
echo.
echo   To check logs: %COMPOSE% -f %COMPOSE_FILE% logs -f
echo.
pause
exit /b 0

:env_update_failed
set "BV_NEW_DATA_DIR="
echo ERROR: could not update DATA_DIR in .env.
echo        Edit DATA_DIR in .env by hand, then re-run update.bat.
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

:: Sets IS_DIR=1 when %1 is an existing directory, else clears it.
:is_dir
set "IS_DIR="
set "_ATTR="
for %%I in ("%~1") do set "_ATTR=%%~aI"
if defined _ATTR if /i "!_ATTR:~0,1!"=="d" set "IS_DIR=1"
goto :eof
