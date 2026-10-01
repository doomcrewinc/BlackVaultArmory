<#
.SYNOPSIS
  Runs install.bat, update.bat and rotate-key.bat non-interactively and
  asserts what they did.

.DESCRIPTION
  These scripts have NEVER been executed on Windows — the maintainer's
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
    * Docker. scripts/ci/windows/docker-stub.cs is compiled to docker.exe and
      stands in for it, because a GitHub windows runner cannot build this
      project's Linux image. Nothing here proves the image builds, that
      compose starts a container, or that the app is reachable. The Linux
      docker-image job covers the image.

      It must be an .exe. A .cmd stub invalidated the first live run: cmd.exe
      never returns from a batch file invoked without `call`, and the scripts
      invoke Docker bare (correctly - the real docker is an .exe). See the
      header of docker-stub.cs for the full account.
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
$ScriptDir = $PSScriptRoot
$SandboxRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$Sandboxes = Join-Path $SandboxRoot "bv-win"
if (Test-Path $Sandboxes) { Remove-Item -Recurse -Force $Sandboxes }
New-Item -ItemType Directory -Force -Path $Sandboxes | Out-Null

# ---------------------------------------------------------------- the stub
# Compiled to a REAL EXECUTABLE. A .cmd here silently truncated every script
# after its first Docker call - see docker-stub.cs for why. PATHEXT resolves
# .EXE before .CMD, so this also wins over a stale stub.
# Built into the sandbox, never into the repo checkout, so a local run
# leaves no stray binary beside the sources.
$StubDir = Join-Path $Sandboxes "stub"
New-Item -ItemType Directory -Force -Path $StubDir | Out-Null
$StubExe = Join-Path $StubDir "docker.exe"
$StubSrc = Join-Path $ScriptDir "docker-stub.cs"
if (-not (Test-Path $StubSrc)) { throw "missing $StubSrc" }
Remove-Item -Force $StubExe -ErrorAction SilentlyContinue

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (Test-Path $csc) {
  & $csc /nologo /optimize+ /target:exe "/out:$StubExe" $StubSrc | Out-Null
} else {
  # PowerShell 7 cannot always emit an assembly to disk, so csc is preferred.
  Add-Type -TypeDefinition (Get-Content $StubSrc -Raw) `
           -OutputAssembly $StubExe -OutputType ConsoleApplication
}
if (-not (Test-Path $StubExe)) { throw "could not build the docker stub at $StubExe" }
Write-Host "docker stub built: $StubExe"

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
#
# -NoPad feeds exactly -Answers and then ends the input, instead of padding
# with five blank lines. It is how a scenario proves a prompt gives up at
# end-of-input rather than looping on it.
#
# Every run is bounded by -TimeoutSeconds. A prompt that re-asks forever once
# stdin is exhausted used to be a six-hour hang of the whole job (the job has
# no timeout-minutes); now it is a fast, reported failure: the process tree is
# killed and the exit code is -1.
function Invoke-Bat {
  param(
    [string]$Dir, [string]$Script, [string[]]$Answers = @(),
    [hashtable]$EnvVars = @{},
    [switch]$NoPad,
    [int]$TimeoutSeconds = 180
  )
  $answerFile = Join-Path $Dir "__answers.txt"
  # @() because an `if` that yields an empty array yields $null, and
  # StrictMode then refuses .Count on it.
  $lines = @(if ($NoPad) { $Answers } else { $Answers + @("", "", "", "", "") })
  $text = if ($lines.Count -gt 0) { ($lines -join "`r`n") + "`r`n" } else { "" }
  [IO.File]::WriteAllText($answerFile, $text, [Text.Encoding]::ASCII)
  $logFile = Join-Path $Dir "__stub.log"
  Remove-Item -Force $logFile -ErrorAction SilentlyContinue

  $saved = @{}
  $vars = @{ "BV_STUB_LOG" = $logFile; "BV_STUB_COMPOSE_VERSION" = "2.30.1"; "BV_STUB_FAIL_ON" = $null; "BV_STUB_LOGS_FILE" = $null }
  foreach ($k in $EnvVars.Keys) { $vars[$k] = $EnvVars[$k] }
  foreach ($k in $vars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
    [Environment]::SetEnvironmentVariable($k, $vars[$k])
  }
  $oldPath = $env:PATH
  $env:PATH = "$StubDir;$oldPath"   # the stub must win over any real docker

  # RUN FROM THE SCRIPT'S OWN FOLDER. cmd.exe inherits this process's working
  # directory, and a user double-clicking the .bat gets the folder it lives in.
  #
  # This is not cosmetic. The current install.bat and update.bat open with
  # `cd /d "%~dp0"` and so were immune, but the PRE-POSTGRESQL update.bat used
  # by the resume scenario has no such line — so its bare `git pull` ran in
  # whatever directory happened to be current. On the runner that was the
  # Actions workspace, checked out at a detached PR merge ref, and git replied
  # "You are not currently on a branch." The pull never happened, the sandbox
  # copy of update.bat was never replaced, and the byte-offset resume scenario
  # asserted against a swap that did not occur.
  #
  # (That missing `cd /d` is a real historical wart, and it is precisely what
  # the current scripts' line 14 exists to fix — "Run as administrator" starts
  # in C:\Windows\System32. Already fixed in the shipped scripts; nothing to do
  # but drive the harness correctly.)
  #
  # A Process, not `& cmd.exe`, so the run can be bounded: `&` waits forever.
  # WorkingDirectory is set explicitly because Push-Location only moves
  # PowerShell's location, not the directory a Process starts in.
  $timedOut = $false
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    # /s: strip exactly the outer pair of quotes, keep the inner ones.
    $psi.Arguments = "/d /s /c `"`"$Dir\$Script`" < `"$answerFile`" 2>&1`""
    $psi.WorkingDirectory = $Dir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
      $timedOut = $true
      & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null
    }
    $p.WaitForExit()
    $code = if ($timedOut) { -1 } else { $p.ExitCode }
    $out = $outTask.Result + $errTask.Result
  } finally {
    $env:PATH = $oldPath
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
  }
  if ($timedOut) {
    Write-Host "    TIMEOUT $Script did not finish in $TimeoutSeconds s - killed" -ForegroundColor Red
    $out += "`r`n[harness] TIMED OUT after $TimeoutSeconds s; process tree killed`r`n"
  }
  $stub = if (Test-Path $logFile) { (Get-Content $logFile -Raw) } else { "" }
  return [pscustomobject]@{
    ExitCode = $code
    Output   = $out
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

$script:ScenarioFailBase = 0

function Write-Scenario([string]$Name) {
  $script:ScenarioFailBase = $script:Failures.Count
  Write-Host "`n==> $Name" -ForegroundColor Cyan
}

