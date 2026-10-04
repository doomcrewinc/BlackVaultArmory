@echo off
:: Mirrors update.sh. :provider_from_env and :check_postgres_env (bottom of
:: this file) mirror scripts/compose-provider.sh, which install.sh and
:: update.sh source. Batch cannot source a shell script, so the logic is
:: duplicated here and in install.bat: change scripts/compose-provider.sh and
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

echo ╔══════════════════════════════════════╗
echo ║   BlackVault — Update Script         ║
echo ╚══════════════════════════════════════╝
echo.

:: docker compose (a child of this script) must get the BLACKVAULT_* keys from
:: .env only, never from the parent shell.
set "BLACKVAULT_DATABASE_URL="
set "BLACKVAULT_DB_PROVIDER="
set "BLACKVAULT_POSTGRES_PASSWORD="

:: ── Docker Compose v2.20+ ─────────────────────────────────────
:: docker-compose.yml needs it. Stops before anything is touched (no .env
:: change, no git pull, no rebuild), so the running BlackVault keeps running.
call :require_compose
if not defined COMPOSE goto :compose_too_old

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

::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::::
:: The all-colon lines above are a landing pad. cmd.exe re-reads a running
:: batch file by byte offset. The update.bat shipped before PostgreSQL support
:: runs `git pull` inside an if ( ) block, so once the pull replaces this file
:: it resumes here at byte 2699 (LF checkout) or 2773 (CRLF checkout). Landing
:: mid-line in a line of colons is a silent label, not a stray command. Keep
:: both offsets inside the pad when editing anything above it.

:: ── Database provider ─────────────────────────────────────────
:: Comes from .env only. A missing BLACKVAULT_DB_PROVIDER line means SQLite,
:: and a stray vault.db never switches a PostgreSQL install to SQLite. It only
:: drives the preflight checks: plain %COMPOSE% reads .env itself.
call :provider_from_env
echo Database provider: !DB_PROVIDER!
if /i not "!DB_PROVIDER!"=="sqlite" call :check_postgres_env

:: ── Read DATA_DIR from .env ────────────────────────────────────
set "ACTIVE_DATA_DIR="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if "%%A"=="DATA_DIR" set "ACTIVE_DATA_DIR=%%B"
  )
)
if defined ACTIVE_DATA_DIR set "ACTIVE_DATA_DIR=!ACTIVE_DATA_DIR:"=!"

:: ── Preflight: verify the database exists ─────────────────────
:: The provider is read again here on purpose. cmd.exe re-reads a running
:: batch file by byte offset, so an older update.bat whose `git pull` just
:: replaced this file resumes partway through it (see the landing pad above),
:: without having run everything above. Keep this call here, before the
:: provider is used.
call :provider_from_env
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

:: Byte pad (these 2 lines)
call :clear_eol_only_change
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
:: The second of the two "byte pad" lines above is a real command (fix round 1,
:: I4: `call :clear_eol_only_change`, same length as the comment it replaced).
:: The two-line byte pad above `git pull` is for the e570bd8 update.bat
:: (what develop shipped before this release). It runs `git pull` as a
:: top-level line, so once the pull replaces this file cmd.exe resumes here
:: at the byte just past its own `git pull` line: 7123 (LF checkout) or 7269
:: (CRLF checkout). This file's `git pull` line must end at that same byte,
:: so the resume lands on `if errorlevel 1 (` above and flows on into the
:: prompts below. Keep the bytes between the landing pad and `git pull`
:: unchanged; scripts/update-bat-landing-pad.test.ts checks both offsets.

