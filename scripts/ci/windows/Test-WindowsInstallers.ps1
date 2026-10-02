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

# Copies one repo file (a path relative to the repo root, sub-folders
# included) into $DestDir at the same relative path.
function Copy-RepoFile([string]$Rel, [string]$DestDir) {
  $src = Join-Path $RepoRoot $Rel
  if (-not (Test-Path $src)) { return }
  $dest = Join-Path $DestDir $Rel
  New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
  Copy-Item $src $dest
}

# Task 7: update.bat calls scripts\db-snapshot.bat (the REAL one is copied,
# so every update scenario also exercises it against the docker stub).
$TreeFiles = @("install.bat", "update.bat", "docker-compose.yml", ".env.example", "scripts\db-snapshot.bat", "secrets\.gitignore")

function New-Sandbox([string]$Name) {
  $dir = Join-Path $Sandboxes $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($f in $TreeFiles) { Copy-RepoFile $f $dir }
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
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key"))) "Task 7: wrote NO key file"
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
  foreach ($f in $TreeFiles) { if ($f -ne "update.bat") { Copy-RepoFile $f $origin } }
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
$keyPathP5 = Join-Path $work "secrets\blackvault_encryption_key"
$keyBeforeP5 = if (Test-Path $keyPathP5) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPathP5)) } else { "" }
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Public URL is: https://vault\.example\.com") "showed the current URL"
Assert ($r.Output -match "Is this still current\? \[Y/n\]") "asked whether it is still current"
Assert ($r.Output -notmatch "Public URL: the address people open") "did not re-ask for the URL after Enter"
Assert ($r.Output -notmatch "Keep allowing direct access") "did NOT ask about direct access again"
Assert ($r.Output -notmatch "Trusted proxies:") "did NOT ask for trusted proxies again"
Assert ([Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $work ".env"))) -eq [Convert]::ToBase64String($envBefore)) ".env byte-for-byte unchanged"
Assert ($r.StubLog -match "compose up -d") "still restarted"
Assert (($keyBeforeP5 -ne "") -and ([Convert]::ToBase64String([IO.File]::ReadAllBytes($keyPathP5)) -eq $keyBeforeP5)) "Task 7: the key file from the first run is kept byte for byte"
Assert ($r.Output -match "existing, unchanged") "Task 7: says the existing key was kept"
Assert ($r.Output -notmatch "BACK THIS FILE UP") "Task 7: no new-key message on the second run"

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
# stubbed exactly as above. These scenarios supply their OWN stand-in copy of
# scripts\db-snapshot.bat inside each sandbox — the same boundary the docker
# stub sits at: proving THIS script's logic. The real scripts\db-snapshot.bat
# has its own scenarios (DS*, below).

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

# Fix round 2 (N5): poll for a file instead of sleeping a fixed time.
function Wait-ForFile([string]$Path, [int]$TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $Path)) {
    if ((Get-Date) -gt $deadline) { return $false }
    Start-Sleep -Milliseconds 100
  }
  return $true
}