# Dumps everything the run produced, but ONLY when the scenario failed.
#
# The first live run reported nine failures and showed none of the evidence,
# which turned diagnosis into guesswork. A failing assertion that does not
# print what it actually got is a bad test; this is the fix.
function Show-EvidenceIfFailed([pscustomobject]$Result) {
  if ($script:Failures.Count -eq $script:ScenarioFailBase) { return }
  Write-Host "    ---------------- evidence ----------------" -ForegroundColor Yellow
  Write-Host "    exit code: $($Result.ExitCode)"
  Write-Host "    -- stub log (what the scripts asked Docker to do) --"
  if ([string]::IsNullOrWhiteSpace($Result.StubLog)) {
    Write-Host "       (empty - the stub was never invoked)"
  } else {
    foreach ($l in ($Result.StubLog -split "`r?`n")) { if ($l) { Write-Host "       | $l" } }
  }
  Write-Host "    -- script output --"
  foreach ($l in ($Result.Output -split "`r?`n")) { Write-Host "       | $l" }
  Write-Host "    ------------------------------------------" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- scenario 1
Write-Scenario "install.bat - fresh install, PostgreSQL (answers: default dir, default port, public URL, no proxy, direct access, 1)"
$d = New-Sandbox "install-postgres"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "1")
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
Assert ((Get-EnvValue $d "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "public URL written into the PostgreSQL .env"
Assert ($r.Output -match "URL:\s+https://vault\.example\.com") "the summary shows the public URL"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario 2
Write-Scenario "install.bat - fresh install, SQLite, custom data dir and port"
$d = New-Sandbox "install-sqlite"
$custom = Join-Path $d "myvault"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @($custom, "8099", "https://vault.example.com", "", "", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "BLACKVAULT_DB_PROVIDER=sqlite"
Assert ((Get-EnvValue $d "PORT") -eq "8099") "PORT honoured the typed value"
Assert ((Get-EnvValue $d "DATA_DIR") -eq $custom) "DATA_DIR honoured the typed path"
Assert ($null -eq (Get-EnvValue $d "BLACKVAULT_POSTGRES_PASSWORD")) "no password key for SQLite"
Assert ($null -eq (Get-EnvValue $d "COMPOSE_PROFILES")) "no COMPOSE_PROFILES for SQLite"
Assert (Test-Path (Join-Path $custom "db")) "custom data dir created"
Assert (-not (Test-Path (Join-Path $custom "postgres"))) "no postgres dir for SQLite"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario 3
Write-Scenario "install.bat - Docker Compose too old (2.19.0) stops before writing anything"
$d = New-Sandbox "install-old-compose"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = "2.19.0" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "2\.20 or newer") "explains the v2.20 requirement"
Assert (-not (Test-Path (Join-Path $d ".env"))) "wrote NO .env"
Assert (-not (Test-Path (Join-Path $d "data"))) "created NO data directories"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario 4
Write-Scenario "install.bat - no Docker Compose v2 at all"
$d = New-Sandbox "install-no-compose"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = $null }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert (-not (Test-Path (Join-Path $d ".env"))) "wrote NO .env"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario 5
Write-Scenario "install.bat - a leading v on the version is accepted (v2.30.1)"
$d = New-Sandbox "install-v-prefix"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = "v2.30.1" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "still configured SQLite"

Show-EvidenceIfFailed $r

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

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P1
Write-Scenario "install.bat writes the public URL and seeds direct access on when no proxy is given"
$d = New-Sandbox "p1"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Public URL: the address people open BlackVault at") "the public URL prompt ran"
Assert ($r.Output -match "Allow direct access until your proxy is set up\? \[Y/n\]") "asked about direct access (no proxy given)"
Assert ((Get-EnvValue $d "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "public URL written"
Assert ((Get-EnvValue $d "BLACKVAULT_DIRECT_ACCESS_INITIAL") -eq "on") "direct access seeded on"
Assert ($null -ne (Get-EnvValue $d "BLACKVAULT_TRUSTED_PROXIES")) "BLACKVAULT_TRUSTED_PROXIES line present"
Assert ((Get-EnvValue $d "BLACKVAULT_TRUSTED_PROXIES") -eq "") "BLACKVAULT_TRUSTED_PROXIES left empty"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "the database answer still landed on the database prompt"
Assert ($r.Output -match "Direct:\s+http://<this machine's IP>:3000 \(direct access on\)") "the summary names the direct address"
Assert ($r.StubLog -match "compose up -d") "reached the start"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P1b
Write-Scenario "install.bat - 'n' to direct access writes an empty seed"
$d = New-Sandbox "p1b"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "n", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-EnvValue $d "BLACKVAULT_DIRECT_ACCESS_INITIAL") -eq "") "no seed after answering n"
Assert ($r.Output -notmatch "Direct:") "the summary does not advertise a direct address"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "the database answer still landed on the database prompt"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P2
Write-Scenario "install.bat re-prompts on a URL with a path, and a proxy means no direct-access question"
$d = New-Sandbox "p2"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com/vault", "https://vault.example.com", "10.10.10.3", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "no path") "invalid URL explained"
Assert ((Get-EnvValue $d "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "the valid second answer was written"
Assert ((Get-EnvValue $d "BLACKVAULT_TRUSTED_PROXIES") -eq "10.10.10.3") "trusted proxies written"
Assert ([string]::IsNullOrEmpty((Get-EnvValue $d "BLACKVAULT_DIRECT_ACCESS_INITIAL"))) "no seed when a proxy is set"
Assert ($r.Output -notmatch "Allow direct access") "no direct-access question when a proxy is set"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "the database answer still landed on the database prompt"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P3
Write-Scenario "install.bat - the URL validator rejects what valid_public_url rejects"
# Each of these is rejected by the bash regex in scripts/public-url-prompts.sh
# (^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$). The last answer is valid and
# is written exactly as typed, trailing slash included, as install.sh does.
$bad = @(
  "vault.example.com",                  # no scheme
  "ftp://vault.example.com",            # wrong scheme
  "HTTPS://vault.example.com",          # the bash regex is case-sensitive
  "https://",                           # no host
  "https:///",                          # no host, just the slash
  "https://:8443",                      # no host before the port
  "https://vault.example.com:",         # empty port
  "https://vault.example.com:123456",   # six-digit port
  "https://vault.example.com:84a3",     # non-digit port
  "https://vault.example.com::8443",    # two colons
  "https://vault.example.com//",        # a path of one slash
  "https://vault.example.com?x=1",      # query string
  "https://user@vault.example.com",     # userinfo
  "https://vault&example.com",          # cmd metacharacter
  "https://vault!example.com",          # delayed-expansion metacharacter
  "https://vault.example.com`"",        # a quote
  "https://vault_example.com"           # underscore
)
$r = Invoke-Bat -Dir (New-Sandbox "p3") -Script "install.bat" -Answers (@("", "") + $bad + @("https://vault.example.com:8443/", "", "", "2"))
$d = $r.Dir
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$rejections = ([regex]::Matches($r.Output, "The URL must start with http:// or https:// and have no path")).Count
Assert ($rejections -eq $bad.Count) "rejected all $($bad.Count) bad URLs (got $rejections rejections)"
Assert ((Get-EnvValue $d "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com:8443/") "the valid URL with port and trailing slash written as typed"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "the database answer still landed on the database prompt"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P4
Write-Scenario "install.bat - input ends at the public URL prompt: aborts non-zero, writes nothing"
# Mirrors the EOF test in scripts/public-url-prompts.test.ts. `set /p` cannot
# tell end-of-input from an empty line (both leave the variable unset), so
# the batch prompt gives up after three blank answers in a row. -NoPad ends
# the input right after the data dir and port answers: without that cap this
# scenario would loop until the harness timeout killed it.
$d = New-Sandbox "p4"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "") -NoPad -TimeoutSeconds 60
Assert ($r.ExitCode -ne 0) "exits non-zero (got $($r.ExitCode))"
Assert ($r.ExitCode -ne -1) "finished on its own, was not killed by the harness timeout"
Assert ($r.Output -match "Public URL: the address people open BlackVault at") "reached the public URL prompt (premise)"
Assert ($r.Output -match "No input received; BLACKVAULT_PUBLIC_URL is required\. Aborting\.") "says why it stopped"
Assert (-not (Test-Path (Join-Path $d ".env"))) "wrote NO .env"
Assert ($r.StubLog -notmatch "compose build") "did NOT build"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P4b
Write-Scenario "install.bat - one bad URL then end of input still aborts"
$d = New-Sandbox "p4b"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com/vault") -NoPad -TimeoutSeconds 60
Assert ($r.ExitCode -ne 0) "exits non-zero (got $($r.ExitCode))"
Assert ($r.ExitCode -ne -1) "finished on its own, was not killed by the harness timeout"
Assert ($r.Output -match "no path") "the bad URL was rejected first (premise)"
Assert ($r.Output -match "No input received; BLACKVAULT_PUBLIC_URL is required\. Aborting\.") "says why it stopped"
Assert (-not (Test-Path (Join-Path $d ".env"))) "wrote NO .env"
Show-EvidenceIfFailed $r

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
$envBefore = [IO.File]::ReadAllBytes((Join-Path $work ".env"))
# The .env predates BLACKVAULT_PUBLIC_URL: prompted for it, then for direct
# access (Enter = keep it on), then for trusted proxies (Enter = none).
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Database provider: sqlite") "detected the sqlite provider from .env"
Assert ($r.Output -match "Database verified at") "preflight found the database"
Assert ((& git -C $work rev-parse HEAD) -ne $head) "git pull really fast-forwarded the clone"
Assert ((Get-Content (Join-Path $work "README.md") -Raw).Trim() -eq "v2 - a newer release") "the pulled content is on disk"
Assert ($r.StubLog -match "compose build --pull") 'ran docker compose build --pull'
Assert ($r.StubLog -match "compose up -d") 'ran docker compose up -d'
Assert ($r.Output -match "Public URL: the address people open BlackVault at") "prompted for the missing public URL"
Assert ($r.Output -notmatch "still current") "did not ask to confirm a URL that was not there"
Assert ((Get-EnvValue $work "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "public URL written"
Assert ($r.Output -match "Keep allowing direct access by IP \(http://<ip>:<port>\)\? \[Y/n\]") "asked about direct access"
Assert ((Get-EnvValue $work "BLACKVAULT_DIRECT_ACCESS_INITIAL") -eq "on") "Enter kept direct access on"
Assert ($r.Output -match "Trusted proxies: IPs, CIDR ranges or host names") "asked for trusted proxies"
Assert ((Get-EnvValue $work "BLACKVAULT_TRUSTED_PROXIES") -eq "") "BLACKVAULT_TRUSTED_PROXIES line written, empty"
Assert ((Get-EnvValue $work "PORT") -eq "7001") "PORT untouched"
$envAfter = [IO.File]::ReadAllBytes((Join-Path $work ".env"))
$prefixKept = ($envAfter.Length -ge $envBefore.Length) -and
  ([Text.Encoding]::ASCII.GetString($envAfter, 0, $envBefore.Length) -eq [Text.Encoding]::ASCII.GetString($envBefore))
Assert $prefixKept "every original .env line kept byte for byte (CRLF), new keys appended"
Assert (Test-Path (Join-Path $work ".env.bak")) ".env.bak kept"
Assert (-not (Test-Path (Join-Path $work ".env.tmp"))) "no .env.tmp left behind"
Assert ($r.Output -match "URL:\s+https://vault\.example\.com") "the summary shows the public URL"
Assert ($r.StubLog -match "compose build --pull") "the rebuild still ran after the prompts"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P5
Write-Scenario "update.bat - second run asks only whether the URL is still current"
$envBefore = [IO.File]::ReadAllBytes((Join-Path $work ".env"))
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Public URL is: https://vault\.example\.com") "showed the current URL"
Assert ($r.Output -match "Is this still current\? \[Y/n\]") "asked whether it is still current"
Assert ($r.Output -notmatch "Public URL: the address people open") "did not re-ask for the URL after Enter"
Assert ($r.Output -notmatch "Keep allowing direct access") "did NOT ask about direct access again"
Assert ($r.Output -notmatch "Trusted proxies:") "did NOT ask for trusted proxies again"
Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $work ".env"))) -eq [Convert]::ToBase64String($envBefore)) ".env byte-for-byte unchanged"
Assert ($r.StubLog -match "compose up -d") "still restarted"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario 8
Write-Scenario "update.bat - PostgreSQL .env missing keys warns but does not stop"
$origin = New-GitRemote "update-pg-warn" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-pg-warn"
New-Item -ItemType Directory -Force -Path (Join-Path $work "data\postgres") | Out-Null
@("DATA_DIR=$work\data", "PORT=3000", "BLACKVAULT_DB_PROVIDER=postgres") |
  Set-Content -Path (Join-Path $work ".env") -Encoding Ascii
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 despite the warning (got $($r.ExitCode))"
Assert ($r.Output -match "Database provider: postgres") "detected the postgres provider"
Assert ($r.Output -match "COMPOSE_PROFILES=postgres") "named the missing COMPOSE_PROFILES key"
Assert ($r.Output -match "BLACKVAULT_POSTGRES_PASSWORD") "named the missing password key"
Assert ($r.Output -match "PostgreSQL data verified") "preflight found the cluster directory"
Assert ($r.StubLog -match "compose up -d") "still restarted"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario 9
Write-Scenario "update.bat - compose failure is reported and does not exit 0"
$origin = New-GitRemote "update-fail" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-fail"
Set-SqliteInstall $work
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "") -EnvVars @{ "BV_STUB_FAIL_ON" = "build" }
Assert ($r.ExitCode -eq 1) "exits 1 when compose build fails (got $($r.ExitCode))"
Assert ($r.Output -match "docker compose failed") "says compose failed"
Assert ($r.StubLog -notmatch "compose up -d") "did NOT try to start after a failed build"