:: ── Rebuild and restart ───────────────────────────────────────
:rebuild
:: ── Public URL, trusted proxies, direct access ────────────────
:: Mirrors update.sh and scripts/public-url-prompts.sh: change them together.
:: Here, after the pull and before the rebuild, as in update.sh; the
:: not-a-git-checkout path jumps to :rebuild, so it lands here too.
:: BLACKVAULT_PUBLIC_URL is required from this release on: the container will
:: not start without it. With no .env there is no public URL, so rebuilding
:: and restarting would take a running BlackVault down. Stop here instead,
:: before anything is rebuilt, as update.sh does.
::
:: End of input: the .sh prompt aborts when `read` hits EOF. `set /p` cannot
:: tell EOF from an empty line (both leave the variable unset and set
:: errorlevel 1), so a plain retry loop would spin forever once stdin is
:: exhausted. Three blank answers in a row abort instead: the same outcome
:: for a closed stdin, and a clear exit for someone who keeps pressing Enter.
if not exist ".env" goto :no_env_file
call :read_env
if not defined ENV_PUBLIC_URL goto :upd_public_url_intro
echo.
echo Public URL is: !ENV_PUBLIC_URL!
set "YN_Q=Is this still current?"
call :prompt_yes_no y
if "!YN!"=="y" goto :upd_direct_access
:upd_public_url_intro
echo.
echo Public URL: the address people open BlackVault at, normally your reverse
echo proxy's HTTPS address, e.g. https://vault.example.com
set "URL_BLANKS=0"
:upd_ask_public_url
set "PUBLIC_URL="
set /p "PUBLIC_URL=Public URL: "
if defined PUBLIC_URL set "PUBLIC_URL=!PUBLIC_URL: =!"
if defined PUBLIC_URL set "PUBLIC_URL=!PUBLIC_URL:	=!"
if defined PUBLIC_URL (set "URL_BLANKS=0") else set /a URL_BLANKS+=1
if !URL_BLANKS! GEQ 3 goto :public_url_missing
call :valid_public_url PUBLIC_URL
if not errorlevel 1 goto :upd_public_url_write
echo   The URL must start with http:// or https:// and have no path, e.g. https://vault.example.com
goto :upd_ask_public_url

:upd_public_url_write
if "!PUBLIC_URL!"=="!ENV_PUBLIC_URL!" goto :upd_direct_access
call :set_env_value BLACKVAULT_PUBLIC_URL PUBLIC_URL
if errorlevel 1 goto :env_write_failed

:upd_direct_access
findstr /b /c:"BLACKVAULT_DIRECT_ACCESS_INITIAL=" ".env" >nul 2>&1
if not errorlevel 1 goto :upd_trusted_proxies
echo.
echo This release can refuse connections that bypass your reverse proxy.
set "YN_Q=Keep allowing direct access by IP (http://<ip>:<port>)?"
call :prompt_yes_no y
set "DA_VALUE=off"
if "!YN!"=="y" set "DA_VALUE=on"
call :set_env_value BLACKVAULT_DIRECT_ACCESS_INITIAL DA_VALUE
if errorlevel 1 goto :env_write_failed

:upd_trusted_proxies
findstr /b /c:"BLACKVAULT_TRUSTED_PROXIES=" ".env" >nul 2>&1
if not errorlevel 1 goto :public_settings_done
call :prompt_trusted_proxies
call :set_env_value BLACKVAULT_TRUSTED_PROXIES TRUSTED_PROXIES
if errorlevel 1 goto :env_write_failed
:public_settings_done
echo.

:: Checked again on purpose. cmd.exe re-reads a running batch file by byte
:: offset, so an older update.bat whose `git pull` just replaced this file
:: resumes partway through it, possibly past the check at the top and still
:: holding its own COMPOSE (which may be v1 docker-compose). Keep this call
:: here, right before the first compose command.
call :require_compose
if not defined COMPOSE goto :compose_too_old

:: ── Field-encryption key ───────────────────────────────────────
:: Created only if missing; an existing key is never touched. The new image
:: refuses to start without one. Like everything after `git pull`, this also
:: runs when an OLDER update.bat pulled this file and resumed into it (see the
:: landing pads above), so the first upgrade into field encryption gets the
:: key and the snapshot below too. update.sh re-executes itself instead.
echo.
call :ensure_encryption_key
if errorlevel 1 goto :key_failed