# Holds an exclusive lock (FileShare.None) on $Path in a background job, so
# `move /y` on it fails with a real Windows sharing violation. When $WaitFor
# is given, the job first waits for that file to appear (the docker stub's
# BV_STUB_RUN_HANDSHAKE .ready file). It writes $Flag once the lock is held;
# callers wait for $Flag, never for a fixed time (fix round 2, N5). The job
# closes the handle itself when "$Flag.release" appears, so the lock is
# provably gone before anything after Stop-FileLockJob touches the file
# (stopping a job does not run its remaining statements).
function Start-FileLockJob([string]$Path, [string]$Flag, [string]$WaitFor = "") {
  return Start-Job -ArgumentList $Path, $Flag, $WaitFor -ScriptBlock {
    param($p, $flag, $waitFor)
    if ($waitFor) {
      $deadline = (Get-Date).AddSeconds(90)
      while (-not (Test-Path $waitFor)) {
        if ((Get-Date) -gt $deadline) { return }
        Start-Sleep -Milliseconds 100
      }
    }
    $fs = [System.IO.File]::Open($p, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    try {
      Set-Content -Path $flag -Value "locked" -Encoding Ascii
      $deadline = (Get-Date).AddSeconds(240)
      while (-not (Test-Path "$flag.release")) {
        if ((Get-Date) -gt $deadline) { break }
        Start-Sleep -Milliseconds 100
      }
    } finally {
      $fs.Close()
    }
  }
}

function Stop-FileLockJob($Job, [string]$Flag) {
  Set-Content -Path "$Flag.release" -Value "release" -Encoding Ascii
  Wait-Job $Job -Timeout 30 | Out-Null
  Stop-Job $Job -ErrorAction SilentlyContinue | Out-Null
  Remove-Job $Job -Force -ErrorAction SilentlyContinue | Out-Null
}

# Runs, one by one and literally, every printed recovery line that starts
# with "move /y" (fix round 2, N1: following the text must keep the OLD key).
# Returns how many it ran.
function Invoke-PrintedMoves([string]$Dir, [string]$Output) {
  $moves = @($Output -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^move /y ' })
  foreach ($m in $moves) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/d /c $m"
    $psi.WorkingDirectory = $Dir
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    if (-not $proc.WaitForExit(30000)) { $proc.Kill() }
  }
  return $moves.Count
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
Write-Scenario "rotate-key.bat - scripts\db-snapshot.bat missing: the call fails, so it refuses, restarts, exits 1 (ruling R4; the explicit missing-file check was removed in Task 7)"
$d = New-RotateSandbox "rotate-no-snapshot"
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose stop blackvault") "stopped the app first"
Assert ($r.Output -match "database snapshot failed") "treats the missing snapshot script as a failed snapshot"
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
# Task 7 (I3): no -v bind of secrets\ - docker-compose.yml mounts it and the
# image's entrypoint copies both keys into /run/secrets for the app user.
Assert ($r.StubLog -match [regex]::Escape("compose run --rm blackvault node scripts/rotate-encryption-key.mjs --old-key-file /run/secrets/blackvault_encryption_key --new-key-file /run/secrets/blackvault_encryption_key.new")) "ran the rotation with the exact command, keys read from /run/secrets"
Assert ($r.StubLog -match "compose start blackvault") "restarted BlackVault"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no stray .new file after a successful swap"
# I2: the previous key is kept under a TIMESTAMPED name, never the bare ".old"
# (a second rotation must never silently overwrite the file the pre-rotation
# snapshot is sealed under).
$oldFiles = @(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*")
Assert ($oldFiles.Count -eq 1) "exactly one timestamped .old-<YYYYmmdd-HHMMSS> file was created (got $($oldFiles.Count))"
Assert ($oldFiles[0].Name -match "^blackvault_encryption_key\.old-\d{8}-\d{6}") "the .old file name matches the YYYYmmdd-HHMMSS pattern"
Assert ((Get-Content $oldFiles[0].FullName -Raw).Trim() -eq $keyBefore.Trim()) "the timestamped .old file holds the ORIGINAL key"
$keyAfter = (Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw).Trim()
Assert ($keyAfter -match "^[0-9a-f]{64}$") "the active key file is now 64 lowercase hex chars (real CSPRNG path)"
Assert ($keyAfter -ne $keyBefore.Trim()) "the active key actually changed"
Assert ($r.Output -notmatch [regex]::Escape($keyAfter)) "the new key is never echoed to the terminal"
Assert ($r.Output -match "Key rotation complete") "prints the completion banner"
Assert ($r.Output -match "Back up secrets\\blackvault_encryption_key now\.") "tells the admin to back up the active key"
Assert ($r.Output -match [regex]::Escape("now saved as secrets\$($oldFiles[0].Name)")) "names the exact .old file the pre-rotation snapshot needs"
Assert ($r.Output -match "can only be opened with it") "says the snapshot can only be opened with the .old key, so it must be kept"
# M5: assert the active key file's ACL was actually restricted (M2: applied
# to the file BEFORE content was written; `move` preserves it across the rename).
$acl = Get-Acl (Join-Path $d "secrets\blackvault_encryption_key")
Assert ($acl.AreAccessRulesProtected) "inheritance is disabled on the active key file (icacls /inheritance:r took effect)"
# N5: compare SIDs with SIDs. $acl.Access yields NTAccount identities, which
# never -eq the SecurityIdentifier from WindowsIdentity.
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$grant = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object {
  $_.IdentityReference.Value -eq $currentSid -and
  $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  -not $_.IsInherited -and
  (($_.FileSystemRights -band $fullControl) -eq $fullControl)
})
Assert ($grant.Count -gt 0) "the current user's SID has an explicit, non-inherited Full Control grant on the active key file"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RK6
Write-Scenario "rotate-key.bat - rotation run fails, probe confirms OLD: sets .new aside as .new.unused-<ts> (never deleted), restarts on the OLD key, exits 1"
$d = New-RotateSandbox "rotate-run-fails-old" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_ANSWER" = "OLD" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose run") "attempted the rotation"
Assert ($r.Output -match "Confirmed: the database is still encrypted with the OLD key") "reports the probe's OLD answer"
Assert ($r.StubLog -match "compose start blackvault") "restarted BlackVault on the previous key"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "the .new name is free again for the next rotation"
# N2 (ruling): the wrappers never delete a key file; the unused one is renamed.
$unused = @(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.new.unused-*")
Assert ($unused.Count -eq 1) "exactly one .new.unused-<ts> file was kept (got $($unused.Count))"
if ($unused.Count -eq 1) {
  Assert ($unused[0].Name -match "^blackvault_encryption_key\.new\.unused-\d{8}-\d{6}") "the .new.unused file name matches the YYYYmmdd-HHMMSS pattern"
  Assert ((Get-Content $unused[0].FullName -Raw).Trim() -match "^[0-9a-f]{64}$") "the .new.unused file holds the generated key (64 hex chars)"
  Assert ($r.Output -match [regex]::Escape("set aside as secrets\$($unused[0].Name)")) "names the exact .new.unused file"
}
Assert ($r.Output -match "can be deleted once BlackVault has run normally") "says when the unused key can be deleted"
Assert (@(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*").Count -eq 0) "no .old file: the original key was never renamed"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the original key file is byte-for-byte unchanged"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK6b
Write-Scenario "rotate-key.bat - rotation run fails, probe confirms NEW: completes the swap anyway, exits 0 (fix round 1, C1)"
$d = New-RotateSandbox "rotate-run-fails-new" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_ANSWER" = "NEW" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode)) — the transaction had already committed"
Assert ($r.Output -match "Confirmed: the database is already encrypted with the NEW key") "reports the probe's NEW answer"
Assert ($r.Output -match "Key rotation complete") "completes the swap exactly like a normal success"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no stray .new file after the swap"
Assert (@(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*").Count -eq 1) "the original key was kept under a timestamped .old- name"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw).Trim() -ne $keyBefore.Trim()) "the active key file now holds the NEW key"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK6c
Write-Scenario "rotate-key.bat - rotation run fails and the probe cannot tell (NEITHER): keeps every key file, does NOT restart, exits 1 (fix round 1, C1)"
$d = New-RotateSandbox "rotate-run-fails-ambiguous" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_ANSWER" = "NEITHER" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "could not determine whether the database is encrypted with the OLD") "explains it could not tell"
Assert ($r.Output -match "Nothing was deleted\. BlackVault was NOT restarted\.") "says nothing was deleted and the app was not restarted"
Assert ($r.StubLog -notmatch "compose start blackvault") "did NOT restart — an ambiguous state must not be papered over"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new")) ".new is KEPT (never deleted on an ambiguous failure)"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the original key file is untouched"
Assert (@(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*").Count -eq 0) "no .old file: no rename was attempted"
Assert ($r.Output -match [regex]::Escape("--probe")) "prints the exact recovery command to re-run"
# N4: the probe command must be ONE copy-pasteable line (a trailing ^ used to
# join the following echo lines into it, printing literal "echo" words).
$probeLines = @($r.Output -split "`r?`n" | Where-Object { $_ -match [regex]::Escape("--probe") })
$probeCmd = "docker compose run --rm blackvault node scripts/rotate-encryption-key.mjs --probe --old-key-file /run/secrets/blackvault_encryption_key --new-key-file /run/secrets/blackvault_encryption_key.new"
Assert ($probeLines.Count -eq 1) "the probe command is printed on exactly one line (got $($probeLines.Count))"
Assert (($probeLines.Count -eq 1) -and ($probeLines[0].Trim() -ceq $probeCmd)) "that line is exactly the runnable probe command, nothing else on it"
# N1: step 2 moves the OLD key aside BEFORE moving .new into place.
$mOld = [regex]::Match($r.Output, '(?m)^\s*move /y secrets\\blackvault_encryption_key secrets\\blackvault_encryption_key\.old-\d{8}-\d{6}\r?$')
$mNew = [regex]::Match($r.Output, '(?m)^\s*move /y secrets\\blackvault_encryption_key\.new secrets\\blackvault_encryption_key\r?$')
Assert ($mOld.Success -and $mNew.Success -and $mOld.Index -lt $mNew.Index) "NEW recovery: moves the OLD key to .old-<ts> first, then .new into place"
# N2: step 3 renames, never deletes.
Assert ($r.Output -match '(?m)^\s*move /y secrets\\blackvault_encryption_key\.new secrets\\blackvault_encryption_key\.new\.unused-\d{8}-\d{6}\r?$') "OLD recovery: renames .new to .new.unused-<ts>"
Assert ($r.Output -notmatch '(?m)^\s*del ') "no recovery line deletes a key file"
# Final review F5: the NEITHER answer has its own recovery step.
Assert ($r.Output -match "4\. If it answers NEITHER: secrets\\blackvault_encryption_key is not this database's key\.") "recovery text has step 4 for a NEITHER answer"
Assert ($r.Output -match "Restore the right key file as secrets\\blackvault_encryption_key, then run the probe again\.") "step 4 says to restore the right key file and probe again"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK6e
Write-Scenario "rotate-key.bat - the rotation refuses up front (exit 3, wrong key file): no probe, .new set aside, key untouched, NOT restarted (final review F5)"
$d = New-RotateSandbox "rotate-refused-exit3" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_RUN_EXIT" = "3"; "BV_STUB_PROBE_ANSWER" = "NEITHER" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: secrets\\blackvault_encryption_key does not open this database \(wrong or replaced key\)\.") "says the current key file is not this database's key"
Assert ($r.Output -match "Nothing was changed\. BlackVault was NOT restarted\.") "says nothing changed and the app was not restarted"
Assert ($r.Output -match "startup log names its key id") "points at the startup log's key id"
Assert ($r.StubLog -notmatch "--probe") "did NOT run the probe (it would only answer NEITHER)"
Assert ($r.StubLog -notmatch "compose start blackvault") "did NOT restart"
$unused = @(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.new.unused-*")
Assert ($unused.Count -eq 1) "the unused .new was set aside as .new.unused-<ts> (got $($unused.Count))"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "the .new name is free again"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the active key file is byte-for-byte unchanged"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK6d
Write-Scenario "rotate-key.bat - the probe itself fails (no answer): same ambiguous handling as NEITHER"
$d = New-RotateSandbox "rotate-run-fails-probe-fails" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_STATUS" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.StubLog -notmatch "compose start blackvault") "did NOT restart"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new")) ".new is KEPT when the probe itself fails"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the original key file is untouched"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RK7
Write-Scenario "rotate-key.bat - the key-file swap itself fails (locked file): exact recovery text, no restart, exits 1 (I1)"
$d = New-RotateSandbox "rotate-swap-fails" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$keyPath = Join-Path $d "secrets\blackvault_encryption_key"
# Holds an exclusive lock on the active key file for the run's duration, so
# `move /y` on it fails with a real Windows sharing violation — the one
# Windows failure window task-6-review.md flagged as untested.
$lockFlag = Join-Path $Sandboxes "rotate-swap-fails.locked"
$lockJob = Start-FileLockJob -Path $keyPath -Flag $lockFlag
try {
  Assert (Wait-ForFile $lockFlag 60) "the lock job holds its lock before the run starts (polled, not a fixed sleep)"
  $r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
} finally {
  Stop-FileLockJob $lockJob $lockFlag
}
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "rotation succeeded, but renaming the key files failed") "names the swap failure precisely (not a generic error)"
Assert ($r.Output -match "move /y .*blackvault_encryption_key\.new.*blackvault_encryption_key") "prints the exact recovery command (the expanded move /y .new -> active path)"
Assert ($r.StubLog -notmatch "compose start blackvault") "did NOT restart on an unresolved swap failure"
Assert ((Get-Content $keyPath -Raw) -eq $keyBefore) "the active key file still holds the ORIGINAL key (the first move never completed)"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new")) ".new still holds the key the database is now actually encrypted with"
Assert (@(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*").Count -eq 0) "no .old file was created (the first move failed before renaming anything)"
# N1: the OLD key is moved aside first, then .new into place.
$mOld = [regex]::Match($r.Output, '(?m)^\s*move /y secrets\\blackvault_encryption_key secrets\\blackvault_encryption_key\.old-\d{8}-\d{6}\r?$')
$mNew = [regex]::Match($r.Output, '(?m)^\s*move /y secrets\\blackvault_encryption_key\.new secrets\\blackvault_encryption_key\r?$')
Assert ($mOld.Success -and $mNew.Success -and $mOld.Index -lt $mNew.Index) "recovery text moves the OLD key to .old-<ts> BEFORE moving .new into place"
# Follow the printed lines literally (lock released): the OLD key must survive.
$newKey = (Get-Content (Join-Path $d "secrets\blackvault_encryption_key.new") -Raw).Trim()
$ran = Invoke-PrintedMoves -Dir $d -Output $r.Output
Assert ($ran -eq 2) "the recovery text holds exactly two move commands (got $ran)"
$oldFiles = @(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*")
Assert ($oldFiles.Count -eq 1 -and (Get-Content $oldFiles[0].FullName -Raw).Trim() -eq $keyBefore.Trim()) "after following the text: .old-<ts> holds the ORIGINAL key (the pre-rotation snapshot stays openable)"
Assert ((Get-Content $keyPath -Raw).Trim() -eq $newKey) "after following the text: the active key file holds the key the database is encrypted with"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "after following the text: no .new left"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK7b
Write-Scenario "rotate-key.bat - the SECOND key-file move fails (.new locked): :swap_failed_2 text, no restart, exits 1 (fix round 2, N5)"
$d = New-RotateSandbox "rotate-swap2-fails" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$keyPath = Join-Path $d "secrets\blackvault_encryption_key"
$newPath = Join-Path $d "secrets\blackvault_encryption_key.new"
# The stub's rotation run signals .ready (after the .bat has written .new),
# the job locks .new and writes .ack, and only then does the run return - so
# the first move (active -> .old-<ts>) succeeds and the second (.new ->
# active) hits a sharing violation. No timing guesses.
$hs = Join-Path $Sandboxes "rotate-swap2-fails.hs"
$lockJob = Start-FileLockJob -Path $newPath -Flag "$hs.ack" -WaitFor "$hs.ready"
try {
  $r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_RUN_HANDSHAKE" = $hs }
} finally {
  Stop-FileLockJob $lockJob "$hs.ack"
}
Assert (Test-Path "$hs.ack") "the lock on .new was taken during the rotation run (handshake completed)"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "rotation succeeded, but finishing the key-file swap failed") "names the second-move failure precisely"
Assert ($r.StubLog -notmatch "compose start blackvault") "did NOT restart"
Assert (-not (Test-Path $keyPath)) "the active key file is missing (moved to .old-<ts>), as the text says"
$oldFiles = @(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*")
Assert ($oldFiles.Count -eq 1 -and (Get-Content $oldFiles[0].FullName -Raw).Trim() -eq $keyBefore.Trim()) "the .old-<ts> file holds the ORIGINAL key"
Assert (Test-Path $newPath) ".new still holds the key the database is now encrypted with"
$mNew = [regex]::Match($r.Output, '(?m)^\s*move /y secrets\\blackvault_encryption_key\.new secrets\\blackvault_encryption_key\r?$')
Assert $mNew.Success "prints the exact recovery move (.new -> active)"
$newKey = if (Test-Path $newPath) { (Get-Content $newPath -Raw).Trim() } else { "" }
$ran = Invoke-PrintedMoves -Dir $d -Output $r.Output
Assert ($ran -eq 1) "the recovery text holds exactly one move command (got $ran)"
Assert ((Test-Path $keyPath) -and (Get-Content $keyPath -Raw).Trim() -eq $newKey) "after following the text: the active key file holds the database's key"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK7c
Write-Scenario "rotate-key.bat - rotation and swap succeed but the restart fails: :restart_after_swap_failed, no 'complete' banner, exits 1 (fix round 2, N5)"
$d = New-RotateSandbox "rotate-restart-fails" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "start" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose start blackvault") "tried to restart"
Assert ($r.Output -match "Key rotation succeeded and the key files were swapped, but BlackVault") "says the rotation and swap succeeded"
Assert ($r.Output -match "failed to restart") "says the restart failed"
Assert ($r.Output -notmatch "Key rotation complete") "no completion banner"
$oldFiles = @(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.old-*")
Assert ($oldFiles.Count -eq 1 -and (Get-Content $oldFiles[0].FullName -Raw).Trim() -eq $keyBefore.Trim()) "the .old-<ts> file holds the ORIGINAL key"
Assert ($oldFiles.Count -eq 1 -and $r.Output -match [regex]::Escape($oldFiles[0].Name)) "names the exact .old-<ts> file to keep"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw).Trim() -ne $keyBefore.Trim()) "the active key file holds the NEW key"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no .new left"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RK8
Write-Scenario "rotate-key.bat - a stale .new from an earlier run exists: refuses before stopping anything, never touches it (fix round 2, N2)"
$d = New-RotateSandbox "rotate-stale-new" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$stale = Join-Path $d "secrets\blackvault_encryption_key.new"
Set-Content -Path $stale -Value ("cd" * 32) -NoNewline -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "already exists, left by an earlier rotation") "explains the stale .new"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked (nothing stopped)"
Assert ((Get-Content $stale -Raw) -eq ("cd" * 32)) "the stale .new is byte-for-byte unchanged"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the active key file is untouched"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RK9
Write-Scenario "rotate-key.bat - the key is held in BLACKVAULT_ENCRYPTION_KEY (.env): refuses before stopping anything (final review N1)"
$d = New-RotateSandbox "rotate-envkey-file" -WithSnapshot
Set-Content -Path (Join-Path $d ".env") -Value ("BLACKVAULT_ENCRYPTION_KEY=" + ("cd" * 32)) -Encoding Ascii
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "Key rotation works on secrets\\blackvault_encryption_key\. Your key is in") "explains rotation works on the key file"
Assert ($r.Output -match "BLACKVAULT_ENCRYPTION_KEY \(from \.env\): move it into that file") "names .env as the source"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked (nothing stopped)"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the key file is untouched"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no .new written"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK9b
Write-Scenario "rotate-key.bat - BLACKVAULT_ENCRYPTION_KEY set in the console: refuses the same way (final review N1)"
$d = New-RotateSandbox "rotate-envkey-console" -WithSnapshot
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BLACKVAULT_ENCRYPTION_KEY" = ("cd" * 32) }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "BLACKVAULT_ENCRYPTION_KEY \(from the console environment\): move it into that file") "names the console as the source"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked (nothing stopped)"
Show-EvidenceIfFailed $r

# =============================================================================
#            field encryption (Task 7): key file, pre-upgrade snapshot
# =============================================================================
$BoxLine = "BACK THIS FILE UP. Without it your serial numbers and NFA records cannot be recovered."

# True when $Path has inheritance disabled and an explicit, non-inherited
# Full Control grant for the current user's SID (compared as SIDs, as RK5).
function Test-UserOnlyAcl([string]$Path) {
  if (-not (Test-Path $Path)) { return $false }
  $acl = Get-Acl $Path
  if (-not $acl.AreAccessRulesProtected) { return $false }
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  $grant = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | Where-Object {
    $_.IdentityReference.Value -eq $sid -and
    $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    -not $_.IsInherited -and
    (($_.FileSystemRights -band $full) -eq $full)
  })
  return ($grant.Count -gt 0)
}

# Index of the first stub-log line equal to (or, with -Prefix, starting
# with) $Text; -1 when absent. The stub logs one invocation per line.
function Get-CallIndex([string]$Log, [string]$Text, [switch]$Prefix) {
  $lines = @($Log -split "`r?`n")
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($Prefix) { if ($lines[$i].StartsWith($Text)) { return $i } }
    elseif ($lines[$i] -ceq $Text) { return $i }
  }
  return -1
}

function Get-Backups([string]$Dir) {
  $b = Join-Path $Dir "backups"
  if (-not (Test-Path $b)) { return @() }
  return @(Get-ChildItem $b -File | Sort-Object Name | ForEach-Object { $_.Name })
}

# ---------------------------------------------------------------- scenario K1
Write-Scenario "install.bat - fresh install creates secrets\blackvault_encryption_key: 64 hex, user-only ACL, boxed message, before the build"
$d = New-Sandbox "key-install"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2")
$keyPath = Join-Path $d "secrets\blackvault_encryption_key"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (Test-Path $keyPath) "the key file exists"
$key = if (Test-Path $keyPath) { (Get-Content $keyPath -Raw).Trim() } else { "" }
Assert ($key -cmatch "^[0-9a-f]{64}$") "the key is exactly 64 lowercase hex characters (real CSPRNG path)"
Assert (Test-UserOnlyAcl $keyPath) "the key file is restricted to the current user (inheritance off, explicit Full Control)"
Assert ($r.Output.Contains($BoxLine)) "prints the back-up sentence on one line"
Assert ($r.Output -match "Encryption key created: .*secrets\\blackvault_encryption_key") "names the key file"
Assert (($key -ne "") -and ($r.Output -notmatch $key)) "the key is never echoed"
$iKey = $r.Output.IndexOf("Encryption key created")
$iBuild = $r.Output.IndexOf("Building BlackVault image")
Assert (($iKey -ge 0) -and ($iBuild -gt $iKey)) "the key is created before the image is built"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario K2
Write-Scenario "install.bat - never overwrites an existing key file"
$d = New-Sandbox "key-install-existing"
New-Item -ItemType Directory -Force -Path (Join-Path $d "secrets") | Out-Null
$keyPath = Join-Path $d "secrets\blackvault_encryption_key"
Set-Content -Path $keyPath -Value ("cd" * 32) -NoNewline -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-Content $keyPath -Raw) -eq ("cd" * 32)) "the key file is byte-for-byte unchanged"
Assert ($r.Output -match "existing, unchanged") "says the existing key was kept"
Assert (-not $r.Output.Contains($BoxLine)) "no new-key message"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario K3
Write-Scenario "install.bat - re-run over a configured install creates the missing key before starting"
$d = New-Sandbox "key-install-rerun"
Set-SqliteInstall $d "7030"
$r = Invoke-Bat -Dir $d -Script "install.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key")) "the key file was created"
Assert ($r.Output.Contains($BoxLine)) "prints the back-up sentence"
Assert ($r.StubLog -match "compose up -d") "started the existing configuration"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario K4
Write-Scenario "install.bat - re-run with the key in .env (BLACKVAULT_ENCRYPTION_KEY): NO key file is created (final review N1)"
$d = New-Sandbox "key-install-envkey"
Set-SqliteInstall $d "7093"
Add-Content -Path (Join-Path $d ".env") -Value ("BLACKVAULT_ENCRYPTION_KEY=" + ("cd" * 32)) -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "install.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key"))) "no key file was created (a second key would be KEY_CONFLICT)"
Assert ($r.Output -match "Encryption key: BLACKVAULT_ENCRYPTION_KEY \(from \.env\) - no key file created") "says the .env key is in use"
Assert (-not $r.Output.Contains($BoxLine)) "no new-key message"
Assert ($r.StubLog -match "compose up -d") "started the existing configuration"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario U1
Write-Scenario "update.bat - SQLite: key created, snapshot copied into backups\ AFTER the build and BEFORE the new image starts"
$origin = New-GitRemote "key-update-sqlite" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "key-update-sqlite"
Set-SqliteInstall $work "7031"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (Test-Path (Join-Path $work "secrets\blackvault_encryption_key")) "the key file was created"
Assert ($r.Output.Contains($BoxLine)) "prints the back-up sentence"
$snaps = @(Get-Backups $work)
Assert ($snaps.Count -eq 1 -and $snaps[0] -match "^blackvault-\d{8}-\d{6}\.db$") "one snapshot backups\blackvault-<ts>.db (got: $($snaps -join ', '))"
if ($snaps.Count -eq 1) {
  $same = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $work "backups\$($snaps[0])"))) -eq
          [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $work "data\db\vault.db")))
  Assert $same "the snapshot is a byte-for-byte copy of vault.db"
  Assert ($r.Output -match [regex]::Escape("Database snapshot saved: backups\$($snaps[0])")) "prints the snapshot path"
}
Assert (Test-UserOnlyAcl (Join-Path $work "backups")) "backups\ is restricted to the current user"
Assert ($r.Output -match "this snapshot is a plain, unencrypted copy") "prints the plaintext warning"
$iBuild = Get-CallIndex $r.StubLog "compose build --pull"
$iStop = Get-CallIndex $r.StubLog "compose stop blackvault"
$iUp = Get-CallIndex $r.StubLog "compose up -d"
Assert (($iBuild -ge 0) -and ($iStop -gt $iBuild) -and ($iUp -gt $iStop)) "order: build, stop (snapshot), up -d (got $iBuild, $iStop, $iUp)"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario U1b
Write-Scenario "update.bat - the key is in .env (BLACKVAULT_ENCRYPTION_KEY): NO key file is created, the update completes (final review N1)"
$origin = New-GitRemote "key-update-envkey" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "key-update-envkey"
Set-SqliteInstall $work "7094"
Add-Content -Path (Join-Path $work ".env") -Value ("BLACKVAULT_ENCRYPTION_KEY=" + ("cd" * 32)) -Encoding Ascii
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (-not (Test-Path (Join-Path $work "secrets\blackvault_encryption_key"))) "no key file was created"
Assert ($r.Output -match "Encryption key: BLACKVAULT_ENCRYPTION_KEY \(from \.env\) - no key file created") "says the .env key is in use"
Assert ($r.StubLog -match "compose up -d") "started the new image"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario U2
Write-Scenario "update.bat - the snapshot fails: exits 1, never starts the new image, starts the old container again"
$origin = New-GitRemote "key-update-snapfail" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "key-update-snapfail"
Set-SqliteInstall $work "7032"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "") -EnvVars @{ "BV_STUB_FAIL_ON" = "stop" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "database snapshot failed: could not stop BlackVault") "db-snapshot.bat names the failure"
Assert ($r.Output -match "the update stopped here") "update.bat says it stopped"
Assert ((Get-CallIndex $r.StubLog "compose up -d") -eq -1) "the new image was never started (no 'compose up -d')"
Assert ((Get-CallIndex $r.StubLog "compose start blackvault") -ge 0) "the old container was started again"
Assert (@(Get-Backups $work).Count -eq 0) "no snapshot file left behind"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario U3
Write-Scenario "update.bat - PostgreSQL: pg_dump through the db container into backups\blackvault-<ts>.sql before the start"
$origin = New-GitRemote "key-update-pg" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "key-update-pg"
New-Item -ItemType Directory -Force -Path (Join-Path $work "data\postgres") | Out-Null
$pgpw = "ab" * 24
@("DATA_DIR=$work\data", "PORT=3000", "COMPOSE_PROFILES=postgres", "BLACKVAULT_DB_PROVIDER=postgres",
  "BLACKVAULT_POSTGRES_PASSWORD=$pgpw", "BLACKVAULT_DATABASE_URL=postgresql://blackvault:$pgpw@db:5432/blackvault",
  "BLACKVAULT_PUBLIC_URL=https://vault.example.com", "BLACKVAULT_TRUSTED_PROXIES=", "BLACKVAULT_DIRECT_ACCESS_INITIAL=on") |
  Set-Content -Path (Join-Path $work ".env") -Encoding Ascii
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$snaps = @(Get-Backups $work)
Assert ($snaps.Count -eq 1 -and $snaps[0] -match "^blackvault-\d{8}-\d{6}\.sql$") "one snapshot backups\blackvault-<ts>.sql (got: $($snaps -join ', '))"
if ($snaps.Count -eq 1) {
  Assert ((Get-Content (Join-Path $work "backups\$($snaps[0])") -Raw) -match "compose exec -T db pg_dump") "the .sql holds what pg_dump printed (the stub echoes its command)"
}
$iDump = Get-CallIndex $r.StubLog "compose exec -T db pg_dump -U blackvault -d blackvault"
$iUp = Get-CallIndex $r.StubLog "compose up -d"
Assert ((Get-CallIndex $r.StubLog "compose up -d --wait db") -ge 0) "made sure the db container is running"
Assert (($iDump -ge 0) -and ($iUp -gt $iDump)) "pg_dump ran before the app start (got $iDump, $iUp)"
Assert ((Get-CallIndex $r.StubLog "compose stop blackvault") -eq -1) "PostgreSQL: the app was not stopped for the dump"
Assert ($r.Output -match "this snapshot is a plain, unencrypted copy") "prints the plaintext warning"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario U4
Write-Scenario "update.bat - PostgreSQL: pg_dump fails: exits 1, no partial file, never starts the new image"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_FAIL_ON" = "exec" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "database snapshot failed: pg_dump failed") "names the failure"
Assert ((Get-CallIndex $r.StubLog "compose up -d") -eq -1) "the new image was never started"
Assert (@(Get-ChildItem (Join-Path $work "backups") -Filter "*.partial" -ErrorAction SilentlyContinue).Count -eq 0) "no .partial file left"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario 10c
Write-Scenario "update.bat - FIRST HOP: develop's update.bat (663523c) pulls this release and its resumed run creates the key and the snapshot"
# cmd.exe resumes the NEW file at the byte past the OLD file's `git pull`
# line (scenario 10b), so everything after the pull is the new code even on
# the first upgrade. This is the Windows answer to "the old script runs the
# upgrade" (update.sh re-executes itself instead).
$oldBat3 = Join-Path $Sandboxes "old-update-663523c.bat"
& cmd.exe /c "git -C ""$RepoRoot"" show 663523c:update.bat > ""$oldBat3"""
if ((-not (Test-Path $oldBat3)) -or ((Get-Item $oldBat3).Length -lt 7000)) {
  throw "Could not extract 663523c:update.bat (the Windows job needs fetch-depth: 0)."
}
$origin = New-GitRemote "key-update-first-hop" $oldBat3
$work = New-WorkingClone $origin "key-update-first-hop"
Set-SqliteInstall $work "7033"
Add-RemoteCommit $origin (Join-Path $RepoRoot "update.bat")
$onDiskBefore = (Get-Content (Join-Path $work "update.bat") -Raw)
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
$onDiskAfter = (Get-Content (Join-Path $work "update.bat") -Raw)
Assert ($onDiskBefore -notmatch "ensure_encryption_key") "the script that started is the old one (premise)"
Assert ($onDiskAfter -match "ensure_encryption_key") "the pull replaced it with this release's update.bat (premise)"
Assert ($r.ExitCode -eq 0) "cmd.exe survived the swap and exited 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert (Test-Path (Join-Path $work "secrets\blackvault_encryption_key")) "the key file was created on the first hop"
$snaps = @(Get-Backups $work)
Assert ($snaps.Count -eq 1) "a snapshot was taken on the first hop (got: $($snaps -join ', '))"
$iStop = Get-CallIndex $r.StubLog "compose stop blackvault"
$iUp = Get-CallIndex $r.StubLog "compose up -d"
Assert (($iStop -ge 0) -and ($iUp -gt $iStop)) "snapshot before the new image started (got $iStop, $iUp)"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario DS1
Write-Scenario "scripts\db-snapshot.bat called by another script: returns its errorlevel, leaves the caller's folder and variables alone, never pauses"
$d = New-Sandbox "db-snapshot-call"
Set-SqliteInstall $d "7034"
@("@echo off", "setlocal EnableDelayedExpansion", "set ""DB_PROVIDER=caller-value""", "set ""OUT=caller-out""",
  "call scripts\db-snapshot.bat", "echo RC=!errorlevel!", "echo CWD=!CD!", "echo VARS=!DB_PROVIDER!/!OUT!") |
  Set-Content -Path (Join-Path $d "caller.bat") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad
