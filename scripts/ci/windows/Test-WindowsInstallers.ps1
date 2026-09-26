<#
.SYNOPSIS
  Runs install.bat and update.bat non-interactively and asserts what they did.

.DESCRIPTION
  These two scripts have NEVER been executed on Windows — the maintainer's
  machine has no cmd.exe — so this is the only verification that exists for
  them. It is driven by .github/workflows/ci.yml (windows-latest) and can be
  run by hand on any Windows box:

      pwsh -File scripts/ci/windows/Test-WindowsInstallers.ps1

  WHAT IS REAL HERE
    * every line of install.bat and update.bat, including the Compose version
      parser, the interactive wizard, the PowerShell CSPRNG password and its
      48-hex validation, mkdir, .env writing, the icacls hardening, .env
      parsing, provider detection, the preflight checks, and a real `git pull`
      against a real (local) remote;
    * the cmd.exe byte-offset resume hazard, reproduced end to end: the
      pre-PostgreSQL update.bat runs `git pull`, the pull replaces update.bat
      underneath it, and cmd.exe resumes at the old byte position inside the
      new file. That is the specific failure the colon-only landing pad exists
      to absorb, and scenario 8 is the first time it has ever been executed.

  WHAT IS NOT REAL
    * Docker. scripts/ci/windows/docker.cmd stands in for it, because a GitHub
      windows runner cannot build this project's Linux image. Nothing here
      proves the image builds, that compose starts a container, or that the
      app is reachable. The Linux docker-build job covers the image.
    * Prompt RENDERING. Input is redirected from a file, so `set /p` reads the
      answers but nobody sees the box-drawing characters. The .bat files are
      UTF-8 while cmd.exe defaults to cp437, so the banners are expected to
      render as mojibake on a real user's machine. That is cosmetic and is NOT
      checked here.
    * `timeout /t 5 /nobreak` prints "input redirection is not supported" under
      a redirected stdin and returns non-zero. Neither script checks it, so
      the runs continue; on a real user's machine it sleeps as intended.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# PowerShell 7.4+ defaults this to $true, which turns ANY native command
# exiting non-zero into a thrown error under ErrorActionPreference='Stop'.
# Three scenarios below deliberately assert a non-zero exit code from
# cmd.exe, so that default would abort the run instead of letting them
# check what they exist to check. Exit codes are read from $LASTEXITCODE.
$PSNativeCommandUseErrorActionPreference = $false

$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Checks = 0
$StubDir = $PSScriptRoot
$SandboxRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$Sandboxes = Join-Path $SandboxRoot "bv-win"
if (Test-Path $Sandboxes) { Remove-Item -Recurse -Force $Sandboxes }
New-Item -ItemType Directory -Force -Path $Sandboxes | Out-Null

function Assert([bool]$Condition, [string]$Message) {
  $script:Checks++
  if ($Condition) { Write-Host "    ok   $Message" }
  else { Write-Host "    FAIL $Message" -ForegroundColor Red; $script:Failures.Add($Message) }
}

function New-Sandbox([string]$Name) {
  $dir = Join-Path $Sandboxes $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($f in @("install.bat", "update.bat", "docker-compose.yml", ".env.example")) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path $src) { Copy-Item $src $dir }
  }
  return $dir
}

# Runs a .bat with stdin redirected from a file of answers, and returns the
# exit code plus everything it printed. Answers are written without a trailing
# newline problem: `set /p` on an empty line leaves the variable unset, which
# is how these scripts take their default.
function Invoke-Bat {
  param(
    [string]$Dir, [string]$Script, [string[]]$Answers = @(),
    [hashtable]$EnvVars = @{}
  )
  $answerFile = Join-Path $Dir "__answers.txt"
  ($Answers + @("", "", "", "", "")) -join "`r`n" | Set-Content -Path $answerFile -Encoding Ascii
  $logFile = Join-Path $Dir "__stub.log"
  Remove-Item -Force $logFile -ErrorAction SilentlyContinue

  $saved = @{}
  $vars = @{ "BV_STUB_LOG" = $logFile; "BV_STUB_COMPOSE_VERSION" = "2.30.1"; "BV_STUB_FAIL_ON" = $null }
  foreach ($k in $EnvVars.Keys) { $vars[$k] = $EnvVars[$k] }
  foreach ($k in $vars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
    [Environment]::SetEnvironmentVariable($k, $vars[$k])
  }
  $oldPath = $env:PATH
  $env:PATH = "$StubDir;$oldPath"   # the stub must win over any real docker
  try {
    $out = & cmd.exe /c "`"$Dir\$Script`" < `"$answerFile`" 2>&1"
    $code = $LASTEXITCODE
  } finally {
    $env:PATH = $oldPath
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
  $stub = if (Test-Path $logFile) { (Get-Content $logFile -Raw) } else { "" }
  return [pscustomobject]@{
    ExitCode = $code
    Output   = ($out | Out-String)
    StubLog  = $stub
    Dir      = $Dir
  }
}

function Get-EnvValue([string]$Dir, [string]$Key) {
  $p = Join-Path $Dir ".env"
  if (-not (Test-Path $p)) { return $null }
  $line = Get-Content $p | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))=" } | Select-Object -Last 1
  if (-not $line) { return $null }
  return ($line -replace "^\s*$([regex]::Escape($Key))=", "").Trim()
}