echo Rebuilding BlackVault image...
%COMPOSE% build --pull
if errorlevel 1 goto :compose_failed

:: ── Snapshot the database, BEFORE the new image starts ─────────
:: Mirrors update.sh. On SQLite scripts\db-snapshot.bat stops the app; if it
:: fails, the old container is started again and the update stops.
echo.
echo Snapshotting the database...
call scripts\db-snapshot.bat
if errorlevel 1 goto :snapshot_failed

:: Task 4: scripts\db-snapshot.bat also snapshotted the uploads folder
:: (unless it was empty or missing) and left its path in
:: backups\.uploads-snapshot-marker. Read it once, then remove it - never
:: write it to .env - and pass it to the ONE `up` below, so the app's own
:: startup step does not take a second snapshot of the same files.
:: Final review FIX 5: never let a value inherited from the caller reach `up`.
set "BLACKVAULT_UPLOADS_SNAPSHOT="
set "UPLOADS_SNAPSHOT_MARKER="
if exist "backups\.uploads-snapshot-marker" (
  for /f "usebackq delims=" %%M in ("backups\.uploads-snapshot-marker") do set "UPLOADS_SNAPSHOT_MARKER=%%M"
  del /f /q "backups\.uploads-snapshot-marker" >nul 2>&1
)

:: Set directly on this process (never on the caller: setlocal above), so it
:: reaches ONLY this `up -d`. Not unset afterwards on purpose: doing so right
:: after `up -d` with a plain `set` would reset the errorlevel the very next
:: line needs, and leaving it defined for the rest of this script (health
:: wait, logs) is harmless - nothing else here reads it.
if defined UPLOADS_SNAPSHOT_MARKER set "BLACKVAULT_UPLOADS_SNAPSHOT=!UPLOADS_SNAPSHOT_MARKER!"
echo.
echo Restarting...
%COMPOSE% up -d
if errorlevel 1 goto :compose_failed

echo.
echo Waiting for health check...
:: Polled for up to two minutes, as in update.sh: the app healthcheck runs
:: every 30s, so right after `up -d` the status is "health: starting". The
:: app logs the first-time setup token while it starts, so once it is
:: healthy :show_setup_token below finds the token in the log.
:: Only the status word "healthy" ends the wait: "unhealthy" and "starting"
:: keep polling, and the last status seen decides what is reported.
set "_HW=0"
:upd_health_wait
call :health_status
if "!HEALTH!"=="healthy" goto :upd_health_done
set /a _HW+=1
if !_HW! GEQ 60 goto :upd_health_done
timeout /t 2 /nobreak >nul
goto :upd_health_wait
:upd_health_done
set "STATUS=did not become healthy within two minutes, check the logs"
if "!HEALTH!"=="unhealthy" set "STATUS=UNHEALTHY - the container's health check is failing, check the logs"
if "!HEALTH!"=="healthy" set "STATUS=running"

:: ── Summary ───────────────────────────────────────────────────
call :read_env
echo.
echo ╔══════════════════════════════════════╗
if "!HEALTH!"=="healthy" echo ║   Update complete.                   ║
if not "!HEALTH!"=="healthy" echo ║   Update applied - app NOT healthy.  ║
echo ╚══════════════════════════════════════╝
echo.
echo   Status:   !STATUS!
if defined ACTIVE_DATA_DIR echo   Data:     !ACTIVE_DATA_DIR!
echo   URL:      !ENV_PUBLIC_URL!
echo.
echo   To check logs: %COMPOSE% logs -f
echo.
:: ── First-time setup token (only while no admin account exists) ──
call :show_setup_token ENV_PUBLIC_URL
pause
exit /b 0

:no_env_file
echo ERROR: No .env file, so no BLACKVAULT_PUBLIC_URL. BlackVault will not
echo        start without it. Run install.bat, or create .env with a line
echo        BLACKVAULT_PUBLIC_URL=https://vault.example.com and re-run update.bat.
echo        Nothing was rebuilt or restarted.
pause
exit /b 1