Assert ($r.Output -match "RC=0") "errorlevel 0 on success"
Assert ($r.Output -match ("CWD=" + [regex]::Escape($d) + "\r?\n")) "the caller's current folder is unchanged"
Assert ($r.Output -match "VARS=caller-value/caller-out") "the caller's variables are unchanged (setlocal)"
Assert (@(Get-Backups $d).Count -eq 1) "wrote one snapshot"
Assert ((Get-CallIndex $r.StubLog "compose start" -Prefix) -eq -1) "did not start the app again (the caller decides)"
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad -EnvVars @{ "BV_STUB_FAIL_ON" = "stop" }
Assert ($r.Output -match "RC=1") "errorlevel 1 when the app cannot be stopped"
Assert ($r.Output -match ("CWD=" + [regex]::Escape($d) + "\r?\n")) "the caller's folder is unchanged on failure too"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario E1
# Fix round 1 (I4). Releases before this one stored install.bat/update.bat
# with CRLF IN THE INDEX under `*.bat text eol=crlf`, so Git reports them
# modified and a pull that changes them aborts. update.bat's
# :clear_eol_only_change must let that pull through without rewriting a byte.
function Set-CrlfIndexedBats([string]$Repo, [string]$Message) {
  foreach ($f in @("install.bat", "update.bat")) {
    $sha = (& git -C $Repo hash-object -w --no-filters $f).Trim()
    & git -C $Repo update-index --add --cacheinfo "100644,$sha,$f" | Out-Null
  }
  & git -C $Repo -c user.name=ci -c user.email=ci@example.com commit -q -m $Message | Out-Null
}
function Set-PastMtime([string]$Dir) {
  foreach ($f in @("install.bat", "update.bat")) { (Get-Item (Join-Path $Dir $f)).LastWriteTime = (Get-Date).AddMinutes(-1) }
}
function New-CrlfIndexRemote([string]$Name, [string]$UpdateBatSource = (Join-Path $RepoRoot "update.bat")) {
  $origin = New-GitRemote $Name $UpdateBatSource
  Set-Content -Path (Join-Path $origin ".gitattributes") -Value "*.bat text eol=crlf" -Encoding Ascii
  & git -C $origin add .gitattributes | Out-Null
  Set-CrlfIndexedBats $origin "bat files with CRLF in the index"
  return $origin
}
function Add-CrlfBatChange([string]$Origin) {
  foreach ($f in @("install.bat", "update.bat")) { Add-Content -Path (Join-Path $Origin $f) -Value ":: a newer release" -Encoding Ascii }
  Set-CrlfIndexedBats $Origin "a newer release changes both .bat files"
}