function Write-Scenario([string]$Name) { Write-Host "`n==> $Name" -ForegroundColor Cyan }

# ---------------------------------------------------------------- scenario 1
Write-Scenario "install.bat - fresh install, PostgreSQL (answers: default dir, default port, 1)"
$d = New-Sandbox "install-postgres"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "1")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (Test-Path (Join-Path $d ".env")) ".env was written"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "postgres") "BLACKVAULT_DB_PROVIDER=postgres"
Assert ((Get-EnvValue $d "COMPOSE_PROFILES") -eq "postgres") "COMPOSE_PROFILES=postgres"
$pw = Get-EnvValue $d "BLACKVAULT_POSTGRES_PASSWORD"
Assert ($pw -match "^[0-9a-f]{48}$") "password is exactly 48 lowercase hex chars (real CSPRNG path)"
Assert ((Get-EnvValue $d "BLACKVAULT_DATABASE_URL") -eq "postgresql://blackvault:$pw@db:5432/blackvault") "DATABASE_URL embeds the same password"
Assert ((Get-EnvValue $d "PORT") -eq "3000") "PORT defaulted to 3000"
Assert (Test-Path (Join-Path $d "data\db")) "data\db created"
Assert (Test-Path (Join-Path $d "data\uploads")) "data\uploads created"
Assert (Test-Path (Join-Path $d "data\postgres")) "data\postgres created"
Assert ($r.StubLog -match "compose build") 'ran docker compose build'
Assert ($r.StubLog -match "compose up -d") 'ran docker compose up -d'
Assert ($r.Output -notmatch $pw) "the password is never echoed to the terminal"

# ---------------------------------------------------------------- scenario 2
Write-Scenario "install.bat - fresh install, SQLite, custom data dir and port"
$d = New-Sandbox "install-sqlite"
$custom = Join-Path $d "myvault"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @($custom, "8099", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "BLACKVAULT_DB_PROVIDER=sqlite"
Assert ((Get-EnvValue $d "PORT") -eq "8099") "PORT honoured the typed value"
Assert ((Get-EnvValue $d "DATA_DIR") -eq $custom) "DATA_DIR honoured the typed path"
Assert ($null -eq (Get-EnvValue $d "BLACKVAULT_POSTGRES_PASSWORD")) "no password key for SQLite"
Assert ($null -eq (Get-EnvValue $d "COMPOSE_PROFILES")) "no COMPOSE_PROFILES for SQLite"
Assert (Test-Path (Join-Path $custom "db")) "custom data dir created"
Assert (-not (Test-Path (Join-Path $custom "postgres"))) "no postgres dir for SQLite"

# ---------------------------------------------------------------- scenario 3
Write-Scenario "install.bat - Docker Compose too old (2.19.0) stops before writing anything"
$d = New-Sandbox "install-old-compose"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "2") -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = "2.19.0" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "2\.20 or newer") "explains the v2.20 requirement"
Assert (-not (Test-Path (Join-Path $d ".env"))) "wrote NO .env"
Assert (-not (Test-Path (Join-Path $d "data"))) "created NO data directories"

# ---------------------------------------------------------------- scenario 4
Write-Scenario "install.bat - no Docker Compose v2 at all"
$d = New-Sandbox "install-no-compose"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "2") -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = $null }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert (-not (Test-Path (Join-Path $d ".env"))) "wrote NO .env"

# ---------------------------------------------------------------- scenario 5
Write-Scenario "install.bat - a leading v on the version is accepted (v2.30.1)"
$d = New-Sandbox "install-v-prefix"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "2") -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = "v2.30.1" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "still configured SQLite"