:public_url_missing
echo.
echo No input received; BLACKVAULT_PUBLIC_URL is required. Aborting.
pause
exit /b 1

:env_write_failed
echo ERROR: could not update .env. The previous .env is kept in .env.bak.
pause
exit /b 1

:env_update_failed
set "BV_NEW_DATA_DIR="
echo ERROR: could not update DATA_DIR in .env.
echo        Edit DATA_DIR in .env by hand, then re-run update.bat.
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
echo        BlackVault was not rebuilt or restarted; the running copy keeps running.
pause
exit /b 1

:compose_failed
echo.
echo ERROR: docker compose failed. See the output above.
pause
exit /b 1

:key_failed
echo        Nothing was rebuilt or restarted.
pause
exit /b 1

:snapshot_failed
echo.
echo ERROR: the database snapshot failed, so the update stopped here. See above.
echo        The new version was NOT started.
del /f /q "backups\.uploads-snapshot-marker" >nul 2>&1
%COMPOSE% start blackvault >nul 2>&1
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

:: Sets IS_DIR=1 when %1 is an existing directory, else clears it.
:is_dir
set "IS_DIR="
set "_ATTR="
for %%I in ("%~1") do set "_ATTR=%%~aI"
if defined _ATTR if /i "!_ATTR:~0,1!"=="d" set "IS_DIR=1"
goto :eof

:: :health_status - sets HEALTH to healthy or unhealthy from the Status column
:: of `docker compose ps` ("Up 2 minutes (healthy)", "(unhealthy)",
:: "(health: starting)"); HEALTH is left undefined for anything else (still
:: starting, not listed, no health reported). The parentheses are part of
:: the match, so "(unhealthy)" is never taken for "(healthy)". Mirrors
:: container_health in scripts/compose-provider.sh: change them together.
:health_status
set "HEALTH="
set "_HS="
for /f "usebackq delims=" %%S in (`%COMPOSE% ps --format "{{.Status}}" blackvault 2^>nul`) do set "_HS=%%S"
if not defined _HS goto :eof
if not "!_HS:(healthy)=!"=="!_HS!" set "HEALTH=healthy"
if not "!_HS:(unhealthy)=!"=="!_HS!" set "HEALTH=unhealthy"
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

:: Sets ENV_PUBLIC_URL from .env (last BLACKVAULT_PUBLIC_URL= line wins),
:: without spaces, tabs or quotes. Mirrors env_value in
:: scripts/compose-provider.sh closely enough for a URL, which holds none.
:read_env
set "ENV_PUBLIC_URL="
if not exist ".env" goto :eof
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if "%%A"=="BLACKVAULT_PUBLIC_URL" set "ENV_PUBLIC_URL=%%B"
)
if defined ENV_PUBLIC_URL set "ENV_PUBLIC_URL=!ENV_PUBLIC_URL: =!"
if defined ENV_PUBLIC_URL set "ENV_PUBLIC_URL=!ENV_PUBLIC_URL:	=!"
if defined ENV_PUBLIC_URL set "ENV_PUBLIC_URL=!ENV_PUBLIC_URL:"=!"
if defined ENV_PUBLIC_URL set "ENV_PUBLIC_URL=!ENV_PUBLIC_URL:'=!"
goto :eof