Write-Scenario "update.bat - CRLF in the index, line endings only: the pull of a release changing both .bat files goes through (fix round 1, I4)"
$origin = New-CrlfIndexRemote "eol-only"
$work = New-WorkingClone $origin "eol-only"
Set-SqliteInstall $work "7040"
Set-PastMtime $work
$porcelain = (& git -C $work status --porcelain -- install.bat update.bat) -join "`n"
Assert ($porcelain -match "M install\.bat" -and $porcelain -match "M update\.bat") "premise: Git reports both files modified (got '$porcelain')"
Add-CrlfBatChange $origin
$headBefore = (& git -C $work rev-parse HEAD)
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.Output -match "Clearing a line-ending-only difference") "says it is clearing the line-ending-only difference"
Assert ($r.Output -notmatch "would be overwritten") "the pull did not abort"
Assert ((& git -C $work rev-parse HEAD) -ne $headBefore) "git pull advanced HEAD"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert (-not (Test-Path (Join-Path $work ".git\info\attributes"))) "the temporary attributes override is gone"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario E2
Write-Scenario "update.bat - a REAL local edit to install.bat is left alone (fix round 1, I4)"
$origin = New-CrlfIndexRemote "eol-real-edit"
$work = New-WorkingClone $origin "eol-real-edit"
Set-SqliteInstall $work "7041"
Set-PastMtime $work
Add-Content -Path (Join-Path $work "install.bat") -Value ":: my local tweak" -Encoding Ascii
Add-CrlfBatChange $origin
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.Output -match "has local edits; they are left alone") "says the local edits are left alone"
Assert ($r.Output -notmatch "Clearing a line-ending-only difference") "did not touch Git's view of the files"
Assert ((Get-Content (Join-Path $work "install.bat") -Raw) -match ":: my local tweak") "the local edit survived"
Assert ($r.ExitCode -eq 1) "the pull refused, so update.bat stops with 1 (got $($r.ExitCode))"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario E3
Write-Scenario "update.bat - self-heal: override lines left by an interrupted run are stripped first, the rest kept (fix round 2)"
$origin = New-CrlfIndexRemote "eol-heal"
$work = New-WorkingClone $origin "eol-heal"
Set-SqliteInstall $work "7042"
$attrs = Join-Path $work ".git\info\attributes"
New-Item -ItemType Directory -Force -Path (Split-Path $attrs -Parent) | Out-Null
[IO.File]::WriteAllText($attrs, "*.png binary`r`ninstall.bat -text blackvault-update`r`nupdate.bat -text blackvault-update`r`n", [Text.Encoding]::ASCII)
Set-Content -Path "$attrs.blackvault-update" -Value "stale backup" -Encoding Ascii
$attrBefore = (& git -C $work check-attr text -- install.bat)
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($attrBefore -match "text: unset") "premise: the leftover override was in effect (got '$attrBefore')"
Assert ($r.Output -match "Removing a line-ending override left in") "says it removed the leftover override"
Assert ((Test-Path $attrs) -and ([IO.File]::ReadAllText($attrs) -eq "*.png binary`r`n")) "only the marked lines were removed (got '$(if (Test-Path $attrs) { [IO.File]::ReadAllText($attrs) })')"
Assert (-not (Test-Path "$attrs.blackvault-update")) "the stale backup is gone"
Assert ((& git -C $work check-attr text -- install.bat) -match "text: set") "install.bat is text again, so it checks out CRLF"
# A checkout of an LF blob comes out CRLF again.
& git -C $work add --renormalize install.bat | Out-Null
& git -C $work -c user.name=ci -c user.email=ci@example.com commit -q -m "renormalize" | Out-Null
Remove-Item (Join-Path $work "install.bat")
& git -C $work checkout -- install.bat | Out-Null
$ib = [IO.File]::ReadAllBytes((Join-Path $work "install.bat"))
$crlf = 0; for ($i = 1; $i -lt $ib.Length; $i++) { if ($ib[$i] -eq 10 -and $ib[$i - 1] -eq 13) { $crlf++ } }
$lf = 0; for ($i = 0; $i -lt $ib.Length; $i++) { if ($ib[$i] -eq 10) { $lf++ } }
Assert (($lf -gt 0) -and ($crlf -eq $lf)) "a fresh checkout of install.bat is all CRLF ($crlf of $lf line ends)"
Show-EvidenceIfFailed $r

