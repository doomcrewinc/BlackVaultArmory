@echo off
:: backup.bat - make, or verify, a full BlackVault backup from the host.
:: Windows twin of backup.sh (full-backups spec, section 2): change them
:: together. :require_compose (bottom) is the same subroutine as in
:: install.bat / update.bat / rotate-key.bat.
::
::   backup.bat [--passphrase-file <path>] [--keep <n>]      make a backup
::   backup.bat --verify <file> [--passphrase-file <path>]   check one
::
:: A full backup is ONE passphrase-sealed file, blackvault-full-<time>.bvb,
:: holding the database records and every uploaded photo and document. The
:: app writes it, inside its container, into the backup folder:
:: BLACKVAULT_BACKUP_DIR in .env, by default <DATA_DIR>\backups (.\data\backups).
:: Copy the files somewhere else; this script does not.
::
:: THE PASSPHRASE NEVER TOUCHES cmd.exe. A `set VAR=` variable is part of
:: cmd's environment, and every program cmd starts (docker included) inherits
:: a copy of it. So this script never holds the passphrase in a variable, and
:: never puts it on a command line. One PowerShell process (step 6)
::   - reads the --passphrase-file bytes, or asks for the passphrase with
::     Read-Host -AsSecureString (no echo; twice when making a backup, once
::     for --verify),
::   - starts docker itself, with docker's standard input a pipe,
::   - writes the passphrase bytes into that pipe and closes it,
::   - exits with docker's exit code.
:: The passphrase exists only in that PowerShell process's memory and in the
:: pipe. The variables this script does set for it (BV_PASSFILE = the PATH of
:: the file, BV_DOCKER_ARGS, BV_MODE, BV_LIMIT) hold no secret.
:: A passphrase file is passed on byte for byte: the backup program drops ONE
:: leading UTF-8 byte order mark and ONE trailing line ending (LF or CRLF),
:: and refuses a file that is not UTF-8 text (UTF-16, which is what output
:: redirection writes in Windows PowerShell 5.1).
:: With no --passphrase-file and no console (Task Scheduler), this script
:: stops at once with an error instead of waiting on a prompt.
::
:: --keep <n> (default 7): after the new backup has been written AND
:: verified, the oldest backups beyond the newest <n> are deleted, inside the
:: container, in the same run. If the backup fails, nothing is deleted.
:: --verify <file>: a file name in the backup folder, or a path to a file in
:: that folder. Decrypts and checks the whole archive; writes nothing.
::
:: HOW IT RUNS
::   app running   docker compose exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs ...
::   app stopped   docker compose run --rm -T blackvault node dist/scripts/full-backup.mjs ...
:: The first form names the group too (1001:1001): with -u 1001 alone Docker
:: takes the group from the image's /etc/passwd (nogroup, 65533), and the
:: backup file came out 1001:65533 instead of the app's own 1001:1001.
:: The one-off container has no --user and no --no-deps on purpose (same as
:: rotate-key.bat): the image's entrypoint must start as root to copy the
:: encryption key into /run/secrets before it drops to the app user, and on
:: PostgreSQL Compose must start the database and wait for it.
::
:: TIME LIMIT: none by default. Set BLACKVAULT_BACKUP_TIMEOUT=<seconds> to
:: stop waiting after that long.
::
:: It never pauses (it is meant for Task Scheduler too).
:: Errors are one line on standard error.
:: EXIT CODE: 0 ok, 1 failed, 2 another backup is already running.

:: Arguments are read BEFORE changing folder: a relative --passphrase-file
:: or --verify path is relative to where the user ran this from.
:: `shift /1`, never a bare `shift`: a bare shift also replaces argument 0,
:: the path of this script, and the `cd /d` below would then go to the folder
:: of the last argument (the passphrase file) instead of this script's.
setlocal DisableDelayedExpansion
set "BV_PASSFILE="
set "BV_KEEP="
set "BV_MODE=backup"
set "BV_VERIFY_NAME="
set "BV_VERIFY_DIR="
set "BV_VERIFY_IS_PATH="
set "BV_VERIFY_SHOWN="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--passphrase-file" goto :arg_passfile
if /i "%~1"=="--keep" goto :arg_keep
if /i "%~1"=="--verify" goto :arg_verify
:: Never echoed back: it could be a passphrase typed here by mistake.
>&2 echo ERROR: unknown argument. Usage: backup.bat [--passphrase-file path] [--keep n]  or  backup.bat --verify file [--passphrase-file path]
exit /b 1