Show-EvidenceIfFailed $r

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
$headBefore = (& git -C $work rev-parse HEAD)
# The answers are for the CURRENT update.bat's public-URL prompts, which the
# resumed run reaches after the landing pad.
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
$onDiskAfter = (Get-Content (Join-Path $work "update.bat") -Raw)
$headAfter = (& git -C $work rev-parse HEAD)

# The pull is asserted THREE ways, because the first live run showed how
# quietly it can not happen: git printed "You are not currently on a branch",
# the script carried on, and every downstream assertion about the resume was
# vacuous. A scenario whose premise silently evaporates is worse than no
# scenario, so the premise is now checked explicitly and first.
Assert ($r.Output -match "Pulling latest updates") "the old script reached its git pull"
Assert ($headAfter -ne $headBefore) "git pull actually advanced HEAD (premise of this whole scenario)"
Assert ($r.Output -notmatch "not currently on a branch") "the pull was not refused for want of a branch"
Assert ($onDiskBefore -ne $onDiskAfter) "the pull really did replace update.bat mid-run"
Assert ($onDiskAfter -match "landing pad") "the new update.bat is the current one"
Assert ($r.ExitCode -eq 0) "cmd.exe survived the swap and exited 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose up -d") "it still reached the restart"
# The tell-tale of a BAD landing: cmd printing a fragment of a line as a
# command it does not recognise.
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error from a mid-line resume"
Assert ((Get-EnvValue $work "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "the resumed run reached the public-URL prompt and wrote it"

Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario 10b
Write-Scenario "update.bat - resume from the e570bd8 update.bat (top-level git pull) reaches the prompts and the rebuild"
# The update.bat users have today (e570bd8, develop before this release) runs
# `git pull` as a TOP-LEVEL line. When the pull replaces the file, cmd.exe
# resumes the NEW file at the byte just past that old line - 7123 on an LF
# checkout, 7269 on a CRLF one. The new file's own `git pull` line must end at
# that same byte, so the resume lands on its `if errorlevel 1 (` and flows on.
# A first cut of this release was 58 bytes short there and landed on
# "output above." inside the pull-failure block: pause, exit /b 1, no rebuild.
#
# scripts/update-bat-landing-pad.test.ts pins the arithmetic. THIS proves
# cmd.exe survives it. The .env here predates BLACKVAULT_PUBLIC_URL, so the
# resumed run must also reach the new prompts: public URL, direct access
# (Enter = keep it on), trusted proxies (Enter = none).
$oldBat2 = Join-Path $Sandboxes "old-update-e570bd8.bat"
& cmd.exe /c "git -C ""$RepoRoot"" show e570bd8:update.bat > ""$oldBat2"""
if ((-not (Test-Path $oldBat2)) -or ((Get-Item $oldBat2).Length -lt 7000)) {
  throw ("Could not extract e570bd8:update.bat. The Windows job needs the " +
         "full history - set 'fetch-depth: 0' on its checkout step. If that " +
         "commit is genuinely gone, update the SHA in this script.")
}

$origin = New-GitRemote "update-resume-e570bd8" $oldBat2
$work = New-WorkingClone $origin "update-resume-e570bd8"
Set-SqliteInstall $work "7011"
Add-RemoteCommit $origin (Join-Path $RepoRoot "update.bat")

$onDiskBefore = (Get-Content (Join-Path $work "update.bat") -Raw)
$headBefore = (& git -C $work rev-parse HEAD)
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
$onDiskAfter = (Get-Content (Join-Path $work "update.bat") -Raw)
$headAfter = (& git -C $work rev-parse HEAD)

# Premise first, as in scenario 10: the old script ran, and its pull really
# replaced the file under it. Without these the rest proves nothing.
Assert ($onDiskBefore -notmatch "Byte pad \(these 2 lines\)") "the script that started is the e570bd8 one (premise)"
Assert ($r.Output -match "Pulling latest updates") "the old script reached its git pull"
Assert ($headAfter -ne $headBefore) "git pull actually advanced HEAD (premise of this whole scenario)"
Assert ($onDiskBefore -ne $onDiskAfter) "the pull really did replace update.bat mid-run"
Assert ($onDiskAfter -match "Byte pad \(these 2 lines\)") "the new update.bat is the current one"
# A bad landing runs a line fragment ("output above.") and then the
# pull-failure block's pause / exit /b 1.
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error from a mid-line resume"
Assert ($r.Output -notmatch "git pull failed") "did not fall into the pull-failure block"
Assert ($r.Output -match "Public URL: the address people open BlackVault at") "the resumed run reached the public-URL prompt"
Assert ((Get-EnvValue $work "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "public URL written"
Assert ((Get-EnvValue $work "BLACKVAULT_DIRECT_ACCESS_INITIAL") -eq "on") "asked about direct access; Enter kept it on"
Assert ($r.StubLog -match "compose build --pull") "it reached the rebuild"
Assert ($r.StubLog -match "compose up -d") "it reached the restart"
Assert ($r.ExitCode -eq 0) "cmd.exe survived the swap and exited 0 (got $($r.ExitCode))"

Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P6
Write-Scenario "update.bat - 'n' to still current takes a new URL; other lines untouched (LF, no final newline, & / :)"
# Review focus: an .env edited by hand, here with LF endings, no newline after
# the last line, and values holding & / : must keep every other line
# byte-identical when one key is rewritten, and the value must never be
# interpreted by cmd.
$origin = New-GitRemote "update-change-url" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-change-url"
Set-SqliteInstall $work "7020"
$kept = @(
  "DATA_DIR=$work\data",
  "PORT=7020",
  "BLACKVAULT_DB_PROVIDER=sqlite",
  "SOME_TOKEN=a&b/c:d|e",
  "BLACKVAULT_DIRECT_ACCESS_INITIAL=off",
  "BLACKVAULT_TRUSTED_PROXIES=10.0.0.1,172.28.0.0/16"
)
$original = ($kept[0..3] + @("BLACKVAULT_PUBLIC_URL=https://old.example.com") + $kept[4..5]) -join "`n"
$envPath = Join-Path $work ".env"
[IO.File]::WriteAllBytes($envPath, [Text.Encoding]::ASCII.GetBytes($original))
# Lock .env down the way install.bat's :restrict_env does, so the scenario can
# prove the rewrite keeps that ACL instead of replacing the file.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $envPath /grant:r "*${sid}:F" | Out-Null
& icacls $envPath /inheritance:r | Out-Null
$aclBefore = (Get-Acl $envPath).Sddl
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("n", "https://new.example.com:8443")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Public URL is: https://old\.example\.com") "showed the current URL (premise)"
Assert ($r.Output -match "Public URL: the address people open") "asked for the new URL after n"
Assert ($r.Output -notmatch "Keep allowing direct access") "direct access already set: not asked"
Assert ($r.Output -notmatch "Trusted proxies:") "trusted proxies already set: not asked"
$after = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes((Join-Path $work ".env")))
Assert ((Get-EnvValue $work "BLACKVAULT_PUBLIC_URL") -eq "https://new.example.com:8443") "new URL written"
Assert (([regex]::Matches($after, "(?m)^BLACKVAULT_PUBLIC_URL=")).Count -eq 1) "exactly one BLACKVAULT_PUBLIC_URL line"
Assert ((Get-EnvValue $work "BLACKVAULT_TRUSTED_PROXIES") -eq "10.0.0.1,172.28.0.0/16") "the last original line was not joined to the new one"
Assert ((Get-EnvValue $work "SOME_TOKEN") -eq "a&b/c:d|e") "a value holding & / : | survived"
Assert ($after.StartsWith(($kept -join "`n"))) "every other line kept byte for byte, LF endings included"
Assert ($after -eq (($kept -join "`n") + "`nBLACKVAULT_PUBLIC_URL=https://new.example.com:8443`n")) "exactly what update.sh would write: newline added to the last line, new key appended LF-terminated"
Assert ((Get-Acl $envPath).Sddl -eq $aclBefore) "the restricted ACL on .env survived the rewrite"
$bak = Join-Path $work ".env.bak"
Assert ((Test-Path $bak) -and ([Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($bak)) -eq $original)) ".env.bak holds the original bytes"
Assert ($r.Output -match "URL:\s+https://new\.example\.com:8443") "the summary shows the new URL"
Show-EvidenceIfFailed $r
if ($script:Failures.Count -ne $script:ScenarioFailBase) {
  Write-Host "    -- .env bytes (hex) --"
  Write-Host ("       " + [BitConverter]::ToString([IO.File]::ReadAllBytes((Join-Path $work ".env"))))
}

# ---------------------------------------------------------------- scenario P7
Write-Scenario "update.bat - no .env: stops non-zero before the rebuild, asks nothing, creates no .env"
# Mirrors update.sh's no-.env stop. With no .env there is no
# BLACKVAULT_PUBLIC_URL and the container refuses to start, so rebuilding and
# restarting would take a running BlackVault down. Valid answers are fed, so
# the stop cannot be an accident of a prompt running out of input: only the
# no-.env guard can stop this run before the rebuild.
$origin = New-GitRemote "update-no-env" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-no-env"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "No \.env file found") "the existing no-.env warning ran (premise)"
Assert ($r.Output -match "No \.env file, so no BLACKVAULT_PUBLIC_URL") "says why it stopped"
Assert ($r.Output -match "Run install\.bat") "says how to fix it"
Assert ($r.Output -notmatch "Public URL:") "no public-URL prompt"
Assert ($r.Output -notmatch "Keep allowing direct access") "no direct-access prompt"
Assert ($r.Output -notmatch "Trusted proxies:") "no trusted-proxies prompt"
Assert (-not (Test-Path (Join-Path $work ".env"))) "created no .env"
Assert ($r.StubLog -notmatch "compose build") "did NOT rebuild"
Assert ($r.StubLog -notmatch "compose up") "did NOT restart"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario P8
Write-Scenario "update.bat - input ends at the public URL prompt: aborts non-zero before the rebuild"
$origin = New-GitRemote "update-eof" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-eof"
Set-SqliteInstall $work
$envBefore = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $work ".env")))
$r = Invoke-Bat -Dir $work -Script "update.bat" -NoPad -TimeoutSeconds 60
Assert ($r.ExitCode -ne 0) "exits non-zero (got $($r.ExitCode))"
Assert ($r.ExitCode -ne -1) "finished on its own, was not killed by the harness timeout"
Assert ($r.Output -match "Public URL: the address people open BlackVault at") "reached the public URL prompt (premise)"
Assert ($r.Output -match "No input received; BLACKVAULT_PUBLIC_URL is required\. Aborting\.") "says why it stopped"
Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $work ".env"))) -eq $envBefore) ".env untouched"
Assert ($r.StubLog -notmatch "compose build") "did NOT rebuild"
Assert ($r.StubLog -notmatch "compose up") "did NOT restart"
Show-EvidenceIfFailed $r