Write-Scenario "update.bat - self-heal: a file holding ONLY override lines is removed (fix round 2)"
$origin = New-CrlfIndexRemote "eol-heal-only"
$work = New-WorkingClone $origin "eol-heal-only"
Set-SqliteInstall $work "7043"
$attrs = Join-Path $work ".git\info\attributes"
New-Item -ItemType Directory -Force -Path (Split-Path $attrs -Parent) | Out-Null
[IO.File]::WriteAllText($attrs, "install.bat -text blackvault-update`r`nupdate.bat -text blackvault-update`r`n", [Text.Encoding]::ASCII)
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert (-not (Test-Path $attrs)) "the attributes file, which only held our lines, is gone"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario E4
Write-Scenario "update.bat - the attributes backup cannot be written (backup path locked): skips the fix, leaves the file untouched, no override left (fix round 2)"
$origin = New-CrlfIndexRemote "eol-copy-fails"
$work = New-WorkingClone $origin "eol-copy-fails"
Set-SqliteInstall $work "7044"
$attrs = Join-Path $work ".git\info\attributes"
New-Item -ItemType Directory -Force -Path (Split-Path $attrs -Parent) | Out-Null
[IO.File]::WriteAllText($attrs, "*.png binary`r`n", [Text.Encoding]::ASCII)
Set-PastMtime $work
Add-CrlfBatChange $origin
# Lock the BACKUP path (a leftover file the self-heal cannot delete while it
# is locked), so `copy /y` onto it fails; Git can still read the real file.
Set-Content -Path "$attrs.blackvault-update" -Value "locked leftover" -Encoding Ascii
$flag = Join-Path $Sandboxes "eol-copy-fails.lock"
$job = Start-FileLockJob "$attrs.blackvault-update" $flag
if (-not (Wait-ForFile $flag 60)) { throw "the lock job never took the lock" }
try {
  $r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
} finally {
  Stop-FileLockJob $job $flag
}
Assert ($r.Output -match "could not back up \.git\\info\\attributes, so the line-ending fix is skipped") "says the fix is skipped"
Assert ([IO.File]::ReadAllText($attrs) -eq "*.png binary`r`n") "the attributes file is byte-for-byte unchanged (no override line in it)"
Assert ($r.ExitCode -eq 1) "the pull then refuses as before, exit 1 (got $($r.ExitCode))"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario E5
Write-Scenario "update.bat - an attributes file without a final newline: the override still applies and the file is restored byte for byte (fix round 2)"
$origin = New-CrlfIndexRemote "eol-no-newline"
$work = New-WorkingClone $origin "eol-no-newline"
Set-SqliteInstall $work "7045"
$attrs = Join-Path $work ".git\info\attributes"
New-Item -ItemType Directory -Force -Path (Split-Path $attrs -Parent) | Out-Null
[IO.File]::WriteAllText($attrs, "*.png binary", [Text.Encoding]::ASCII)
Set-PastMtime $work
Add-CrlfBatChange $origin
$headBefore = (& git -C $work rev-parse HEAD)
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ((& git -C $work rev-parse HEAD) -ne $headBefore) "the override took effect: the pull went through"
Assert ([IO.File]::ReadAllText($attrs) -eq "*.png binary") "restored byte for byte (no newline added)"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Show-EvidenceIfFailed $r