# ---------------------------------------------------------------- scenario 6
Write-Scenario "install.bat - re-run over an existing configured install starts it, does not reconfigure"
$d = New-Sandbox "install-existing"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\db") | Out-Null
Set-Content -Path (Join-Path $d "data\db\vault.db") -Value "not really sqlite" -Encoding Ascii
@("DATA_DIR=$d\data", "PORT=7777", "BLACKVAULT_DB_PROVIDER=sqlite") |
  Set-Content -Path (Join-Path $d ".env") -Encoding Ascii
$before = Get-Content (Join-Path $d ".env") -Raw
$r = Invoke-Bat -Dir $d -Script "install.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "already configured") "says it is already configured"
Assert ((Get-Content (Join-Path $d ".env") -Raw) -eq $before) ".env left byte-for-byte unchanged"
Assert ($r.StubLog -match "compose up -d") "started the existing configuration"
Assert ($r.StubLog -notmatch "compose build") "did NOT rebuild"
Assert ($r.Output -match "7777") "reported the configured port"

# --------------------------------------------------------------- git helpers
function New-GitRemote([string]$Name, [string]$UpdateBatSource) {
  $origin = Join-Path $Sandboxes "$Name-origin"
  New-Item -ItemType Directory -Force -Path $origin | Out-Null
  foreach ($f in @("install.bat", "docker-compose.yml", ".env.example")) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path $src) { Copy-Item $src $origin }
  }
  Copy-Item $UpdateBatSource (Join-Path $origin "update.bat")
  Set-Content -Path (Join-Path $origin "README.md") -Value "v1" -Encoding Ascii
  & git -C $origin init -q --initial-branch=main | Out-Null
  & git -C $origin -c user.name=ci -c user.email=ci@example.com add -A | Out-Null
  & git -C $origin -c user.name=ci -c user.email=ci@example.com commit -q -m "initial" | Out-Null
  return $origin
}

function Add-RemoteCommit([string]$Origin, [string]$NewUpdateBat) {
  if ($NewUpdateBat) { Copy-Item $NewUpdateBat (Join-Path $Origin "update.bat") -Force }
  Set-Content -Path (Join-Path $Origin "README.md") -Value "v2 - a newer release" -Encoding Ascii
  & git -C $Origin -c user.name=ci -c user.email=ci@example.com add -A | Out-Null
  & git -C $Origin -c user.name=ci -c user.email=ci@example.com commit -q -m "a newer release" | Out-Null
}

function New-WorkingClone([string]$Origin, [string]$Name) {
  $work = Join-Path $Sandboxes $Name
  & git clone -q $Origin $work | Out-Null
  # `git pull` on a clone of a local path needs no credentials, so nothing
  # here can touch a real remote or a real token.
  & git -C $work config user.name ci | Out-Null
  & git -C $work config user.email ci@example.com | Out-Null
  return $work
}

function Set-SqliteInstall([string]$Dir, [string]$Port = "3000") {
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir "data\db") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir "data\uploads") | Out-Null
  Set-Content -Path (Join-Path $Dir "data\db\vault.db") -Value "not really sqlite" -Encoding Ascii
  @("DATA_DIR=$Dir\data", "PORT=$Port", "BLACKVAULT_DB_PROVIDER=sqlite") |
    Set-Content -Path (Join-Path $Dir ".env") -Encoding Ascii
}

# ---------------------------------------------------------------- scenario 7
Write-Scenario "update.bat - SQLite install, real git pull against a real remote"
$origin = New-GitRemote "update-sqlite" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-sqlite"
Set-SqliteInstall $work "7001"
Add-RemoteCommit $origin $null
$head = (& git -C $work rev-parse HEAD)
$r = Invoke-Bat -Dir $work -Script "update.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Database provider: sqlite") "detected the sqlite provider from .env"
Assert ($r.Output -match "Database verified at") "preflight found the database"
Assert ((& git -C $work rev-parse HEAD) -ne $head) "git pull really fast-forwarded the clone"
Assert ((Get-Content (Join-Path $work "README.md") -Raw).Trim() -eq "v2 - a newer release") "the pulled content is on disk"
Assert ($r.StubLog -match "compose build --pull") 'ran docker compose build --pull'
Assert ($r.StubLog -match "compose up -d") 'ran docker compose up -d'
Assert ($r.Output -match "7001") "reported the configured port"

