@echo off
:: reencrypt-files.bat - recover uploaded files that are encrypted with an OLD
:: key, when you still have that key. Windows twin of reencrypt-files.sh
:: (full-backups spec, section 3): change them together. :require_compose
:: (bottom) is the same subroutine as in install.bat / update.bat /
:: rotate-key.bat / backup.bat.
::
::   reencrypt-files.bat --from-key-file <path>
::
:: WHEN. Photos and documents open only with the key that encrypted them. If
:: the uploads folder holds files from another key - a folder copied from
:: another machine, an old backups\uploads-<time>\ put back after a key
:: rotation - BlackVault refuses to start. With the key those files were
:: encrypted with, this script re-encrypts them under THIS install's key
:: (secrets\blackvault_encryption_key). Without that key the files cannot be
:: recovered.
::
:: <path> is the OLD key file: the same format as the install's own key file
:: (64 hex characters). It is only read. This script never deletes, moves or
:: rewrites a key file. Keep the old key file until BlackVault has started
:: and your photos and documents open.
::
:: WHAT IT DOES, in this order:
::   1. Checks that the old key file is there and not empty (exit 3 if not).
::   2. Notes whether BlackVault is running, then stops it.
::   3. Runs the re-encryption in a one-off container: every file under
::      uploads\images and uploads\documents that is encrypted with the old
::      key is decrypted with it, encrypted with the current key and replaced
::      in one step. Files already under the current key are skipped, so
::      running this twice is safe. Files under any other key, and files that
::      are not encrypted, are left as they are.
::   4. Starts BlackVault again - only if it was running in step 2 - and says
::      whether it did.
:: It deletes no file. If it stops part-way, every file is whole, under the
:: old key or the current one: run it again and it continues with the rest.
::
:: THE OLD KEY NEVER TOUCHES cmd.exe. It is handed over exactly as backup.bat
:: hands over a passphrase file: one PowerShell process reads the file's
:: bytes, starts docker itself with docker's standard input a pipe, writes
:: the bytes into that pipe and closes it. The key is in no cmd variable, on
:: no command line, in no environment. BV_PASSFILE holds the PATH of the
:: file, nothing else. The PowerShell line is backup.bat's, character for
:: character (scripts/reencrypt-files-wrapper.test.ts checks it); because
:: BV_PASSFILE is always set here, its prompt is never reached.
::
:: HOW IT RUNS
::   docker compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs
:: with no --user and no --no-deps, as backup.bat's one-off container (the
:: image's entrypoint places the CURRENT key as root, then drops to the app
:: user). Stopping and starting are `docker compose stop blackvault` and
:: `docker compose start blackvault`, as in rotate-key.bat.
::
:: OUTPUT: one line on standard output, from the program, whenever it went
:: through the uploads folder:
::   BLACKVAULT_REENCRYPT_[OK or NOTHING or FAILED] reencrypted=n already_current=n unknown_key=n not_encrypted=n failed=n
:: Everything else goes to standard error. The last line says whether
:: BlackVault was started. It never pauses.
::
:: EXIT CODE
::   0  at least one file was under the old key, and all of them were re-encrypted
::   3  nothing was changed: no file is under the old key (this is also what a
::      second run answers), or the old key file is missing, empty, not a key,
::      or is this install's current key
::   1  failed

:: Arguments are read BEFORE changing folder: a relative --from-key-file path
:: is relative to where the user ran this from. `shift /1`, never a bare
:: `shift`: a bare shift also replaces argument 0, the path of this script,
:: and the `cd /d` below would then go to the key file's folder.
setlocal DisableDelayedExpansion
set "BV_PASSFILE="

:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--from-key-file" goto :arg_keyfile
:: Never echoed back: it could be a key typed here by mistake.
>&2 echo ERROR: unknown argument. Usage: reencrypt-files.bat --from-key-file path
exit /b 1

:arg_keyfile
if "%~2"=="" goto :arg_missing
set "BV_PASSFILE=%~f2"
shift /1
shift /1
goto :parse_args