# ------------------------------------------------------- setup-token helpers
# What `docker compose logs blackvault` prints while no admin exists: the app
# logs a NEW token at every start, so only the last one is valid. Written as
# UTF-8 without a BOM and with LF endings, as the real CLI prints it; the stub
# replays the bytes unchanged. Mirrors the fixtures in
# scripts/public-url-prompts.test.ts and scripts/setup-token.test.ts.
$TokenLog = @(
  "blackvault  | Prisma schema loaded from prisma/sqlite/schema.prisma",
  "blackvault  | [auth] Setup token: ABCD-EFGH-JKMN-PQRS $([char]0x2014) create the first admin at https://vault.example.com/setup",
  "blackvault  | [auth] Setup token: WXYZ-2345-6789-ABCD $([char]0x2014) create the first admin at https://vault.example.com/setup",
  "blackvault  | Ready in 812ms"
) -join "`n"
$NoTokenLog = @(
  "blackvault  | Prisma schema loaded from prisma/sqlite/schema.prisma",
  "blackvault  | Ready in 812ms"
) -join "`n"

function New-StubLogs([string]$Dir, [string]$Text) {
  $f = Join-Path $Dir "__docker-logs.txt"
  [IO.File]::WriteAllText($f, $Text + "`n", (New-Object Text.UTF8Encoding $false))
  return $f
}