:arg_passfile
if "%~2"=="" goto :arg_missing
set "BV_PASSFILE=%~f2"
shift /1
shift /1
goto :parse_args

:arg_keep
if "%~2"=="" goto :arg_missing
set "BV_KEEP=%~2"
shift /1
shift /1
goto :parse_args

:arg_verify
if "%~2"=="" goto :arg_missing
set "BV_MODE=verify"
set "BV_VERIFY_SHOWN=%~2"
set "BV_VERIFY_NAME=%~nx2"
set "BV_VERIFY_DIR=%~dp2"
if not "%~2"=="%~nx2" set "BV_VERIFY_IS_PATH=1"
shift /1
shift /1
goto :parse_args

:arg_missing
>&2 echo ERROR: %~1 needs a value. Usage: backup.bat [--passphrase-file path] [--keep n]  or  backup.bat --verify file [--passphrase-file path]
exit /b 1

:args_done
:: Run from the folder this script lives in (.env and docker-compose.yml).
cd /d "%~dp0"
setlocal EnableDelayedExpansion

:: -- 1. --keep ---------------------------------------------------
if "!BV_MODE!"=="verify" goto :check_keep_verify
:: for /f drops a value whose first character AFTER its leading delimiters
:: is the eol character, ";" by default: ";3" and "1;2" alike would pass the
:: character checks below unexamined. So a ";" ANYWHERE in the value is
:: refused first, here and at the two other checks.
if not defined BV_KEEP set "BV_KEEP=7"
if not "!BV_KEEP:;=!"=="!BV_KEEP!" goto :bad_keep
for /f "delims=0123456789" %%X in ("!BV_KEEP!") do goto :bad_keep
if not "!BV_KEEP:~6!"=="" goto :bad_keep
:keep_strip
if not "!BV_KEEP:~0,1!"=="0" goto :keep_stripped
if "!BV_KEEP:~1!"=="" goto :keep_stripped
set "BV_KEEP=!BV_KEEP:~1!"
goto :keep_strip
:keep_stripped
if "!BV_KEEP!"=="0" goto :bad_keep
if !BV_KEEP! GTR 100000 goto :bad_keep
set "BV_ENGINE_ARGS=--keep !BV_KEEP!"
goto :keep_done
:check_keep_verify
if not defined BV_KEEP goto :keep_done
>&2 echo ERROR: --keep cannot be used with --verify.
exit /b 1
:bad_keep
>&2 echo ERROR: --keep needs a whole number from 1 to 100000.
exit /b 1
:keep_done

:: -- 2. The passphrase source -------------------------------------
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
:: Review Focus 5 (Task Scheduler): nothing to prompt on. Stop now, before
:: anything else runs; never wait.
powershell -NoProfile -NonInteractive -Command "if ([Console]::IsInputRedirected) { exit 1 } else { exit 0 }" >nul 2>&1
if not errorlevel 1 goto :passphrase_source_ok
>&2 echo ERROR: no passphrase: standard input is not a console, so there is nobody to ask. Use --passphrase-file path. Nothing was done.
exit /b 1
:passphrase_source_ok

:: -- 3. The install ------------------------------------------------
call :require_compose
if defined COMPOSE goto :compose_ok
if not defined _CV set "_CV=none"
>&2 echo ERROR: BlackVault needs Docker Compose v2.20 or newer, run as 'docker compose' (found: !_CV!). Nothing was done.
exit /b 1
:compose_ok