:arg_missing
>&2 echo ERROR: --from-key-file needs a path. Usage: reencrypt-files.bat --from-key-file path
exit /b 1

:args_done
:: Run from the folder this script lives in (.env and docker-compose.yml).
cd /d "%~dp0"
setlocal EnableDelayedExpansion

:: -- 1. The old key file (exit 3: nothing was done) -----------------
if defined BV_PASSFILE goto :keyfile_given
>&2 echo ERROR: no old key file was given. Usage: reencrypt-files.bat --from-key-file path
exit /b 1
:keyfile_given
if not exist "!BV_PASSFILE!" goto :keyfile_unreadable
if exist "!BV_PASSFILE!\" goto :keyfile_unreadable
for %%F in ("!BV_PASSFILE!") do if %%~zF EQU 0 goto :keyfile_empty
goto :keyfile_ok
:keyfile_unreadable
>&2 echo ERROR: cannot read the old key file !BV_PASSFILE!.
exit /b 3
:keyfile_empty
>&2 echo ERROR: the old key file !BV_PASSFILE! is empty.
exit /b 3
:keyfile_ok

:: -- 2. The install ------------------------------------------------
call :require_compose
if defined COMPOSE goto :compose_ok
if not defined _CV set "_CV=none"
>&2 echo ERROR: BlackVault needs Docker Compose v2.20 or newer, run as 'docker compose' (found: !_CV!). Nothing was done.
exit /b 1
:compose_ok

:: docker compose must read the BLACKVAULT_* keys from .env only, never from
:: this console, and the one-off container must not inherit an
:: uploads-snapshot marker (see rotate-key.bat). BV_LIMIT is backup.bat's
:: time limit for the shared PowerShell step: none here.
set "BLACKVAULT_DATABASE_URL="
set "BLACKVAULT_DB_PROVIDER="
set "BLACKVAULT_POSTGRES_PASSWORD="
set "BLACKVAULT_UPLOADS_SNAPSHOT="
set "BLACKVAULT_BACKUP_DIR="
set "BV_LIMIT="

:: -- 3. Stop the app -----------------------------------------------
set "BV_RUNNING="
for /f "usebackq delims=" %%I in (`%COMPOSE% ps --status running -q blackvault 2^>nul`) do set "BV_RUNNING=1"
>&2 echo Stopping BlackVault...
%COMPOSE% stop blackvault 1>&2
if not errorlevel 1 goto :stopped
if defined BV_RUNNING goto :stop_failed_running
>&2 echo ERROR: could not stop BlackVault. Nothing was changed; BlackVault was not running before and was NOT started.
exit /b 1
:stop_failed_running
>&2 echo ERROR: could not stop BlackVault. Nothing was changed; BlackVault was left as it was.
exit /b 1
:stopped