# ──────────────────────────────────────────────────────────────────────────
# README one-time recovery command (fix round 1, I2): the README documents
# TWO commands (POSIX in README.md, and this Windows one), each wrapped in
# `<!-- readme-recovery-<platform>:start/end -->` HTML comments so a test can
# pull the ACTUAL documented text out of README.md and run it, instead of a
# hand-copied approximation that could silently drift from what a reader
# actually sees. scripts/installers-encryption.test.ts does the same for the
# POSIX block, from the same markers.
# ──────────────────────────────────────────────────────────────────────────
function Get-ReadmeBlock([string]$Marker) {
  $readme = Get-Content -Raw -Path (Join-Path $RepoRoot "README.md")
  $startTag = "<!-- readme-recovery-${Marker}:start -->"
  $endTag = "<!-- readme-recovery-${Marker}:end -->"
  $si = $readme.IndexOf($startTag)
  $ei = $readme.IndexOf($endTag)
  if ($si -lt 0 -or $ei -lt 0 -or $ei -le $si) {
    throw "README.md markers for '$Marker' not found or out of order (si=$si ei=$ei)"
  }
  $block = $readme.Substring($si + $startTag.Length, $ei - $si - $startTag.Length)
  $m = [regex]::Match($block, '```[a-z]*\r?\n(.*?)```', [Text.RegularExpressions.RegexOptions]::Singleline)
  if (-not $m.Success) { throw "No fenced code block found between the '$Marker' markers" }
  return $m.Groups[1].Value
}