:: :set_env_value KEY VAR - replace or append KEY=<value of VAR> in .env and
:: keep the previous file as .env.bak. Mirrors set_env_value in
:: scripts/public-url-prompts.sh.
::   * Every other line is kept byte for byte, including its line ending
::     (the file is read and written as Latin-1, which round-trips any byte).
::     findstr /v was tried first and cannot do this: it copies a last line
::     that has no newline without adding one, so the appended KEY= line was
::     glued onto it (seen in the Windows CI job).
::   * A missing final newline is added before the new line, in the file's
::     own style (CRLF if it has any CRLF, else LF).
::   * The value is never interpreted: it is passed by variable NAME (CALL
::     would re-expand a value passed directly) and reaches PowerShell through
::     the environment, never through quoting.
::   * WriteAllText truncates the existing .env rather than replacing it, so
::     the ACL install.bat put on .env is kept.
:: errorlevel 1 when .env could not be backed up or rewritten.
:set_env_value
copy /y ".env" ".env.bak" >nul
if errorlevel 1 exit /b 1
set "BV_KEY=%~1"
set "BV_VALUE=!%~2!"
powershell -NoProfile -NonInteractive -Command "$ErrorActionPreference = 'Stop'; $e = [Text.Encoding]::GetEncoding(28591); $p = Join-Path (Get-Location) '.env'; $t = [IO.File]::ReadAllText($p, $e); $cr = [string][char]13; $lf = [string][char]10; $nl = $lf; if ($t.Length -eq 0 -or $t.Contains($cr + $lf)) { $nl = $cr + $lf }; $t = [regex]::Replace($t, '(?m)^' + [regex]::Escape($env:BV_KEY) + '=[^\n]*(\n|$)', ''); if ($t.Length -gt 0 -and -not $t.EndsWith($lf)) { $t += $nl }; [IO.File]::WriteAllText($p, $t + $env:BV_KEY + '=' + $env:BV_VALUE + $nl, $e)"
set "_SEV_FAILED="
if errorlevel 1 set "_SEV_FAILED=1"
set "BV_KEY="
set "BV_VALUE="
if defined _SEV_FAILED exit /b 1
exit /b 0

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
:: Final review N1: when the key is held in BLACKVAULT_ENCRYPTION_KEY (a
:: non-empty line in .env, or set in this console) no key file is created -
:: a second, different key would make the app refuse to start (KEY_CONFLICT).
:ensure_encryption_key
set "_EK=secrets\blackvault_encryption_key"
if exist "!_EK!" (
  echo Encryption key: secrets\blackvault_encryption_key ^(existing, unchanged^)
  exit /b 0
)
if defined BLACKVAULT_ENCRYPTION_KEY (
  echo Encryption key: BLACKVAULT_ENCRYPTION_KEY ^(from the console environment^) - no key file created
  if not exist "secrets\" mkdir "secrets" 2>nul
  exit /b 0
)
if not exist ".env" goto :ensure_key_no_env_key
findstr /r /c:"^BLACKVAULT_ENCRYPTION_KEY=." ".env" >nul 2>&1
if errorlevel 1 goto :ensure_key_no_env_key
echo Encryption key: BLACKVAULT_ENCRYPTION_KEY ^(from .env^) - no key file created
:: docker-compose.yml mounts secrets\ with create_host_path: false.
if not exist "secrets\" mkdir "secrets" 2>nul
exit /b 0
:ensure_key_no_env_key
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