# An existing install that needs no prompts but "Is this still current?".
function Set-ConfiguredSqliteInstall([string]$Dir, [string]$Port) {
  Set-SqliteInstall $Dir $Port
  Add-Content -Path (Join-Path $Dir ".env") -Encoding Ascii -Value @(
    "BLACKVAULT_PUBLIC_URL=https://vault.example.com/",
    "BLACKVAULT_DIRECT_ACCESS_INITIAL=on",
    "BLACKVAULT_TRUSTED_PROXIES="
  )
}

# ---------------------------------------------------------------- scenario T1
Write-Scenario "install.bat - after the start, prints the LAST setup token from the log in a boxed block"
$d = New-Sandbox "t1"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com/", "", "", "2") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $d $TokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose up -d") "started the container (premise)"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log"
Assert ($r.Output -match "BlackVault is running\.") "the health wait saw the container healthy"
Assert ($r.Output -match "First-time setup: open https://vault\.example\.com/setup") "the block names <PUBLIC_URL>/setup (trailing slash dropped)"
Assert ($r.Output -match "and enter the setup token: WXYZ-2345-6789-ABCD") "the block shows the newest token"
Assert ($r.Output -notmatch "ABCD-EFGH-JKMN-PQRS") "an older token from an earlier start is not shown"
Assert ($r.Output -match "(?m)^\s+=+\r?\n\s+First-time setup:.*\r?\n\s+and enter the setup token: .*\r?\n\s+=+\r?$") "the two lines are boxed by rules above and below"
Assert ($r.Output.IndexOf("BlackVault is ready") -ge 0 -and $r.Output.IndexOf("First-time setup") -gt $r.Output.IndexOf("BlackVault is ready")) "the block comes after the summary"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T2
Write-Scenario "install.bat - no token line in the log (an admin exists): nothing extra printed"
$d = New-Sandbox "t2"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $d $NoTokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log (premise)"
Assert ($r.Output -notmatch "First-time setup") "no setup block"
Assert ($r.Output -notmatch "setup token") "no token text at all"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T3
Write-Scenario "update.bat - after the restart, prints the LAST setup token from the log in a boxed block"
$origin = New-GitRemote "update-token" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-token"
Set-ConfiguredSqliteInstall $work "7030"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $Sandboxes $TokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose up -d") "restarted the container (premise)"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log"
Assert ($r.Output -match "Status:\s+running") "the health wait saw the container healthy"
Assert ($r.Output -match "First-time setup: open https://vault\.example\.com/setup") "the block names <PUBLIC_URL>/setup (trailing slash dropped)"
Assert ($r.Output -match "and enter the setup token: WXYZ-2345-6789-ABCD") "the block shows the newest token"
Assert ($r.Output -notmatch "ABCD-EFGH-JKMN-PQRS") "an older token from an earlier start is not shown"
Assert ($r.Output.IndexOf("Update complete") -ge 0 -and $r.Output.IndexOf("First-time setup") -gt $r.Output.IndexOf("Update complete")) "the block comes after the summary"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T4
Write-Scenario "update.bat - no token line in the log (an admin exists): nothing extra printed"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $Sandboxes $NoTokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log (premise)"
Assert ($r.Output -notmatch "First-time setup") "no setup block"
Assert ($r.Output -notmatch "setup token") "no token text at all"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T5
Write-Scenario "update.bat - a malformed code on the last token line prints nothing"
$bad = $TokenLog + "`nblackvault  | [auth] Setup token: WXYZ-2345-6789-ABC $([char]0x2014) create the first admin at https://vault.example.com/setup"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $Sandboxes $bad) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log (premise)"
Assert ($r.Output -notmatch "First-time setup") "no setup block for a code that is not XXXX-XXXX-XXXX-XXXX"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T6
Write-Scenario "injection: update.bat WITHOUT its :show_setup_token call prints no token (T3's assertions can fail)"
# Proves T3 discriminates on real cmd.exe: the same run against a copy of
# update.bat whose `call :show_setup_token` line is removed must NOT show the
# token. If this ever shows it, T3 is passing for some other reason.
$broken = Join-Path $Sandboxes "update-no-token-call.bat"
$lines = [IO.File]::ReadAllText((Join-Path $RepoRoot "update.bat")) -split "`r`n"
$kept = @($lines | Where-Object { $_ -ne "call :show_setup_token ENV_PUBLIC_URL" })
Assert ($kept.Count -eq $lines.Count - 1) "exactly one call line was removed (premise)"
[IO.File]::WriteAllText($broken, ($kept -join "`r`n"), (New-Object Text.UTF8Encoding $false))
$origin = New-GitRemote "update-token-injected" $broken
$work = New-WorkingClone $origin "update-token-injected"
Set-ConfiguredSqliteInstall $work "7031"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $Sandboxes $TokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -notmatch "compose logs blackvault") "never read the log"
Assert ($r.Output -notmatch "WXYZ-2345-6789-ABCD") "no token shown without the call"
Show-EvidenceIfFailed $r