:: docker compose must read the BLACKVAULT_* keys from .env only, never from
:: this console, and the one-off container must not inherit an
:: uploads-snapshot marker (see rotate-key.bat).
set "BLACKVAULT_DATABASE_URL="
set "BLACKVAULT_DB_PROVIDER="
set "BLACKVAULT_POSTGRES_PASSWORD="
set "BLACKVAULT_UPLOADS_SNAPSHOT="
set "BV_LIMIT="
if defined BLACKVAULT_BACKUP_TIMEOUT set "BV_LIMIT=!BLACKVAULT_BACKUP_TIMEOUT!"
set "BLACKVAULT_BACKUP_DIR="
if not defined BV_LIMIT goto :limit_ok
if not "!BV_LIMIT:;=!"=="!BV_LIMIT!" goto :bad_limit
for /f "delims=0123456789" %%X in ("!BV_LIMIT!") do goto :bad_limit
if "!BV_LIMIT:~8!"=="" goto :limit_ok
:bad_limit
>&2 echo ERROR: BLACKVAULT_BACKUP_TIMEOUT must be a number of seconds.
exit /b 1
:limit_ok

:: -- 4. --verify file: a name in the backup folder, or a path into it --
if not "!BV_MODE!"=="verify" goto :verify_mapped
:: The backup folder on the HOST: the same expression docker-compose.yml
:: mounts at /app/backups. A relative path is relative to this folder.
call :env_value BLACKVAULT_BACKUP_DIR
set "BV_HOST_DIR=!_EV!"
if defined BV_HOST_DIR goto :host_dir_known
call :env_value DATA_DIR
if not defined _EV set "_EV=.\data"
set "BV_HOST_DIR=!_EV!\backups"
:host_dir_known
if not defined BV_VERIFY_IS_PATH goto :verify_name_check
set "BV_HOST_FULL="
for %%D in ("!BV_HOST_DIR!") do set "BV_HOST_FULL=%%~fD"
if not defined BV_HOST_FULL goto :verify_outside
if not "!BV_HOST_FULL:~-1!"=="\" set "BV_HOST_FULL=!BV_HOST_FULL!\"
if /i not "!BV_VERIFY_DIR!"=="!BV_HOST_FULL!" goto :verify_outside
:verify_name_check
if not defined BV_VERIFY_NAME goto :verify_bad_name
if "!BV_VERIFY_NAME:~0,1!"=="-" goto :verify_bad_name
if not "!BV_VERIFY_NAME:;=!"=="!BV_VERIFY_NAME!" goto :verify_bad_name
for /f "delims=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-" %%X in ("!BV_VERIFY_NAME!") do goto :verify_bad_name
set "BV_ENGINE_ARGS=--verify !BV_VERIFY_NAME!"
goto :verify_mapped
:verify_outside
>&2 echo ERROR: --verify: !BV_VERIFY_SHOWN! is not in the backup folder (!BV_HOST_DIR!). Give a file name, or the path of a file in that folder.
exit /b 1
:verify_bad_name
>&2 echo ERROR: --verify: that is not a backup file name. Give a file name, or the path of a file in the backup folder (!BV_HOST_DIR!).
exit /b 1
:verify_mapped

:: -- 5. Running or stopped -----------------------------------------
:: See HOW IT RUNS at the top for why the one-off container has no --user
:: and no --no-deps.
set "BV_RUNNING="
for /f "usebackq delims=" %%I in (`%COMPOSE% ps --status running -q blackvault 2^>nul`) do set "BV_RUNNING=1"
set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/full-backup.mjs !BV_ENGINE_ARGS!"
if defined BV_RUNNING set "BV_DOCKER_ARGS=compose exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs !BV_ENGINE_ARGS!"