:: :clear_eol_only_change - mirrors clear_bat_eol_only_changes in update.sh
:: (change them together). Runs right before `git pull` (fix rounds 1-2, I4).
:: Releases before this one stored install.bat and update.bat with CRLF in
:: the index while .gitattributes says `text eol=crlf`, so Git reports both
:: as modified on every checkout and a pull that changes them aborts with
:: "Your local changes ... would be overwritten". When the ONLY difference is
:: line endings (`git diff --ignore-cr-at-eol` finds none), Git is made to
:: re-check the two files byte for byte (a temporary `-text` in
:: .git\info\attributes, then `git update-index --refresh`), which records
:: them as unchanged: they ARE the committed bytes. No file is rewritten -
:: cmd.exe is reading this one. Real local edits are left alone.
::
:: The override must never outlive this run (left behind, every later
:: checkout writes the .bat files with LF). Each added line carries the
:: marker attribute `blackvault-update` (Git rejects a line with a trailing
:: `#` comment and ignores it whole); every copy/move is checked and a
:: failure restores; and every run first strips marked lines left by a run
:: that could not restore (Ctrl-C answered Y at "Terminate batch job").
:clear_eol_only_change
git rev-parse --git-dir >nul 2>&1
if errorlevel 1 goto :eof
set "_GA="
for /f "usebackq delims=" %%P in (`git rev-parse --git-path info/attributes`) do set "_GA=%%P"
if not defined _GA goto :eof
set "_GA=!_GA:/=\!"
call :heal_eol_override
git diff --quiet -- install.bat update.bat >nul 2>&1
if not errorlevel 1 goto :eof
git diff --ignore-cr-at-eol --quiet -- install.bat update.bat >nul 2>&1
if errorlevel 1 (
  echo Note: install.bat or update.bat has local edits; they are left alone.
  goto :eof
)
echo Clearing a line-ending-only difference in install.bat / update.bat before pulling...
for %%D in ("!_GA!") do if not exist "%%~dpD" mkdir "%%~dpD" 2>nul
set "_GA_BAK="
if not exist "!_GA!" goto :eol_override_add
copy /y "!_GA!" "!_GA!.blackvault-update" >nul 2>&1
if errorlevel 1 (
  echo WARNING: could not back up .git\info\attributes, so the line-ending fix is skipped.
  if exist "!_GA!.blackvault-update" del /f /q "!_GA!.blackvault-update" >nul 2>&1
  goto :eof
)
set "_GA_BAK=!_GA!.blackvault-update"
:: An existing file without a final newline: start our lines on a new one.
set "_GA_NL=0"
set "BV_GA_PATH=!_GA!"
for /f "usebackq delims=" %%L in (`powershell -NoProfile -NonInteractive -Command "$b = [IO.File]::ReadAllBytes($env:BV_GA_PATH); if ($b.Length -gt 0 -and $b[-1] -ne 10) { '1' } else { '0' }" 2^>nul`) do set "_GA_NL=%%L"
set "BV_GA_PATH="
if "!_GA_NL!"=="1" (
  (echo.)>>"!_GA!" || goto :eol_override_restore
)
:eol_override_add
(echo install.bat -text blackvault-update)>>"!_GA!" || goto :eol_override_restore
(echo update.bat -text blackvault-update)>>"!_GA!" || goto :eol_override_restore
:: The file must be older than the index Git writes next, or Git treats it
:: as "racily clean" and compares it again with the normal attributes.
ping -n 2 127.0.0.1 >nul
git update-index -q --refresh >nul 2>&1
:eol_override_restore
if defined _GA_BAK (
  move /y "!_GA_BAK!" "!_GA!" >nul 2>&1
  if errorlevel 1 echo WARNING: could not restore .git\info\attributes from its backup.
) else (
  if exist "!_GA!" del /f /q "!_GA!" >nul 2>&1
)
:: Whatever happened above, no marked line may survive.
call :heal_eol_override
goto :eof

:: :heal_eol_override - removes override lines (marked blackvault-update)
:: and backups that an interrupted run left behind. Needs _GA.
:heal_eol_override
if exist "!_GA!.blackvault-update" del /f /q "!_GA!.blackvault-update" >nul 2>&1
if not exist "!_GA!" goto :eof
findstr /l /c:" blackvault-update" "!_GA!" >nul 2>&1
if errorlevel 1 goto :eof
echo Removing a line-ending override left in .git\info\attributes by an interrupted update...
findstr /v /l /c:" blackvault-update" "!_GA!" > "!_GA!.blackvault-heal" 2>nul
for %%F in ("!_GA!.blackvault-heal") do if %%~zF EQU 0 (
  del /f /q "!_GA!.blackvault-heal" >nul 2>&1
  del /f /q "!_GA!" >nul 2>&1
  goto :eof
)
move /y "!_GA!.blackvault-heal" "!_GA!" >nul 2>&1
if errorlevel 1 echo WARNING: could not clean .git\info\attributes; delete its lines ending in blackvault-update by hand.
goto :eof