# =============================================================================
#                                rotate-key.bat
# =============================================================================
# Covers Task 6 of the field-encryption plan: rotate-key.bat has, like
# install.bat/update.bat, never run on real cmd.exe before this. Docker is
# stubbed exactly as above. scripts\db-snapshot.bat (Task 7) does not exist in
# this repo yet, so these scenarios supply their OWN stand-in copy of it
# inside each sandbox (never the repo) — the same boundary the docker stub
# sits at: proving THIS script's logic, not scripts\db-snapshot.bat's, which
# is someone else's file.

function New-RotateSandbox {
  param([string]$Name, [switch]$WithSnapshot, [switch]$SnapshotFails)
  $dir = Join-Path $Sandboxes $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($f in @("rotate-key.bat", "docker-compose.yml")) {
    $src = Join-Path $RepoRoot $f
    if (Test-Path $src) { Copy-Item $src $dir }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $dir "secrets") | Out-Null
  # A fixed, obviously-fake 64-hex-char "key" — never a real one, and never
  # asserted to be secret in these scenarios (it's test fixture data).
  Set-Content -Path (Join-Path $dir "secrets\blackvault_encryption_key") -Value ("ab" * 32) -NoNewline -Encoding Ascii
  New-Item -ItemType Directory -Force -Path (Join-Path $dir "scripts") | Out-Null
  if ($WithSnapshot) {
    $code = if ($SnapshotFails) { "exit /b 1" } else { "exit /b 0" }
    Set-Content -Path (Join-Path $dir "scripts\db-snapshot.bat") -Value @("@echo off", "echo [stub snapshot]", $code) -Encoding Ascii
  }
  return $dir
}