:: -- 4. Re-encrypt, the old key file on docker's standard input -----
:: The line below is backup.bat's (see THE OLD KEY NEVER TOUCHES cmd.exe at
:: the top, and backup.bat for why each detail of it is there). The
:: second-call variables are cleared, so it makes exactly one call.
>&2 echo Re-encrypting the files that are under the old key. A large uploads folder can take a while...
set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs"
set "BV_DOCKER_ARGS_2="
set "BV_BETWEEN="
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; try { if ($env:BV_PASSFILE) { $bytes = [IO.File]::ReadAllBytes($env:BV_PASSFILE) } else { if ([Console]::IsInputRedirected) { [Console]::Error.WriteLine('ERROR: no passphrase: standard input is not a console, so there is nobody to ask. Use --passphrase-file <path>. Nothing was done.'); exit 1 }; $m = [Runtime.InteropServices.Marshal]; $p1 = $m::PtrToStringUni($m::SecureStringToGlobalAllocUnicode((Read-Host 'Backup passphrase' -AsSecureString))); if ($p1.Length -eq 0) { [Console]::Error.WriteLine('ERROR: the passphrase is empty. Nothing was done.'); exit 1 }; if ($env:BV_MODE -ne 'verify') { $p2 = $m::PtrToStringUni($m::SecureStringToGlobalAllocUnicode((Read-Host 'Repeat the passphrase' -AsSecureString))); if ($p1 -cne $p2) { [Console]::Error.WriteLine('ERROR: the two passphrases do not match. Nothing was done.'); exit 1 } }; $bytes = [Text.Encoding]::UTF8.GetBytes($p1) }; $docker = @(Get-Command docker -CommandType Application)[0].Path; $calls = @($env:BV_DOCKER_ARGS); if ($env:BV_DOCKER_ARGS_2) { $calls += $env:BV_DOCKER_ARGS_2 }; $limit = 0; if ($env:BV_LIMIT) { $limit = [int]$env:BV_LIMIT }; if ([Console]::InputEncoding.GetPreamble().Length -gt 0) { [Console]::InputEncoding = New-Object Text.UTF8Encoding $false }; for ($i = 0; $i -lt $calls.Count; $i++) { if ($i -eq 1) { $between = New-Object Diagnostics.ProcessStartInfo; $between.FileName = $env:ComSpec; $q = [string][char]34; $between.Arguments = '/d /s /c ' + $q + $q + $env:BV_BETWEEN + $q + $q; $between.UseShellExecute = $false; $b = [Diagnostics.Process]::Start($between); $b.WaitForExit(); if ($b.ExitCode -ne 0) { exit 1 } }; $psi = New-Object Diagnostics.ProcessStartInfo; $psi.FileName = $docker; $psi.Arguments = $calls[$i]; $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $toErr = ($calls.Count -gt 1) -and ($i -eq 0); if ($toErr) { $psi.RedirectStandardOutput = $true }; $p = [Diagnostics.Process]::Start($psi); $pipe = $p.StandardInput.BaseStream; $pipe.Write($bytes, 0, $bytes.Length); $pipe.Flush(); $pipe.Close(); if ($toErr) { $err = [Console]::OpenStandardError(); $p.StandardOutput.BaseStream.CopyTo($err); $err.Flush() }; if ($limit -gt 0) { if (-not $p.WaitForExit($limit * 1000)) { try { $p.Kill() } catch { }; [Console]::Error.WriteLine('ERROR: the backup did not finish within ' + $limit + ' seconds (BLACKVAULT_BACKUP_TIMEOUT). It may still be running inside the container.'); exit 1 } } else { $p.WaitForExit() }; if ($p.ExitCode -ne 0) { exit $p.ExitCode } }; exit 0 } catch { [Console]::Error.WriteLine('ERROR: could not run docker: ' + $_.Exception.Message); exit 1 }"
set "BV_RC=!errorlevel!"

:: -- 5. Start the app again if it was running, and say so ----------
set "BV_STARTED=BlackVault was not running before, so it was NOT started. Start it with: docker compose up -d"
if not defined BV_RUNNING goto :start_done
set "BV_STARTED=BlackVault was started again."
%COMPOSE% start blackvault 1>&2
if errorlevel 1 set "BV_STARTED=WARNING: BlackVault did NOT start again: check the logs (docker compose logs blackvault) and start it by hand: docker compose up -d"
:start_done
if "!BV_RC!"=="0" goto :ended_ok
if "!BV_RC!"=="3" goto :ended_nothing
if "!BV_RC!"=="1" goto :ended_failed
>&2 echo ERROR: the re-encryption command ended unexpectedly (exit !BV_RC!); see the output above. Every file is whole, under the old key or the current one; run reencrypt-files.bat again to continue. !BV_STARTED!
exit /b 1
:ended_ok
>&2 echo Done. Keep the old key file until BlackVault has started and your photos and documents open. !BV_STARTED!
exit /b 0
:: The program printed why (one reencrypt-files: line).
:ended_nothing
>&2 echo Nothing was changed. !BV_STARTED!
exit /b 3
:ended_failed
>&2 echo ERROR: the re-encryption failed (the reason is above). Every file is whole, under the old key or the current one; run reencrypt-files.bat again to continue. !BV_STARTED!
exit /b 1

:: ============================================================
:: Subroutines
:: ============================================================

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