# NOTE: uses $RepoRoot's REAL README.md, not New-GitRemote's placeholder one
# (New-GitRemote writes a one-line "v1"/"v2" README.md into the sandbox
# origin purely so the pull scenarios above have something trivial to
# change — the documented recovery command comes from this checkout's own
# README.md, same as a real reader would copy it from GitHub).
$windowsRecoveryBlock = Get-ReadmeBlock "windows"

# Final review FIX 5 (Task 8 MUST-FIX): E6/E7 start from the PRE-RELEASE
# update.bat (develop 663523c, kept byte for byte in scripts\fixtures), as
# every real reader's clone does. With the CURRENT update.bat in the clone a
# broken README block still passed: its failed `git pull` fell through to
# update.bat, which self-heals the line endings and pulls by itself. The
# 663523c update.bat cannot (its failed pull exits 1), so only a README block
# that really works gets the pull through. The pulled release is THIS tree's
# update.bat and install.bat, so the block's last line runs the new updater.
$PreReleaseUpdateBat = Join-Path $RepoRoot "scripts\fixtures\update.bat.develop-663523c"
function Add-ThisReleaseBats([string]$Origin) {
  foreach ($f in @("install.bat", "update.bat")) { Copy-Item (Join-Path $RepoRoot $f) (Join-Path $Origin $f) -Force }
  & git -C $Origin -c user.name=ci -c user.email=ci@example.com add install.bat update.bat | Out-Null
  & git -C $Origin -c user.name=ci -c user.email=ci@example.com commit -q -m "this release" | Out-Null
}
Assert ($windowsRecoveryBlock -match "git pull") "premise: the extracted Windows block contains a git pull (markers found real content)"
Assert ($windowsRecoveryBlock -match "update\.bat") "premise: the extracted Windows block runs update.bat"