# ---------------------------------------------------------------- scenario RK1
Write-Scenario "rotate-key.bat - no secrets\blackvault_encryption_key: exits 1, touches nothing"
$d = New-RotateSandbox "rotate-nokey"
Remove-Item (Join-Path $d "secrets\blackvault_encryption_key") -Force
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "not found\. Nothing to rotate\.") "explains there is no key to rotate"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RK2
Write-Scenario "rotate-key.bat - Docker Compose too old: exits 1 before stopping anything"
$d = New-RotateSandbox "rotate-old-compose"
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_COMPOSE_VERSION" = "2.19.0" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "2\.20 or newer") "explains the v2.20 requirement"
Assert ($r.StubLog -notmatch "compose stop") "never tried to stop the app"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key")) "key file untouched"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RK3
Write-Scenario "rotate-key.bat - scripts\db-snapshot.bat missing: stops, refuses, restarts, exits 1 (ruling R4)"
$d = New-RotateSandbox "rotate-no-snapshot"
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose stop blackvault") "stopped the app first"
Assert ($r.Output -match "scripts\\db-snapshot\.bat is missing") "names the missing snapshot script"
Assert ($r.StubLog -match "compose start blackvault") "restarted BlackVault"
Assert ($r.StubLog -notmatch "compose run") "never attempted the rotation itself"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no .new key file left behind"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "key file byte-for-byte unchanged"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RK4
Write-Scenario "rotate-key.bat - snapshot script fails: refuses, restarts, exits 1"
$d = New-RotateSandbox "rotate-snapshot-fails" -WithSnapshot -SnapshotFails
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "\[stub snapshot\]") "ran the snapshot script"
Assert ($r.Output -match "database snapshot failed") "says the snapshot failed"
Assert ($r.StubLog -match "compose start blackvault") "restarted BlackVault"
Assert ($r.StubLog -notmatch "compose run") "never attempted the rotation itself"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "key file byte-for-byte unchanged"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RK5
Write-Scenario "rotate-key.bat - full success: snapshot, new key generated, rotation run, key files swapped, restarted"
$d = New-RotateSandbox "rotate-success" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose stop blackvault") "stopped the app"
Assert ($r.Output -match "\[stub snapshot\]") "ran the snapshot script"
Assert ($r.StubLog -match [regex]::Escape("compose run --rm -v ./secrets:/run/rotate:ro blackvault node scripts/rotate-encryption-key.mjs --old-key-file /run/rotate/blackvault_encryption_key --new-key-file /run/rotate/blackvault_encryption_key.new")) "ran the rotation with the exact spec'd command"
Assert ($r.StubLog -match "compose start blackvault") "restarted BlackVault"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no stray .new file after a successful swap"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.old")) "the previous key was kept as .old"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key.old") -Raw).Trim() -eq $keyBefore.Trim()) ".old holds the ORIGINAL key"
$keyAfter = (Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw).Trim()
Assert ($keyAfter -match "^[0-9a-f]{64}$") "the active key file is now 64 lowercase hex chars (real CSPRNG path)"
Assert ($keyAfter -ne $keyBefore.Trim()) "the active key actually changed"
Assert ($r.Output -notmatch [regex]::Escape($keyAfter)) "the new key is never echoed to the terminal"
Assert ($r.Output -match "Key rotation complete") "prints the completion banner"
Assert ($r.Output -match "Back up the new key file now") "tells the admin to back up the new key"
Assert ($r.Output -match "Delete .*blackvault_encryption_key\.old once you have") "tells the admin when it's safe to delete the old key"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RK6
Write-Scenario "rotate-key.bat - the rotation command fails: deletes .new, restarts on the OLD key, exits 1"
$d = New-RotateSandbox "rotate-run-fails" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose run") "attempted the rotation"
Assert ($r.Output -match "key rotation failed") "says rotation failed"
Assert ($r.StubLog -match "compose start blackvault") "restarted BlackVault on the previous key"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "the .new key file was deleted"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.old"))) "no .old file: the original key was never touched"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the original key file is byte-for-byte unchanged"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------------- report
Write-Host "`n================ summary ================"
Write-Host "$($script:Checks) checks, $($script:Failures.Count) failed"
if ($script:Failures.Count -gt 0) {
  foreach ($f in $script:Failures) { Write-Host "  FAILED: $f" -ForegroundColor Red }
  exit 1
}
Write-Host "install.bat, update.bat and rotate-key.bat verified on Windows (Docker stubbed)." -ForegroundColor Green
exit 0