:: -- 6. Run it, the passphrase on docker's standard input ----------
:: One PowerShell process does all of it; see THE PASSPHRASE NEVER TOUCHES
:: cmd.exe at the top. The line is shared with restore.bat, character for
:: character: restore.bat also sets BV_DOCKER_ARGS_2 and BV_BETWEEN to make a
:: second docker call with the same passphrase (ruling R27). They are
:: cleared here, so this script makes exactly one call. Details that matter:
::   * docker is looked up with Get-Command, which walks PATH in order, as
::     cmd.exe does for every other docker call in this script. Handing the
::     bare name to Process.Start would use CreateProcess's search order
::     instead - the Windows system folders BEFORE PATH - and could start a
::     different docker.exe from the one the version check above talked to.
::   * -cne, not -ne: PowerShell's -ne ignores case.
::   * no byte-order mark. Process.Start wraps the pipe in a StreamWriter
::     made with [Console]::InputEncoding and turns AutoFlush on, which
::     writes that encoding's preamble AT ONCE: with console code page 65001
::     (UTF-8) three bytes would reach docker before the passphrase, and it
::     would no longer match. So when the console's input encoding has a
::     preamble, it is replaced first by UTF-8 without one (same code page:
::     nothing changes for the console). The passphrase bytes themselves are
::     written to the pipe's BaseStream, never through the StreamWriter.
::   * no -NonInteractive: Read-Host refuses to prompt under it.
::   * no double quote, exclamation mark, percent sign or caret inside the
::     command: cmd would interpret them.
set "BV_DOCKER_ARGS_2="
set "BV_BETWEEN="
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { if ($env:BV_PASSFILE) { $bytes = [IO.File]::ReadAllBytes($env:BV_PASSFILE) } else { if ([Console]::IsInputRedirected) { [Console]::Error.WriteLine('ERROR: no passphrase: standard input is not a console, so there is nobody to ask. Use --passphrase-file <path>. Nothing was done.'); exit 1 }; $m = [Runtime.InteropServices.Marshal]; $p1 = $m::PtrToStringUni($m::SecureStringToGlobalAllocUnicode((Read-Host 'Backup passphrase' -AsSecureString))); if ($p1.Length -eq 0) { [Console]::Error.WriteLine('ERROR: the passphrase is empty. Nothing was done.'); exit 1 }; if ($env:BV_MODE -ne 'verify') { $p2 = $m::PtrToStringUni($m::SecureStringToGlobalAllocUnicode((Read-Host 'Repeat the passphrase' -AsSecureString))); if ($p1 -cne $p2) { [Console]::Error.WriteLine('ERROR: the two passphrases do not match. Nothing was done.'); exit 1 } }; $bytes = [Text.Encoding]::UTF8.GetBytes($p1) }; $docker = @(Get-Command docker -CommandType Application)[0].Path; $calls = @($env:BV_DOCKER_ARGS); if ($env:BV_DOCKER_ARGS_2) { $calls += $env:BV_DOCKER_ARGS_2 }; $limit = 0; if ($env:BV_LIMIT) { $limit = [int]$env:BV_LIMIT }; if ([Console]::InputEncoding.GetPreamble().Length -gt 0) { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false }; for ($i = 0; $i -lt $calls.Count; $i++) { if ($i -eq 1) { $between = New-Object Diagnostics.ProcessStartInfo; $between.FileName = $env:ComSpec; $q = [string][char]34; $between.Arguments = '/d /s /c ' + $q + $q + $env:BV_BETWEEN + $q + $q; $between.UseShellExecute = $false; $b = [Diagnostics.Process]::Start($between); $b.WaitForExit(); if ($b.ExitCode -ne 0) { exit 1 } }; $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $docker; $psi.Arguments = $calls[$i]; $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $toErr = ($calls.Count -gt 1) -and ($i -eq 0); if ($toErr) { $psi.RedirectStandardOutput = $true }; $p = [Diagnostics.Process]::Start($psi); $pipe = $p.StandardInput.BaseStream; $pipe.Write($bytes, 0, $bytes.Length); $pipe.Flush(); $pipe.Close(); if ($toErr) { $err = [Console]::OpenStandardError(); $p.StandardOutput.BaseStream.CopyTo($err); $err.Flush() }; if ($limit -gt 0) { if (-not $p.WaitForExit($limit * 1000)) { try { $p.Kill() } catch { }; [Console]::Error.WriteLine('ERROR: the backup did not finish within ' + $limit + ' seconds (BLACKVAULT_BACKUP_TIMEOUT). It may still be running inside the container.'); exit 1 } } else { $p.WaitForExit() }; if ($p.ExitCode -ne 0) { exit $p.ExitCode } }; exit 0 } catch { [Console]::Error.WriteLine('ERROR: could not run docker: ' + $_.Exception.Message); exit 1 }"
set "BV_RC=!errorlevel!"
if "!BV_RC!"=="0" exit /b 0
:: For 1 and 2 the backup program (or the PowerShell step) printed why.
if "!BV_RC!"=="1" exit /b 1
if "!BV_RC!"=="2" exit /b 2
>&2 echo ERROR: the backup command ended unexpectedly (exit !BV_RC!); see the output above.
exit /b 1

:: ============================================================
:: Subroutines
:: ============================================================

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