# -------------------------------------------------------------- scenario E6
Write-Scenario "README recovery command (Windows block, extracted verbatim from README.md) - CRLF-dirty clone: the pull succeeds (fix round 1, I2)"
$origin = New-CrlfIndexRemote "readme-recovery-windows" $PreReleaseUpdateBat
$work = New-WorkingClone $origin "readme-recovery-windows"
Set-SqliteInstall $work "7046"
Set-PastMtime $work
$porcelain = (& git -C $work status --porcelain -- install.bat update.bat) -join "`n"
Assert ($porcelain -match "M install\.bat" -and $porcelain -match "M update\.bat") "premise: Git reports both files modified (got '$porcelain')"
Assert ((Get-FileHash (Join-Path $work "update.bat")).Hash -eq (Get-FileHash $PreReleaseUpdateBat).Hash) "premise: the clone's update.bat is the pre-release (663523c) one, byte for byte"
Add-ThisReleaseBats $origin
[IO.File]::WriteAllText((Join-Path $work "recovery.cmd"), ($windowsRecoveryBlock -replace "`n", "`r`n"), [Text.Encoding]::ASCII)
$headBefore = (& git -C $work rev-parse HEAD)
# Same answers as every other update.bat scenario here: this .env (from
# Set-SqliteInstall) predates BLACKVAULT_PUBLIC_URL, so the update.bat the
# recovery command ends by running prompts for it, then direct access
# (Enter = keep it on), then trusted proxies (Enter = none).
$r = Invoke-Bat -Dir $work -Script "recovery.cmd" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "cmd.exe ran the recovery command through to update.bat, which exited 0 (got $($r.ExitCode))"
Assert ((& git -C $work rev-parse HEAD) -ne $headBefore) "the pull succeeded"
Assert (-not (Test-Path (Join-Path $work ".git\info\attributes"))) "the temporary attributes override is gone (none existed before)"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error"
Assert ($r.StubLog -match "compose up -d") "update.bat (reached via the recovery command) ran to completion"
Assert (Test-Path (Join-Path $work "secrets\blackvault_encryption_key")) "the updater the block ran was THIS release's (it created the key file)"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario E7
Write-Scenario "README recovery command (Windows block) - restores an EXISTING .git\info\attributes byte for byte (fix round 1, I2)"
$origin = New-CrlfIndexRemote "readme-recovery-windows-attrs" $PreReleaseUpdateBat
$work = New-WorkingClone $origin "readme-recovery-windows-attrs"
Set-SqliteInstall $work "7047"
Set-PastMtime $work
$attrs = Join-Path $work ".git\info\attributes"
New-Item -ItemType Directory -Force -Path (Split-Path $attrs -Parent) | Out-Null
[IO.File]::WriteAllText($attrs, "*.png binary`r`n", [Text.Encoding]::ASCII)
Add-ThisReleaseBats $origin
[IO.File]::WriteAllText((Join-Path $work "recovery.cmd"), ($windowsRecoveryBlock -replace "`n", "`r`n"), [Text.Encoding]::ASCII)
$headBefore = (& git -C $work rev-parse HEAD)
$r = Invoke-Bat -Dir $work -Script "recovery.cmd" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((& git -C $work rev-parse HEAD) -ne $headBefore) "the pull succeeded"
Assert ([IO.File]::ReadAllText($attrs) -eq "*.png binary`r`n") "the pre-existing attributes file was restored byte for byte"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------------- report
Write-Host "`n================ summary ================"
Write-Host "$($script:Checks) checks, $($script:Failures.Count) failed"
if ($script:Failures.Count -gt 0) {
  foreach ($f in $script:Failures) { Write-Host "  FAILED: $f" -ForegroundColor Red }
  exit 1
}
Write-Host "install.bat, update.bat, rotate-key.bat and scripts\db-snapshot.bat verified on Windows (Docker stubbed)." -ForegroundColor Green
exit 0
