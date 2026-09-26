@echo off
:: A fake `docker` for the Windows CI job (.github/workflows/ci.yml).
::
:: WHY: install.bat and update.bat drive Docker, and a GitHub windows runner
:: cannot build this project's Linux image (no Docker Desktop, no nested
:: virtualisation). Without a stub the only reachable outcome on Windows is
:: "docker compose build failed", which verifies nothing about the scripts.
::
:: With the stub, everything in the .bat files EXCEPT Docker itself runs for
:: real: the Compose version parser, the wizard prompts, the PowerShell CSPRNG
:: password and its hex validation, mkdir, .env writing, icacls hardening,
:: .env parsing, provider detection, the preflight checks, and `git pull`.
:: The real image build is covered on Linux by the docker-build CI job.
::
:: Controlled by environment variables:
::   BV_STUB_LOG              append every invocation here (for assertions)
::   BV_STUB_COMPOSE_VERSION  what `docker compose version` reports.
::                            Unset => the command FAILS, i.e. "no Compose v2".
::   BV_STUB_FAIL_ON          a compose subcommand that should exit 1
::                            (e.g. "build") to exercise the failure paths.
setlocal EnableExtensions

if defined BV_STUB_LOG >>"%BV_STUB_LOG%" echo %*

if /i not "%~1"=="compose" goto :plain_docker

if /i "%~2"=="version" goto :compose_version
if /i "%~2"=="ps" goto :compose_ps

if defined BV_STUB_FAIL_ON if /i "%~2"=="%BV_STUB_FAIL_ON%" goto :compose_fail

echo [stub] docker compose %*
exit /b 0

:compose_version
:: No version configured means "Compose v2 is not installed here", which is
:: what require_compose must detect. It reports failure, not an empty string.
if not defined BV_STUB_COMPOSE_VERSION exit /b 1
echo %BV_STUB_COMPOSE_VERSION%
exit /b 0

:compose_ps
:: install.bat/update.bat pipe this into `findstr /i "healthy running"`.
echo NAME                STATUS
echo blackvault-app      Up 4 seconds (healthy)
exit /b 0

:compose_fail
echo [stub] docker compose %~2: failing on purpose (BV_STUB_FAIL_ON) 1>&2
exit /b 1

:plain_docker
echo [stub] docker %*
exit /b 0