# ---------------------------------------------------------------- scenario 8
Write-Scenario "update.bat - PostgreSQL .env missing keys warns but does not stop"
$origin = New-GitRemote "update-pg-warn" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-pg-warn"
New-Item -ItemType Directory -Force -Path (Join-Path $work "data\postgres") | Out-Null
@("DATA_DIR=$work\data", "PORT=3000", "BLACKVAULT_DB_PROVIDER=postgres") |
  Set-Content -Path (Join-Path $work ".env") -Encoding Ascii
$r = Invoke-Bat -Dir $work -Script "update.bat"
Assert ($r.ExitCode -eq 0) "exits 0 despite the warning (got $($r.ExitCode))"
Assert ($r.Output -match "Database provider: postgres") "detected the postgres provider"
Assert ($r.Output -match "COMPOSE_PROFILES=postgres") "named the missing COMPOSE_PROFILES key"
Assert ($r.Output -match "BLACKVAULT_POSTGRES_PASSWORD") "named the missing password key"
Assert ($r.Output -match "PostgreSQL data verified") "preflight found the cluster directory"
Assert ($r.StubLog -match "compose up -d") "still restarted"

# ---------------------------------------------------------------- scenario 9
Write-Scenario "update.bat - compose failure is reported and does not exit 0"
$origin = New-GitRemote "update-fail" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-fail"
Set-SqliteInstall $work
$r = Invoke-Bat -Dir $work -Script "update.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "build" }
Assert ($r.ExitCode -eq 1) "exits 1 when compose build fails (got $($r.ExitCode))"
Assert ($r.Output -match "docker compose failed") "says compose failed"
Assert ($r.StubLog -notmatch "compose up -d") "did NOT try to start after a failed build"

# --------------------------------------------------------------- scenario 10
Write-Scenario "update.bat - THE BYTE-OFFSET RESUME HAZARD, reproduced end to end"
# The pre-PostgreSQL update.bat runs `git pull` from inside an `if ( )` block.
# cmd.exe re-reads a running batch file by byte offset, so the instant the pull
# replaces update.bat, execution resumes in the NEW file at the byte position
# reached in the OLD one - 2699 on an LF checkout, 2773 on a CRLF one, both of
# which sit inside the colon-only landing pad. This has never been executed
# before; until now the pad was hand-checked arithmetic.
#
# scripts/update-bat-landing-pad.test.ts proves the offsets still land in the
# pad on every platform. THIS proves cmd.exe actually survives it.
$oldBat = Join-Path $Sandboxes "old-update.bat"
# Redirected by cmd, not by PowerShell: Set-Content/Out-File would re-encode
# (and PS 5.1's utf8 adds a 3-byte BOM), and ANY byte added or removed moves
# the very offsets this scenario exists to test.
& cmd.exe /c "git -C ""$RepoRoot"" show faf7651:update.bat > ""$oldBat"""
if ((-not (Test-Path $oldBat)) -or ((Get-Item $oldBat).Length -lt 3000)) {
  throw ("Could not extract faf7651:update.bat. The Windows job needs the " +
         "full history - set 'fetch-depth: 0' on its checkout step. If that " +
         "commit is genuinely gone, update the SHA in this script.")
}

$origin = New-GitRemote "update-resume" $oldBat
$work = New-WorkingClone $origin "update-resume"
Set-SqliteInstall $work "7010"
# The remote's newer commit replaces update.bat with the CURRENT one - exactly
# what a real user pulling an update gets.
Add-RemoteCommit $origin (Join-Path $RepoRoot "update.bat")

$onDiskBefore = (Get-Content (Join-Path $work "update.bat") -Raw)
$r = Invoke-Bat -Dir $work -Script "update.bat"
$onDiskAfter = (Get-Content (Join-Path $work "update.bat") -Raw)

Assert ($onDiskBefore -ne $onDiskAfter) "the pull really did replace update.bat mid-run"
Assert ($onDiskAfter -match "landing pad") "the new update.bat is the current one"
Assert ($r.ExitCode -eq 0) "cmd.exe survived the swap and exited 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose up -d") "it still reached the restart"
# The tell-tale of a BAD landing: cmd printing a fragment of a line as a
# command it does not recognise.
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error from a mid-line resume"

# --------------------------------------------------------------------- report
Write-Host "`n================ summary ================"
Write-Host "$($script:Checks) checks, $($script:Failures.Count) failed"
if ($script:Failures.Count -gt 0) {
  foreach ($f in $script:Failures) { Write-Host "  FAILED: $f" -ForegroundColor Red }
  exit 1
}
Write-Host "install.bat and update.bat verified on Windows (Docker stubbed)." -ForegroundColor Green
exit 0
