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
# Where a REAL docker.exe sits on this machine. It matters: backup.bat and
# restore.bat start docker from PowerShell, and Process.Start with a bare
# name searches the Windows system folders BEFORE PATH - so a docker.exe in
# System32 was started instead of the stub (first Windows run of BK1).
Write-Host "real docker on this machine: $(@(& where.exe docker 2>$null) -join '; ')"

# A harness error must never hide the scenarios after it. The first Windows
# run of backup.bat died on a harness exception in its FIRST scenario (a
# missing stdin record turned into $null), so twenty later scenarios never
# ran and the script's own output was never printed. From here on, any
# terminating error in a scenario is one FAIL line (with where it happened),
# and the run goes on with the next statement - so the scenario's own
# Show-EvidenceIfFailed still prints what the script said. The run still
# ends with exit 1: the failure is counted.
$script:TrapArmed = $true
trap {
  if (-not $script:TrapArmed) { break }
  $script:Checks++
  $where = if ($_.InvocationInfo) { "line $($_.InvocationInfo.ScriptLineNumber)" } else { "unknown line" }
  $msg = "harness error at ${where}: $($_.Exception.Message)"
  Write-Host "    FAIL $msg" -ForegroundColor Red
  $script:Failures.Add($msg)
  continue
}

function Assert([bool]$Condition, [string]$Message) {
  $script:Checks++
  if ($Condition) { Write-Host "    ok   $Message" }
  else { Write-Host "    FAIL $Message" -ForegroundColor Red; $script:Failures.Add($Message) }
}

# A file's bytes as base64, or "" when the file does not exist (never $null).
function Get-FileBase64([string]$Path) {
  if (-not (Test-Path $Path)) { return "" }
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($null -eq $bytes -or $bytes.Length -eq 0) { return "" }
  return [Convert]::ToBase64String($bytes)
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
    [int]$TimeoutSeconds = 180,
    # Task 6 (backup.bat): arguments for the script, already quoted for cmd.exe.
    [string]$BatArgs = "",
    # How the script is NAMED on the command line (default: its full path), and
    # the folder cmd.exe starts in (default: -Dir). Together they start a script
    # by a quoted RELATIVE name from another folder (scenario RS15).
    [string]$InvokeAs = "",
    [string]$WorkDir = ""
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
  $vars = @{ "BV_STUB_LOG" = $logFile; "BV_STUB_COMPOSE_VERSION" = "2.30.1"; "BV_STUB_FAIL_ON" = $null; "BV_STUB_LOGS_FILE" = $null; "BV_STUB_HEALTH" = $null }
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
    $batName = if ($InvokeAs) { $InvokeAs } else { "$Dir\$Script" }
    $psi.Arguments = "/d /s /c `"`"$batName`" $BatArgs < `"$answerFile`" 2>&1`""
    $psi.WorkingDirectory = if ($WorkDir) { $WorkDir } else { $Dir }
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
  if ($null -eq $stub) { $stub = "" }   # Get-Content -Raw of an empty file is $null
  if ($null -eq $out) { $out = "" }
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

# ------------------------------------------------- health-wait scenarios
# The health wait reads the Status column of `docker compose ps`. Only the
# word healthy in parentheses is success: "(unhealthy)" holds the letters
# "healthy" too. BV_STUB_HEALTH picks what the stub reports. `timeout /t`
# fails at once under a redirected stdin, so the 60 polls take seconds.
function Get-HealthPolls([pscustomobject]$Result) {
  return ([regex]::Matches($Result.StubLog, "(?m)^compose ps --format")).Count
}

# ---------------------------------------------------------------- scenario H1
Write-Scenario "install.bat - the container is unhealthy: not reported as running, says unhealthy, exit code 1"
$d = New-Sandbox "h1"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_HEALTH" = "unhealthy" }
Assert ($r.ExitCode -eq 1) "exits 1: a calling script must see the failure (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose up -d") "started the container (premise)"
Assert ((Get-HealthPolls $r) -eq 60) "polled the full 60 times (got $(Get-HealthPolls $r))"
Assert ($r.Output -match "WARNING: the BlackVault container is unhealthy") "says the container is unhealthy"
Assert ($r.Output -notmatch "BlackVault is running\.") "does not say it is running"
Assert ($r.Output -notmatch "BlackVault is ready") "does not say it is ready"
Assert ($r.Output -match "BlackVault was started, but is NOT healthy\.") "the summary heading says it is not healthy"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario H2
Write-Scenario "install.bat - still starting when the wait runs out: says it did not become healthy, exit code 0 (a slow first start is not a failure)"
$d = New-Sandbox "h2"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_HEALTH" = "starting" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-HealthPolls $r) -eq 60) "polled the full 60 times (got $(Get-HealthPolls $r))"
Assert ($r.Output -match "WARNING: BlackVault did not become healthy within two minutes") "says it did not become healthy"
Assert ($r.Output -notmatch "is unhealthy") "does not call a starting container unhealthy"
Assert ($r.Output -notmatch "BlackVault is running\.") "does not say it is running"
Assert ($r.Output -notmatch "BlackVault is ready") "does not say it is ready"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario H3
Write-Scenario "install.bat - healthy on the first poll: success"
$d = New-Sandbox "h3"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-HealthPolls $r) -eq 1) "one poll was enough (got $(Get-HealthPolls $r))"
Assert ($r.Output -match "BlackVault is running\.") "says it is running"
Assert ($r.Output -match "BlackVault is ready") "says it is ready"
Assert ($r.Output -notmatch "NOT healthy") "no not-healthy heading"
Assert ($r.Output -notmatch "WARNING: (the BlackVault container|BlackVault did not)") "no health warning"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario H4
Write-Scenario "update.bat - the container is unhealthy: Status is not running, says unhealthy, exit code 1"
$origin = New-GitRemote "update-health" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-health"
Set-ConfiguredSqliteInstall $work "7040"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_HEALTH" = "unhealthy" }
Assert ($r.ExitCode -eq 1) "exits 1: a calling script must see the failure (got $($r.ExitCode))"
Assert ($r.Output -match "To check logs:") "the summary, with the log hint, is still printed before the exit"
Assert ($r.StubLog -match "compose up -d") "restarted the container (premise)"
Assert ((Get-HealthPolls $r) -eq 60) "polled the full 60 times (got $(Get-HealthPolls $r))"
Assert ($r.Output -match "Status:\s+UNHEALTHY") "the status line says UNHEALTHY"
Assert ($r.Output -notmatch "Status:\s+running") "the status line does not say running"
Assert ($r.Output -match "Update applied - app NOT healthy\.") "the heading says the app is not healthy"
Assert ($r.Output -notmatch "Update complete\.") "does not say Update complete"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario H5
Write-Scenario "update.bat - still starting when the wait runs out: says it did not become healthy, exit code 0 (a slow first start is not a failure)"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_HEALTH" = "starting" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-HealthPolls $r) -eq 60) "polled the full 60 times (got $(Get-HealthPolls $r))"
Assert ($r.Output -match "Status:\s+did not become healthy within two minutes") "the status line says it did not become healthy"
Assert ($r.Output -notmatch "UNHEALTHY") "does not call a starting container unhealthy"
Assert ($r.Output -notmatch "Status:\s+running") "the status line does not say running"
Assert ($r.Output -notmatch "Update complete\.") "does not say Update complete"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario H6
Write-Scenario "update.bat - healthy on the first poll: success"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-HealthPolls $r) -eq 1) "one poll was enough (got $(Get-HealthPolls $r))"
Assert ($r.Output -match "Status:\s+running") "the status line says running"
Assert ($r.Output -match "Update complete\.") "says Update complete"
Assert ($r.Output -notmatch "NOT healthy") "no not-healthy heading"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario H7
# The app refuses to start (a restore marker, two keys, no public URL) by
# exiting, and Docker starts it over and over: the status is then neither
# unhealthy nor starting. That is a failed start, seen after three polls.
Write-Scenario "install.bat / update.bat - a container that keeps restarting, has exited or is not there is a failed start: the wait ends after three polls, the output says which, exit code 1"
$stateWords = @{ "restarting" = "keeps restarting"; "exited" = "has exited"; "missing" = "no running BlackVault container was found" }
foreach ($state in @("restarting", "exited", "missing")) {
  $d = New-Sandbox "h7-$state"
  $r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_HEALTH" = $state }
  Assert ($r.ExitCode -eq 1) "install.bat, ${state}: exits 1 (got $($r.ExitCode))"
  Assert ((Get-HealthPolls $r) -eq 3) "install.bat, ${state}: three polls, not sixty (got $(Get-HealthPolls $r))"
  Assert ($r.Output.Contains("WARNING: ") -and $r.Output.Contains($stateWords[$state])) "install.bat, ${state}: the warning says which"
  Assert ($r.Output -match "Check the logs with:") "install.bat, ${state}: points at the logs"
  Assert ($r.Output -notmatch "did not become healthy within two minutes") "install.bat, ${state}: not reported as a slow start"
  Assert ($r.Output -match "BlackVault was started, but is NOT healthy\.") "install.bat, ${state}: the summary heading says it is not healthy"
  Assert ($r.Output -notmatch "BlackVault is running\.") "install.bat, ${state}: does not say it is running"
  Show-EvidenceIfFailed $r
  $r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_HEALTH" = $state }
  Assert ($r.ExitCode -eq 1) "update.bat, ${state}: exits 1 (got $($r.ExitCode))"
  Assert ((Get-HealthPolls $r) -eq 3) "update.bat, ${state}: three polls, not sixty (got $(Get-HealthPolls $r))"
  Assert ($r.Output -match "Status:\s+NOT RUNNING - " -and $r.Output.Contains($stateWords[$state])) "update.bat, ${state}: the status line says which"
  Assert ($r.Output -match "Update applied - app NOT healthy\.") "update.bat, ${state}: the heading says the app is not healthy"
  Assert ($r.Output -match "To check logs:") "update.bat, ${state}: points at the logs"
  Assert ($r.Output -notmatch "Update complete\.") "update.bat, ${state}: does not say Update complete"
  Show-EvidenceIfFailed $r
}

# ------------------------------------------------ spent setup-token scenarios
# The app logs "[auth] First admin created" once, when the first admin is
# created. An update that changes nothing keeps the container and its log, so
# the token line is still there: the LAST line of the two kinds decides.
$AdminCreatedLine = "blackvault  | [auth] First admin created: first-time setup is closed"
$SpentTokenLog = $TokenLog + "`n" + $AdminCreatedLine + "`nblackvault  | GET / 200"
$TokenAfterAdminLog = $AdminCreatedLine + "`n" + $TokenLog

# ---------------------------------------------------------------- scenario T7
Write-Scenario "install.bat - the first admin was created after the last token line: no setup block"
$d = New-Sandbox "t7"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $d $SpentTokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log (premise)"
Assert ($r.Output -notmatch "First-time setup") "no setup block"
Assert ($r.Output -notmatch "WXYZ-2345-6789-ABCD") "the spent token is not shown"
Assert ($r.Output -notmatch "setup token") "no token text at all"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T8
Write-Scenario "update.bat - the first admin was created after the last token line: no setup block"
$origin = New-GitRemote "update-token-spent" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-token-spent"
Set-ConfiguredSqliteInstall $work "7041"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $Sandboxes $SpentTokenLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log (premise)"
Assert ($r.Output -match "Status:\s+running") "the update itself completed (premise)"
Assert ($r.Output -notmatch "First-time setup") "no setup block"
Assert ($r.Output -notmatch "WXYZ-2345-6789-ABCD") "the spent token is not shown"
Assert ($r.Output -notmatch "setup token") "no token text at all"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T9
Write-Scenario "update.bat - a token line AFTER the admin-created line is shown (the last line of the two kinds decides)"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = (New-StubLogs $Sandboxes $TokenAfterAdminLog) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "and enter the setup token: WXYZ-2345-6789-ABCD") "the block shows the newest token"
Assert ($r.Output -notmatch "ABCD-EFGH-JKMN-PQRS") "the older token is not shown"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario T10
Write-Scenario "update.bat - an empty container log: nothing extra printed"
$emptyLog = Join-Path $Sandboxes "__docker-logs-empty.txt"
[IO.File]::WriteAllText($emptyLog, "`n", (New-Object Text.UTF8Encoding $false))
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("") -EnvVars @{ "BV_STUB_LOGS_FILE" = $emptyLog }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match "compose logs blackvault") "read the blackvault container log (premise)"
Assert ($r.Output -notmatch "First-time setup") "no setup block"
Show-EvidenceIfFailed $r

# ------------------------------------------- a ; in the port of the typed URL
# NOT a proof of the port's own ";" guard. :valid_public_url checks the port
# with for /f, which skips a value that starts with its eol character (";" by
# default); but the host-and-port character check before it already refuses a
# ";", so these two scenarios pass with or without the port's guard. They show
# only that such a URL is rejected. The proof of the guard is the static test
# in scripts/bat-shared-subroutines.test.ts.
$SemicolonUrls = @("https://vault.example.com:;3000", "https://vault.example.com:30;00", "https://;vault.example.com")

# ---------------------------------------------------------------- scenario PS1
Write-Scenario "install.bat - a public URL with a ; in it is rejected, a normal port is accepted (does not exercise the port's own ; guard)"
$d = New-Sandbox "port-semicolon"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers (@("", "") + $SemicolonUrls + @("https://vault.example.com:3000", "", "", "2"))
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$rejections = ([regex]::Matches($r.Output, "The URL must start with http:// or https:// and have no path")).Count
Assert ($rejections -eq $SemicolonUrls.Count) "rejected all $($SemicolonUrls.Count) URLs holding a ; (got $rejections rejections)"
Assert ((Get-EnvValue $d "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com:3000") "the URL with a normal port was written"
Assert ((Get-EnvValue $d "BLACKVAULT_DB_PROVIDER") -eq "sqlite") "the database answer still landed on the database prompt"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario PS2
Write-Scenario "update.bat - a public URL with a ; in it is rejected, a normal port is accepted (does not exercise the port's own ; guard)"
$origin = New-GitRemote "update-semicolon" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-semicolon"
Set-SqliteInstall $work "7042"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers ($SemicolonUrls + @("https://vault.example.com:3000", "", ""))
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$rejections = ([regex]::Matches($r.Output, "The URL must start with http:// or https:// and have no path")).Count
Assert ($rejections -eq $SemicolonUrls.Count) "rejected all $($SemicolonUrls.Count) URLs holding a ; (got $rejections rejections)"
Assert ((Get-EnvValue $work "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com:3000") "the URL with a normal port was written"
Assert ($r.StubLog -match "compose up -d") "reached the restart"
Show-EvidenceIfFailed $r

# ------------------------------------------------------ .env forms (:env_value)
# install.bat and update.bat read .env through one shared subroutine,
# :env_value, which mirrors env_value in scripts/compose-provider.sh. The
# table below runs that subroutine itself: its block is cut out of install.bat
# (the comment lines above the label through the line before the next blank
# line, as scripts/bat-shared-subroutines.test.ts cuts it) and put under a
# three-line driver that prints the three variables it sets.
# The expected column is what Docker Compose's own parser gives for the line
# (github.com/compose-spec/compose-go/v2 dotenv, v2.16.1, probed case by
# case), or "refused" where :env_value does not implement what Compose does.
function New-EnvValueDriver([string]$Dir) {
  $lines = [IO.File]::ReadAllText((Join-Path $RepoRoot "install.bat")) -split "`r`n"
  $at = [Array]::IndexOf($lines, ":env_value")
  if ($at -lt 0) { throw "install.bat has no :env_value" }
  $end = $at
  while ($end + 1 -lt $lines.Count -and $lines[$end + 1].Trim() -ne "") { $end++ }
  $driver = @(
    "@echo off",
    "setlocal EnableDelayedExpansion",
    "cd /d `"%~dp0`"",
    "call :env_value %BV_EV_KEY%",
    "echo RESULT=[!_EV!][!_EV_SET!][!_EV_BAD!]",
    "exit /b 0",
    ""
  ) + $lines[$at..$end] + @("")
  [IO.File]::WriteAllText((Join-Path $Dir "envdrv.bat"), ($driver -join "`r`n"), (New-Object Text.UTF8Encoding $false))
}

# One row: a name, the .env text ($null: no .env), what the driver must print
# as [value][assigned][unreadable], and optionally the key that is read
# (default K; the driver takes it from BV_EV_KEY).
$tab = "`t"
$EnvCases = @(
  @("plain", "K=v`r`n", "[v][1][]"),
  @("LF line endings", "A=1`nK=v`nB=2`n", "[v][1][]"),
  @("no final newline", "K=v", "[v][1][]"),
  @("export", "export K=v`r`n", "[v][1][]"),
  @("export, several spaces and a tab", "export  ${tab}K=v`r`n", "[v][1][]"),
  @("leading whitespace", "  ${tab}K=v`r`n", "[v][1][]"),
  @("spaces around =", "K = v`r`n", "[v][1][]"),
  @("tabs around =", "K${tab}=${tab}v`r`n", "[v][1][]"),
  @("export with spaces around =", "export K = v`r`n", "[v][1][]"),
  @("double quotes", "K=`"a b`"`r`n", "[a b][1][]"),
  @("single quotes", "K='a b'`r`n", "[a b][1][]"),
  @("a # inside single quotes", "K='a # b'`r`n", "[a # b][1][]"),
  @("inline comment after an unquoted value", "K=v # note`r`n", "[v][1][]"),
  @("two spaces before the comment", "K=a  # b`r`n", "[a][1][]"),
  @("a tab before a # does not start a comment", "K=v${tab}# note`r`n", "[v${tab}# note][1][]"),
  @("a # with no whitespace before it", "K=a#b`r`n", "[a#b][1][]"),
  @("a # right after the = and its space is the value", "K= # note`r`n", "[# note][1][]"),
  @("a # as the first character", "K=#abc`r`n", "[#abc][1][]"),
  @("an apostrophe inside an unquoted value", "K=O'Brien`r`n", "[O'Brien][1][]"),
  @("a single-quoted Windows path", "K='C:\Users\rob\new data'`r`n", "[C:\Users\rob\new data][1][]"),
  @("a dollar sign inside single quotes is literal", "K='a`$HOME b'`r`n", "[a`$HOME b][1][]"),
  @("a dollar sign only in the comment", "K=v # costs `$5`r`n", "[v][1][]"),
  @("an ampersand and a pipe in the value", "K=a&b|c`r`n", "[a&b|c][1][]"),
  @("a double-quoted Windows path with no escape letter", "K=`"C:\BlackVault\Data`"`r`n", "[C:\BlackVault\Data][1][]"),
  @("a double-quoted path, upper-case after the backslashes", "K=`"C:\Users\Rob Smith\BlackVault`"`r`n", "[C:\Users\Rob Smith\BlackVault][1][]"),
  @("\c and \( inside double quotes are text", "K=`"x\cy\(w`"`r`n", "[x\cy\(w][1][]"),
  @("KEY: value, then KEY=value (the last assignment wins)", "K: v`r`nA=1`r`nK=w`r`n", "[w][1][]"),
  @("export KEY: value, then export KEY=value", "export K: v`r`nexport K=w`r`n", "[w][1][]"),
  @("a byte-order mark before a comment line; the key on line 2", "$([char]0xFEFF)# made in Notepad`r`nK=v`r`n", "[v][1][]"),
  @("a byte-order mark before another key; the key on line 2", "$([char]0xFEFF)OTHER=1`r`nK=v`r`n", "[v][1][]"),
  @("inner spaces are kept", "K=C:\my vault\data`r`n", "[C:\my vault\data][1][]"),
  @("a commented-out duplicate above", "#K=old`r`nK=new`r`n", "[new][1][]"),
  @("an indented commented-out duplicate above", "  # K=old`r`nK=new`r`n", "[new][1][]"),
  @("a commented-out duplicate below", "K=new`r`n#K=old`r`n", "[new][1][]"),
  @("the last assignment wins", "K=first`r`nK=second`r`n", "[second][1][]"),
  @("plain then export", "K=first`r`nexport K=second`r`n", "[second][1][]"),
  @("export then plain", "export K=first`r`nK=second`r`n", "[second][1][]"),
  @("a later empty assignment wins", "K=first`r`nK=`r`n", "[][1][]"),
  @("a value containing =", "K=a=b`r`n", "[a=b][1][]"),
  @("a URL with a query", "K=postgresql://u:p@db:5432/x?a=b`r`n", "[postgresql://u:p@db:5432/x?a=b][1][]"),
  @("percent signs stay literal", "K=%TEMP%`r`n", "[%TEMP%][1][]"),
  @("empty", "K=`r`n", "[][1][]"),
  @("empty double quotes", "K=`"`"`r`n", "[][1][]"),
  @("a longer key with the same suffix", "XK=v`r`n", "[][][]"),
  @("a longer key with the same prefix", "K2=v`r`nKK=w`r`n", "[][][]"),
  @("export glued to the key", "exportK=v`r`n", "[][][]"),
  @("the key only inside another value", "OTHER=K=v`r`n", "[][][]"),
  @("no .env at all", $null, "[][][]"),
  @("a leading ~ in a key that is not a folder", "K=~secret`r`n", "[~secret][1][]"),
  @("a ~ inside a folder path", "DATA_DIR=C:\~vault\~`r`n", "[C:\~vault\~][1][]", "DATA_DIR"),
  @("an exclamation mark only on lines of other keys, and on a commented-out line", "XK=a!b`r`nOTHER=K=a!b`r`n# K=old!`r`nK=v`r`n", "[v][1][]"),
  # Forms the batch reader refuses rather than read wrongly.
  @("REFUSED: a comment after a quoted value", "K=`"a b`" # note`r`n", "[][1][1]"),
  @("REFUSED: a double quote inside an unquoted value", "K=a`"b`r`n", "[][1][1]"),
  @("REFUSED: an unterminated double quote", "K=`"abc`r`n", "[][1][1]"),
  @("REFUSED: an unterminated single quote", "K='abc`r`n", "[][1][1]"),
  @("REFUSED: a value starting with =", "K==b`r`n", "[][1][1]"),
  @("REFUSED: a dollar sign in an unquoted value", "K=`$HOME\x`r`n", "[][1][1]"),
  @("REFUSED: a dollar sign in a double-quoted value", "export K = `"`${HOME}/x`"`r`n", "[][1][1]"),
  @("REFUSED: a double-quoted Windows path with \r and \n in it", "K=`"C:\Users\rob\new data`"`r`n", "[][1][1]"),
  @("REFUSED: a double-quoted Windows path with \t and \v in it", "K=`"D:\temp\v`"`r`n", "[][1][1]"),
  @("REFUSED: \a inside double quotes", "K=`"x\ay`"`r`n", "[][1][1]"),
  @("REFUSED: \0 inside double quotes", "K=`"x\0y`"`r`n", "[][1][1]"),
  @("REFUSED: a doubled backslash inside double quotes", "K=`"a\\b`"`r`n", "[][1][1]"),
  @("REFUSED: a double-quoted path ending in a backslash", "K=`"C:\BV\`"`r`n", "[][1][1]"),
  @("REFUSED: an escaped apostrophe inside single quotes", "K='a\'b'`r`n", "[][1][1]"),
  @("REFUSED: an apostrophe inside single quotes", "K='D:\Rob's Vault'`r`n", "[][1][1]"),
  @("REFUSED: a single-quoted path ending in a backslash", "K='C:\BV\'`r`n", "[][1][1]"),
  @("REFUSED: KEY=value, then KEY: value (the last assignment is the unreadable one)", "K=w`r`nK: v`r`n", "[][1][1]"),
  @("REFUSED: KEY: value", "K: v`r`n", "[][1][1]"),
  @("REFUSED: export KEY: value", "export K: v`r`n", "[][1][1]"),
  @("REFUSED: text after the closing single quote", "K='a'b`r`n", "[][1][1]"),
  # Delayed expansion would drop the ! from the value: D:\Vault!\data would be read as D:\Vault\data.
  @("REFUSED: an exclamation mark in the value", "K=D:\Vault!\data`r`n", "[][1][1]"),
  @("REFUSED: two exclamation marks in an export line with spaces", "export K = a!b!c`r`n", "[][1][1]"),
  @("REFUSED: an exclamation mark in the comment of the line", "K=v # really!`r`n", "[][1][1]"),
  @("REFUSED: an exclamation mark on an earlier assignment of the key", "K=a!b`r`nK=v`r`n", "[][1][1]"),
  # A key on the first line of a .env that starts with a byte-order mark: the
  # searches for ==, an exclamation mark and KEY: cannot see behind the mark,
  # so the line is refused whatever its value.
  @("REFUSED: a byte-order mark before the key on line 1", "$([char]0xFEFF)K=v`r`n", "[][1][1]"),
  @("REFUSED: a byte-order mark before an export line", "$([char]0xFEFF)export K=v`r`n", "[][1][1]"),
  @("REFUSED: a byte-order mark, then the key with an exclamation mark in its value", "$([char]0xFEFF)K=D:\Vault!\data`r`n", "[][1][1]"),
  @("REFUSED: a byte-order mark, then a value starting with =", "$([char]0xFEFF)K==b`r`n", "[][1][1]"),
  @("REFUSED: a byte-order mark, then KEY: value", "$([char]0xFEFF)K: v`r`n", "[][1][1]"),
  @("REFUSED: a byte-order mark, then export KEY: value", "$([char]0xFEFF)export K: v`r`n", "[][1][1]"),
  # Compose puts the home folder in place of a leading ~ in a bind mount's source.
  @("REFUSED: a leading ~ in a folder key", "DATA_DIR=~\blackvault`r`n", "[][1][1]", "DATA_DIR"),
  @("REFUSED: a leading ~ in a double-quoted folder key", "export DATA_DIR = `"~/blackvault`"`r`n", "[][1][1]", "DATA_DIR"),
  @("REFUSED: a lone ~ in single quotes as the backup folder", "BLACKVAULT_BACKUP_DIR='~'`r`n", "[][1][1]", "BLACKVAULT_BACKUP_DIR")
)

# ---------------------------------------------------------------- scenario EV1
Write-Scenario ":env_value (install.bat's own copy, run on cmd.exe) - every .env form in the table"
$d = Join-Path $Sandboxes "envvalue"
New-Item -ItemType Directory -Force -Path $d | Out-Null
New-EnvValueDriver $d
$last = $null
foreach ($case in $EnvCases) {
  $envFile = Join-Path $d ".env"
  Remove-Item -Force $envFile -ErrorAction SilentlyContinue
  $rowBase = $script:Failures.Count
  # UTF-8 without a byte-order mark of its own: a row that wants one writes it.
  if ($null -ne $case[1]) { [IO.File]::WriteAllText($envFile, $case[1], (New-Object Text.UTF8Encoding $false)) }
  $key = if ($case.Count -gt 3) { $case[3] } else { "K" }
  $last = Invoke-Bat -Dir $d -Script "envdrv.bat" -NoPad -TimeoutSeconds 60 -EnvVars @{ "BV_EV_KEY" = $key }
  $got = "(no RESULT line)"
  $m = [regex]::Match($last.Output, "(?m)^RESULT=(.*?)\r?$")
  if ($m.Success) { $got = $m.Groups[1].Value }
  Assert ($got -eq $case[2]) "$($case[0]): $($case[2]) (got $got)"
  if ($case[0] -match "^REFUSED: a byte-order mark") {
    Assert ($last.Output -match "\.env starts with a byte order mark, and that line is its first\.\s+Save \.env without a byte order mark") "$($case[0]): says to save the file without a byte order mark"
  }
  if ($case[2].EndsWith("[1][1]")) {
    Assert ($last.Output -match "Note: the $key line in \.env is written in a form this script does not read") "$($case[0]): says the line is not read"
  } else {
    Assert ($last.Output -notmatch "Note:") "$($case[0]): no note"
  }
  # The evidence of THIS row, when one of its checks failed.
  if ($script:Failures.Count -gt $rowBase) {
    $shown = if ($null -eq $case[1]) { "(no .env)" } else { ($case[1] -replace "`r", "<CR>" -replace "`n", "<LF>" -replace "`t", "<TAB>") }
    Write-Host "    ---- row '$($case[0])': .env = $shown ; the driver printed:" -ForegroundColor Yellow
    foreach ($l in ($last.Output -split "`r?`n")) { Write-Host "       | $l" }
  }
}

# ---------------------------------------------------------------- scenario EV2
Write-Scenario "install.bat - a configured install whose .env uses export, spaces, quotes and comments is started, not reconfigured"
$d = New-Sandbox "e2"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\db") | Out-Null
Set-Content -Path (Join-Path $d "data\db\vault.db") -Value "not really sqlite" -Encoding Ascii
@("# written by hand", "export DATA_DIR = $d\data # where the data lives", "#PORT=1111", "PORT='7777'", "  export BLACKVAULT_DB_PROVIDER=`"sqlite`"") |
  Set-Content -Path (Join-Path $d ".env") -Encoding Ascii
$before = Get-FileBase64 (Join-Path $d ".env")
$r = Invoke-Bat -Dir $d -Script "install.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "already configured") "says it is already configured"
Assert ($r.Output.Contains("Your data is at: $d\data (sqlite)")) "found the data folder and the provider through the export / quoted lines"
Assert ((Get-FileBase64 (Join-Path $d ".env")) -eq $before) ".env left byte-for-byte unchanged"
Assert ($r.StubLog -match "compose up -d") "started the existing configuration"
Assert ($r.StubLog -notmatch "compose build") "did NOT rebuild"
Assert ($r.Output -match "http://localhost:7777") "reported the configured port, not the commented-out one"
Assert ($r.Output -notmatch "Where should BlackVault store its data") "the wizard did not run"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario EV3
Write-Scenario "update.bat - public URL, direct access, trusted proxies and the encryption key written with export / quotes / comments: nothing asked again, no key file created"
$origin = New-GitRemote "update-envforms" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-envforms"
Set-SqliteInstall $work "7043"
$envKey = "cd" * 32
Add-Content -Path (Join-Path $work ".env") -Encoding Ascii -Value @(
  "#BLACKVAULT_PUBLIC_URL=https://old.example.com",
  "export BLACKVAULT_PUBLIC_URL='https://vault.example.com'",
  "export BLACKVAULT_DIRECT_ACCESS_INITIAL=on # keep direct access",
  "  export BLACKVAULT_TRUSTED_PROXIES=",
  "export BLACKVAULT_ENCRYPTION_KEY = `"  $envKey `""
)
$before = Get-FileBase64 (Join-Path $work ".env")
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Public URL is: https://vault\.example\.com\r?\n") "read the public URL through export and single quotes"
Assert ($r.Output -notmatch "Public URL: the address people open BlackVault at") "did not ask for the public URL again"
Assert ($r.Output -notmatch "Keep allowing direct access") "did not ask about direct access again"
Assert ($r.Output -notmatch "Trusted proxies:") "did not ask for trusted proxies again"
Assert ($r.Output -match "Encryption key: BLACKVAULT_ENCRYPTION_KEY \(from \.env\) - no key file created") "found the key in .env through export, spaces, double quotes and spaces inside them (the app trims the value)"
Assert (-not (Test-Path (Join-Path $work "secrets\blackvault_encryption_key"))) "created NO key file (a second key would be a conflict)"
Assert ($r.Output -notmatch $envKey) "the key is never echoed"
Assert ((Get-FileBase64 (Join-Path $work ".env")) -eq $before) ".env left byte-for-byte unchanged"
Assert ($r.StubLog -match "compose up -d") "restarted"
Assert ($r.Output -match "URL:\s+https://vault\.example\.com") "the summary shows the public URL"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario EV4
Write-Scenario "update.bat - an encryption-key line the batch reader cannot read stops the update: no second key, nothing rebuilt"
$origin = New-GitRemote "update-envkey-unreadable" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "update-envkey-unreadable"
Set-ConfiguredSqliteInstall $work "7044"
Add-Content -Path (Join-Path $work ".env") -Encoding Ascii -Value @("BLACKVAULT_ENCRYPTION_KEY=`"$envKey`" # the field-encryption key")
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "Note: the BLACKVAULT_ENCRYPTION_KEY line in \.env is written in a form this script does not read") "says which line it does not read"
Assert ($r.Output -match "ERROR: the BLACKVAULT_ENCRYPTION_KEY line in \.env could not be read") "says why it stopped"
Assert ($r.Output -match "Nothing was rebuilt or restarted") "says nothing was rebuilt"
Assert (-not (Test-Path (Join-Path $work "secrets\blackvault_encryption_key"))) "created NO key file"
Assert ($r.StubLog -notmatch "compose build") "did NOT rebuild"
Assert ($r.StubLog -notmatch "compose up") "did NOT restart"
Assert ($r.Output -notmatch $envKey) "the key is never echoed"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario EV5
Write-Scenario "install.bat - a commented-out encryption-key line does not count: the key file is created"
$d = New-Sandbox "e5"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\db") | Out-Null
Set-Content -Path (Join-Path $d "data\db\vault.db") -Value "not really sqlite" -Encoding Ascii
@("DATA_DIR=$d\data", "PORT=7778", "BLACKVAULT_DB_PROVIDER=sqlite", "# export BLACKVAULT_ENCRYPTION_KEY=$envKey") |
  Set-Content -Path (Join-Path $d ".env") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "install.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Encryption key created:") "created a key file"
Assert (Test-Path (Join-Path $d "secrets\blackvault_encryption_key")) "the key file exists"
Show-EvidenceIfFailed $r

# ------------------------------------- values Docker Compose would change
# Compose substitutes $VAR in unquoted and double-quoted values and unescapes
# \r, \n, \t ... inside double quotes, so DATA_DIR="C:\Users\rob\data" names a
# folder with a carriage return in it. :env_value refuses such a line instead
# of handing back the text as typed. A refused DATA_DIR must never be
# replaced by whatever database sits in a legacy folder.
function New-UpdateInstall([string]$Name, [string]$DataDirLine, [switch]$NoProvider) {
  $origin = New-GitRemote "$Name" (Join-Path $RepoRoot "update.bat")
  $work = New-WorkingClone $origin "$Name"
  # The real data, in a folder of its own ...
  New-Item -ItemType Directory -Force -Path (Join-Path $work "vault\db"), (Join-Path $work "vault\uploads") | Out-Null
  Set-Content -Path (Join-Path $work "vault\db\vault.db") -Value "the real database" -Encoding Ascii
  # ... and a database in .\data, the first legacy location update.bat looks in.
  New-Item -ItemType Directory -Force -Path (Join-Path $work "data\db") | Out-Null
  Set-Content -Path (Join-Path $work "data\db\vault.db") -Value "a stale legacy database" -Encoding Ascii
  $lines = @($DataDirLine.Replace("<VAULT>", (Join-Path $work "vault")), "PORT=7050")
  if (-not $NoProvider) { $lines += "BLACKVAULT_DB_PROVIDER=sqlite" }
  $lines += @("BLACKVAULT_PUBLIC_URL=https://vault.example.com", "BLACKVAULT_DIRECT_ACCESS_INITIAL=on", "BLACKVAULT_TRUSTED_PROXIES=")
  [IO.File]::WriteAllText((Join-Path $work ".env"), (($lines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)
  return $work
}

# ---------------------------------------------------------------- scenario UR1
Write-Scenario "update.bat - DATA_DIR with a comment after it, or in single quotes, is read BEFORE git pull as the folder it names: verified, not relocated, and the snapshot is of that folder"
$form = 0
foreach ($line in @("DATA_DIR=<VAULT> # where the data lives", "DATA_DIR='<VAULT>'", "export DATA_DIR = <VAULT>")) {
  $form++
  $work = New-UpdateInstall "update-datadir-form$form" $line
  $before = Get-FileBase64 (Join-Path $work ".env")
  $r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
  Assert ($r.ExitCode -eq 0) "[$line] exits 0 (got $($r.ExitCode))"
  Assert ($r.Output.Contains("Database verified at: $work\vault\db\vault.db")) "[$line] verified the database in the folder the line names"
  Assert ($r.Output -notmatch "Auto-updating DATA_DIR") "[$line] did not relocate DATA_DIR to the legacy folder"
  Assert ($r.Output -notmatch "No database found at expected location") "[$line] no missing-database warning"
  Assert ((Get-FileBase64 (Join-Path $work ".env")) -eq $before) "[$line] .env left byte-for-byte unchanged"
  $snap = @(Get-ChildItem (Join-Path $work "backups") -Filter "blackvault-*.db" -ErrorAction SilentlyContinue)
  Assert ($snap.Count -eq 1 -and (Get-Content $snap[0].FullName -Raw) -match "the real database") "[$line] scripts\db-snapshot.bat copied the real database, not the legacy one"
  Assert ($r.StubLog -match "compose up -d") "[$line] restarted"
  Show-EvidenceIfFailed $r
}

# ---------------------------------------------------------------- scenario UR2
Write-Scenario "update.bat - a DATA_DIR line Compose would change or reject stops the update at the preflight, BEFORE the pull: nothing pulled, built, relocated or snapshotted, .env untouched"
$form = 0
foreach ($line in @("DATA_DIR=`"C:\Users\rob\new data`"", "export DATA_DIR=`$USERPROFILE\vault", "DATA_DIR: <VAULT>", "DATA_DIR='<VAULT>\Rob's data'", "DATA_DIR='<VAULT>\'", "DATA_DIR=~\vault", "DATA_DIR=<VAULT>\really!")) {
  $form++
  $work = New-UpdateInstall "update-datadir-refused$form" $line
  $before = Get-FileBase64 (Join-Path $work ".env")
  $r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
  Assert ($r.ExitCode -eq 1) "[$line] exits 1 (got $($r.ExitCode))"
  Assert ($r.Output -match "Note: the DATA_DIR line in \.env is written in a form this script does not read") "[$line] says which line it does not read"
  Assert ($r.Output -match "as DATA_DIR=value with the final value spelled\s+out and no \$ in it: best for a Windows path") "[$line] says how to write a Windows path"
  Assert ($r.Output -match "ERROR: \.env holds a DATA_DIR line this script does not read") "[$line] says why it stopped"
  Assert ($r.Output -match "Nothing was rebuilt or restarted" -and $r.Output -notmatch "Nothing was pulled") "[$line] says nothing was rebuilt or restarted (and makes no claim about the pull)"
  Assert ($r.Output -notmatch "Pulling latest updates") "[$line] did NOT pull"
  Assert ($r.Output -notmatch "Auto-updating DATA_DIR") "[$line] did not relocate DATA_DIR to the legacy folder"
  Assert ($r.Output -notmatch "Database verified at") "[$line] verified nothing"
  Assert ($r.Output -notmatch "Public URL is:") "[$line] asked nothing"
  Assert ((Get-FileBase64 (Join-Path $work ".env")) -eq $before) "[$line] .env left byte-for-byte unchanged"
  Assert (-not (Test-Path (Join-Path $work ".env.bak"))) "[$line] no .env.bak: .env was never rewritten"
  Assert (-not (Test-Path (Join-Path $work "secrets\blackvault_encryption_key"))) "[$line] created NO key file"
  Assert ($r.StubLog -notmatch "compose (build|up|stop)") "[$line] did NOT build, start or stop anything"
  Assert (-not (Test-Path (Join-Path $work "backups"))) "[$line] took no snapshot"
  Show-EvidenceIfFailed $r
}

# ---------------------------------------------------------------- scenario UR2b
Write-Scenario "scripts\db-snapshot.bat on its own - the backstop for an OLDER update.bat, which resumes after the pull and never runs the new preflight: a refused DATA_DIR line fails the snapshot before the app is stopped; .\data is not assumed"
$d = New-Sandbox "db-snapshot-datadir-refused"
Set-SqliteInstall $d "7053"
@("DATA_DIR=`"C:\Users\rob\new data`"", "PORT=7053", "BLACKVAULT_DB_PROVIDER=sqlite") | Set-Content -Path (Join-Path $d ".env") -Encoding Ascii
@("@echo off", "setlocal EnableDelayedExpansion", "call scripts\db-snapshot.bat", "echo RC=!errorlevel!") |
  Set-Content -Path (Join-Path $d "caller.bat") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad
Assert ($r.Output -match "RC=1") "errorlevel 1"
Assert ($r.Output -match "database snapshot failed: DATA_DIR in \.env could not be read") "says why"
Assert ($r.StubLog -notmatch "(?m)^compose stop") "did not stop the app"
Assert (@(Get-ChildItem (Join-Path $d "backups") -Filter "blackvault-*.db" -ErrorAction SilentlyContinue).Count -eq 0) "wrote no snapshot of the database in .\data"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario DD1
# THE INVARIANT: whatever install.bat writes for DATA_DIR is a line its own
# :env_value reads back as the folder the installer made. An answer that
# would not be read back is asked for again.
Write-Scenario "install.bat - a data folder typed with ~ or with an exclamation mark is asked for again; the DATA_DIR line written is read back by :env_value as the folder that was made"
$d = New-Sandbox "dd1"
$good = Join-Path $d "good data"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("~\vault", "$d\wow!", $good, "", "https://vault.example.com", "", "", "2")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (([regex]::Matches($r.Output, "That folder cannot be used as typed")).Count -eq 2) "both answers were refused, each with the reason"
Assert ((Get-EnvValue $d "DATA_DIR") -eq $good) "DATA_DIR in .env is the third answer"
Assert (Test-Path (Join-Path $good "db")) "the folder that was made is that one"
Assert (-not (Test-Path (Join-Path $d "~"))) "no folder literally named ~ was made"
Assert (-not (Test-Path (Join-Path $d "wow!")) -and -not (Test-Path (Join-Path $d "wow"))) "no folder was made for the answer with the exclamation mark"
Show-EvidenceIfFailed $r
New-EnvValueDriver $d
$back = Invoke-Bat -Dir $d -Script "envdrv.bat" -NoPad -TimeoutSeconds 60 -EnvVars @{ "BV_EV_KEY" = "DATA_DIR" }
Assert ($back.Output.Contains("RESULT=[$good][1][]")) "install.bat's own :env_value reads the line back as that folder, and does not refuse it"
Show-EvidenceIfFailed $back

# ---------------------------------------------------------------- scenario DD2
Write-Scenario "install.bat - three data folders in a row that would not be read back (a dollar sign, a leading apostrophe, ~): stops with exit 1, writes no .env, makes no folder"
$d = New-Sandbox "dd2"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("$d\a`$b", "'$d\quoted'", "~") -NoPad
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert (([regex]::Matches($r.Output, "That folder cannot be used as typed")).Count -eq 3) "each answer was refused"
Assert ($r.Output -match "ERROR: no usable data directory was given\. Nothing was changed\.") "says nothing was changed"
Assert (-not (Test-Path (Join-Path $d ".env"))) "no .env was written"
Assert (-not (Test-Path (Join-Path $d "~")) -and -not (Test-Path (Join-Path $d "a`$b"))) "no folder was made"
Assert ($r.StubLog -notmatch "compose (build|up)") "nothing was built or started"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR2c
Write-Scenario "scripts\db-snapshot.bat - a UTF-8 byte-order mark before DATA_DIR on line 1 of .env: every batch script refuses that line alike, so none reads .\data in its place; with a comment line first the folder is read"
$d = New-Sandbox "db-snapshot-bom"
Set-SqliteInstall $d "7054"
New-Item -ItemType Directory -Force -Path (Join-Path $d "vault\db"), (Join-Path $d "vault\uploads") | Out-Null
Set-Content -Path (Join-Path $d "vault\db\vault.db") -Value "the real database" -Encoding Ascii
[IO.File]::WriteAllText((Join-Path $d ".env"), "$([char]0xFEFF)DATA_DIR=$d\vault`r`nPORT=7054`r`nBLACKVAULT_DB_PROVIDER=sqlite`r`n", (New-Object Text.UTF8Encoding $false))
@("@echo off", "setlocal EnableDelayedExpansion", "call scripts\db-snapshot.bat", "echo RC=!errorlevel!") |
  Set-Content -Path (Join-Path $d "caller.bat") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad
Assert ($r.Output -match "RC=1") "errorlevel 1"
Assert ($r.Output -match "Save \.env without a byte order mark") "the note says how to save the file"
Assert ($r.Output -match "database snapshot failed: DATA_DIR in \.env could not be read") "says why"
Assert ($r.StubLog -notmatch "(?m)^compose stop") "did not stop the app"
Assert (@(Get-ChildItem (Join-Path $d "backups") -Filter "blackvault-*.db" -ErrorAction SilentlyContinue).Count -eq 0) "wrote no snapshot of the database in .\data"
Show-EvidenceIfFailed $r
[IO.File]::WriteAllText((Join-Path $d ".env"), "$([char]0xFEFF)# BlackVault configuration`r`nDATA_DIR=$d\vault`r`nPORT=7054`r`nBLACKVAULT_DB_PROVIDER=sqlite`r`n", (New-Object Text.UTF8Encoding $false))
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad
Assert ($r.Output -match "RC=0") "a comment line first: errorlevel 0"
Assert ($r.Output -notmatch "Note:") "a comment line first: no note"
$snap = @(Get-ChildItem (Join-Path $d "backups") -Filter "blackvault-*.db" -ErrorAction SilentlyContinue)
Assert ($snap.Count -eq 1 -and (Get-Content $snap[0].FullName -Raw) -match "the real database") "a comment line first: the snapshot is of the database in the folder the line names"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR2d
Write-Scenario "scripts\db-snapshot.bat - DATA_DIR set in the console and different from .env: refused before the app is stopped; the same folder in the console is accepted"
$d = New-Sandbox "db-snapshot-console-datadir"
Set-SqliteInstall $d "7055"
@("@echo off", "setlocal EnableDelayedExpansion", "call scripts\db-snapshot.bat", "echo RC=!errorlevel!") |
  Set-Content -Path (Join-Path $d "caller.bat") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad -EnvVars @{ "DATA_DIR" = "C:\somewhere\else" }
Assert ($r.Output -match "RC=1") "errorlevel 1"
Assert ($r.Output -match "database snapshot failed: DATA_DIR is set in this console and is not the DATA_DIR in \.env") "says why"
Assert ($r.StubLog -notmatch "(?m)^compose stop") "did not stop the app"
Assert (@(Get-ChildItem (Join-Path $d "backups") -Filter "blackvault-*.db" -ErrorAction SilentlyContinue).Count -eq 0) "wrote no snapshot"
Show-EvidenceIfFailed $r
$r = Invoke-Bat -Dir $d -Script "caller.bat" -NoPad -EnvVars @{ "DATA_DIR" = "$d\data" }
Assert ($r.Output -match "RC=0") "the same folder in the console: errorlevel 0"
Assert (@(Get-ChildItem (Join-Path $d "backups") -Filter "blackvault-*.db" -ErrorAction SilentlyContinue).Count -eq 1) "the same folder in the console: one snapshot"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR2e
# The new image refuses to start while a restore marker is in the uploads
# folder. update.bat looks before it asks, rebuilds or stops anything, so the
# version that is running keeps running.
Write-Scenario "update.bat - a restore marker in the uploads folder stops the update before the rebuild, with the command that removes it; names that are not markers do not"
$work = New-UpdateInstall "update-restore-marker" "DATA_DIR=<VAULT>"
$uploads = Join-Path $work "vault\uploads"
New-Item -ItemType Directory -Force -Path (Join-Path $uploads ".restore-20261001-101010.db-started") | Out-Null
Set-Content -Path (Join-Path $uploads ".restore-old one.db-started") -Value "" -Encoding Ascii
# Not markers: the staging folder, the previous files, and a name with an empty stamp.
New-Item -ItemType Directory -Force -Path (Join-Path $uploads ".restore-20261001-101010"), (Join-Path $uploads ".pre-restore-20261001-101010"), (Join-Path $uploads ".restore-.db-started") | Out-Null
$before = Get-FileBase64 (Join-Path $work ".env")
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output.Contains("ERROR: the uploads folder holds a marker left by a restore: $uploads\.restore-20261001-101010.db-started, $uploads\.restore-old one.db-started.")) "names both markers, the folder and the file, and nothing else"
Assert ($r.Output -match 'docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh [^\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads "20261001-101010" && docker compose run [^\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads "old one"') "gives ONE command line that removes both, each stamp quoted"
Assert ($r.Output -match "Then run update\.bat again\. Nothing was rebuilt or restarted\.") "says what to do next and that nothing was rebuilt or restarted"
Assert ($r.Output -notmatch "Public URL is:") "asked nothing"
Assert ($r.StubLog -notmatch "compose (build|up|stop|run)") "did NOT build, start or stop anything"
Assert ((Get-FileBase64 (Join-Path $work ".env")) -eq $before) ".env left byte-for-byte unchanged"
Assert (-not (Test-Path (Join-Path $work "secrets\blackvault_encryption_key"))) "created NO key file"
Assert (-not (Test-Path (Join-Path $work "backups"))) "took no snapshot"
Assert (Test-Path (Join-Path $uploads ".restore-20261001-101010.db-started")) "the marker is never removed by the update"
Show-EvidenceIfFailed $r
# With both markers gone, the names that are not markers do not stop it.
Remove-Item -Recurse -Force (Join-Path $uploads ".restore-20261001-101010.db-started"), (Join-Path $uploads ".restore-old one.db-started")
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "without the markers: exits 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "marker left by a restore") "without the markers: no refusal"
Assert ($r.StubLog -match "compose up -d") "without the markers: restarted"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR3
Write-Scenario "update.bat - a database that really is in the legacy folder: an 'export DATA_DIR' line is rewritten, not left beside a new one"
$work = New-UpdateInstall "update-datadir-relocate" "export DATA_DIR = <VAULT>-moved-away"
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Auto-updating DATA_DIR in \.env") "relocated: the folder the line names has no database, the legacy one has"
Assert ((Get-EnvValue $work "DATA_DIR") -eq "$work\data") "DATA_DIR is now the legacy folder, as a plain line"
Assert (@(Get-Content (Join-Path $work ".env") | Where-Object { $_ -match "DATA_DIR" }).Count -eq 1) "exactly one DATA_DIR line is left"
Assert (Test-Path (Join-Path $work ".env.bak")) "the previous .env is kept as .env.bak"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR4
Write-Scenario "update.bat - a BLACKVAULT_DB_PROVIDER line it does not read stops before the pull (SQLite is not assumed)"
$work = New-UpdateInstall "update-provider-refused" "DATA_DIR=<VAULT>" -NoProvider
Add-Content -Path (Join-Path $work ".env") -Encoding Ascii -Value @("BLACKVAULT_DB_PROVIDER=`$DB")
$before = Get-FileBase64 (Join-Path $work ".env")
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("")
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: \.env holds a BLACKVAULT_DB_PROVIDER line this script does not read") "says why it stopped"
Assert ($r.Output -match "Nothing was rebuilt or restarted" -and $r.Output -notmatch "Nothing was pulled") "says nothing was rebuilt or restarted"
Assert ($r.Output -notmatch "Pulling latest updates") "did NOT pull"
Assert ($r.Output -notmatch "is missing") "no warning about PostgreSQL keys derived from the line that was refused"
Assert ($r.StubLog -notmatch "compose build") "did NOT rebuild"
Assert ((Get-FileBase64 (Join-Path $work ".env")) -eq $before) ".env left byte-for-byte unchanged"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR5
Write-Scenario "install.bat - an existing .env whose DATA_DIR line is refused stops the installer: the wizard never writes a new .env over it"
$d = New-Sandbox "install-datadir-refused"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\db") | Out-Null
Set-Content -Path (Join-Path $d "data\db\vault.db") -Value "not really sqlite" -Encoding Ascii
@("DATA_DIR=`"$d\data`"", "PORT=7051", "BLACKVAULT_DB_PROVIDER=sqlite") | Set-Content -Path (Join-Path $d ".env") -Encoding Ascii
$before = Get-FileBase64 (Join-Path $d ".env")
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2")
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "Note: the DATA_DIR line in \.env is written in a form this script does not read") "says which line it does not read"
Assert ($r.Output -match "ERROR: \.env holds a line this script does not read") "says why it stopped"
Assert ($r.Output -notmatch "Where should BlackVault store its data") "the wizard did not run"
Assert ((Get-FileBase64 (Join-Path $d ".env")) -eq $before) ".env left byte-for-byte unchanged"
Assert ([string]::IsNullOrWhiteSpace(($r.StubLog -replace "(?m)^compose version.*\r?\n?", ""))) "docker was asked for its version and nothing else"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key"))) "created NO key file"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UR6
Write-Scenario "install.bat - BLACKVAULT_ENCRYPTION_KEY that is not 64 hex characters (here: only a comment after the =, which Compose passes on as the value) stops: no second key"
$d = New-Sandbox "install-key-malformed"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\db") | Out-Null
Set-Content -Path (Join-Path $d "data\db\vault.db") -Value "not really sqlite" -Encoding Ascii
@("DATA_DIR=$d\data", "PORT=7052", "BLACKVAULT_DB_PROVIDER=sqlite", "BLACKVAULT_ENCRYPTION_KEY= # set me") | Set-Content -Path (Join-Path $d ".env") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "install.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: BLACKVAULT_ENCRYPTION_KEY in \.env is not 64 hex characters") "says the key is malformed"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key"))) "created NO key file"
Assert ($r.StubLog -notmatch "compose up") "did NOT start"
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
# Spec 3b: exit 3 also covers an uploaded file under neither key, so the headline is generic.
Assert ($r.Output -match "ERROR: the rotation refused before changing anything; the reason is printed above\.") "generic refusal headline"
Assert ($r.Output -match "secrets\\blackvault_encryption_key does not open this database \(wrong or replaced key\)\.") "names the wrong-key reason"
Assert ($r.Output -match "If it names an uploaded file") "names the uploaded-file reason"
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

# ------------------------------------------------------------- scenario RK6f
# Spec 3b Task 5: the probe prints a SECOND line, "FILES old=<n> new=<n> rot=<n>".
# Only the first line is the answer (a bare `for /f ... do set` kept the LAST
# line); the staged .rot count is reported and left to the app's startup.
Write-Scenario "rotate-key.bat - two-line probe answers NEW with staged .rot files: first line decides, swap completes, .rot files reported as finished at startup (spec 3b)"
$d = New-RotateSandbox "rotate-probe-files-new" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_ANSWER" = "NEW"; "BV_STUB_PROBE_FILES" = "FILES old=3 new=0 rot=3" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -match "Confirmed: the database is already encrypted with the NEW key") "the FIRST line (NEW) picked the branch"
Assert ($r.Output -match "3 re-encrypted uploaded files are staged as \.rot files; BlackVault puts them in place when it starts with the new key\.") "reports the 3 staged .rot files from the FILES line"
Assert ($r.Output -match "Key rotation complete") "completes the swap"
Assert ($r.StubLog -match "compose start blackvault") "restarted (the app's startup finishes the .rot renames)"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw).Trim() -ne $keyBefore.Trim()) "the active key file now holds the NEW key"
Show-EvidenceIfFailed $r

# ------------------------------------------------------------- scenario RK6g
Write-Scenario "rotate-key.bat - two-line probe answers NEW with rot=0: no .rot line, swap completes (spec 3b)"
$d = New-RotateSandbox "rotate-probe-files-new-norot" -WithSnapshot
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_ANSWER" = "NEW"; "BV_STUB_PROBE_FILES" = "FILES old=0 new=3 rot=0" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "\.rot files") "no staged-files line when rot=0"
Assert ($r.Output -match "Key rotation complete") "completes the swap"
Show-EvidenceIfFailed $r

# ------------------------------------------------------------- scenario RK6h
Write-Scenario "rotate-key.bat - two-line probe answers OLD: the first line alone picks the OLD branch (spec 3b)"
$d = New-RotateSandbox "rotate-probe-files-old" -WithSnapshot
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat" -EnvVars @{ "BV_STUB_FAIL_ON" = "run"; "BV_STUB_PROBE_ANSWER" = "OLD"; "BV_STUB_PROBE_FILES" = "FILES old=3 new=0 rot=0" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "Confirmed: the database is still encrypted with the OLD key") "the FIRST line (OLD) picked the branch"
Assert (@(Get-ChildItem (Join-Path $d "secrets") -Filter "blackvault_encryption_key.new.unused-*").Count -eq 1) ".new set aside as .new.unused-<ts>"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the active key file is unchanged"
Assert ($r.StubLog -match "compose start blackvault") "restarted on the old key"
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

# -------------------------------------------------------------- scenario RK9c
# rotate-key.bat reads .env through the same :env_value as install.bat and
# update.bat: every form Docker Compose accepts for the line counts as a key
# held in .env, and so does a line the reader refuses (Compose still passes
# something to the app for it).
Write-Scenario "rotate-key.bat - the key line in .env written with export, spaces and quotes, or in a form the reader refuses: refuses before stopping anything; the value is never printed"
$form = 0
foreach ($line in @(("export BLACKVAULT_ENCRYPTION_KEY=" + ("cd" * 32)), ("  BLACKVAULT_ENCRYPTION_KEY = '" + ("cd" * 32) + "'"), "BLACKVAULT_ENCRYPTION_KEY=`$BV_KEY", ("BLACKVAULT_ENCRYPTION_KEY: " + ("cd" * 32)))) {
  $form++
  $d = New-RotateSandbox "rotate-envkey-form$form" -WithSnapshot
  Set-Content -Path (Join-Path $d ".env") -Value @("PORT=3000", $line) -Encoding Ascii
  $keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
  $r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
  Assert ($r.ExitCode -eq 1) "[form $form] exits 1 (got $($r.ExitCode))"
  Assert ($r.Output -match "BLACKVAULT_ENCRYPTION_KEY \(from \.env\): move it into that file") "[form $form] names .env as the source"
  Assert ($r.Output -match "Nothing was changed; BlackVault was not stopped\.") "[form $form] says nothing was changed"
  if ($form -ge 3) { Assert ($r.Output -match "Note: the BLACKVAULT_ENCRYPTION_KEY line in \.env is written in a form this script does not read") "[form $form] the reader's note says which line it does not read" }
  Assert (-not $r.Output.Contains("cd" * 32)) "[form $form] the key's value is never printed"
  Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "[form $form] docker was never invoked (nothing stopped)"
  Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "[form $form] the key file is untouched"
  Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "[form $form] no .new written"
  Show-EvidenceIfFailed $r
}

# -------------------------------------------------------------- scenario RK9d
Write-Scenario "rotate-key.bat - an empty key line, a line of spaces in quotes and a commented-out key line are no key: the rotation runs"
$d = New-RotateSandbox "rotate-envkey-none" -WithSnapshot
Set-Content -Path (Join-Path $d ".env") -Value @("PORT=3000", ("# BLACKVAULT_ENCRYPTION_KEY=" + ("cd" * 32)), "BLACKVAULT_ENCRYPTION_KEY=`"  `"", "XBLACKVAULT_ENCRYPTION_KEY=abc") -Encoding Ascii
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "Your key is in") "not refused"
Assert ($r.StubLog -match "compose stop blackvault" -and $r.StubLog -match "compose start blackvault") "stopped, rotated and restarted"
Show-EvidenceIfFailed $r

# -------------------------------------------------------------- scenario RK9e
Write-Scenario "rotate-key.bat - a restore marker in the uploads folder: refuses before stopping anything, with the command that removes it"
$d = New-RotateSandbox "rotate-restore-marker" -WithSnapshot
$marker = Join-Path $d "data\uploads\.restore-20261001-101010.db-started"
New-Item -ItemType Directory -Force -Path $marker | Out-Null
$keyBefore = Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw
$r = Invoke-Bat -Dir $d -Script "rotate-key.bat"
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: the uploads folder holds a marker left by a restore: \.\\data\\uploads\\\.restore-20261001-101010\.db-started\.") "names the marker"
Assert ($r.Output -match '/bv-snapshot-restore\.sh clear-marker /app/uploads "20261001-101010"') "gives the command that removes it"
Assert ($r.Output -match "Then run rotate-key\.bat again\. Nothing was changed; BlackVault was not stopped\.") "says nothing was changed"
Assert ([string]::IsNullOrWhiteSpace(($r.StubLog -replace "(?m)^compose version.*\r?\n?", ""))) "docker was asked for its version and nothing else"
Assert ((Get-Content (Join-Path $d "secrets\blackvault_encryption_key") -Raw) -eq $keyBefore) "the key file is untouched"
Assert (-not (Test-Path (Join-Path $d "secrets\blackvault_encryption_key.new"))) "no .new written"
Assert (Test-Path $marker) "the marker is not removed by the script"
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

# =============================================================================
#                   Task 4: update scripts snapshot the uploads folder
# =============================================================================
# scripts\db-snapshot.bat also copies DATA_DIR\uploads into
# backups\uploads-<TS>\ before update.bat starts the new image, and leaves
# the path in backups\.uploads-snapshot-marker for update.bat to pass through
# as BLACKVAULT_UPLOADS_SNAPSHOT. docker-stub.cs logs that env var on its own
# "ENV BLACKVAULT_UPLOADS_SNAPSHOT=[...]" line right after "compose up -d",
# which is how UP1 below proves the marker actually reached the container's
# environment, not just that update.bat computed it.

function Add-UploadsSeed([string]$Dir) {
  $uploads = Join-Path $Dir "data\uploads"
  New-Item -ItemType Directory -Force -Path (Join-Path $uploads "documents") | Out-Null
  Set-Content -Path (Join-Path $uploads "photo1.jpg") -Value "fake jpeg bytes" -NoNewline -Encoding Ascii
  Set-Content -Path (Join-Path $uploads "documents\doc1.pdf") -Value "fake pdf bytes" -NoNewline -Encoding Ascii
}

function Get-UploadsBackups([string]$Dir) {
  $b = Join-Path $Dir "backups"
  if (-not (Test-Path $b)) { return @() }
  return @(Get-ChildItem $b -Directory | Where-Object { $_.Name -like "uploads-*" } | Sort-Object Name | ForEach-Object { $_.Name })
}

# ---------------------------------------------------------------- scenario UP1
Write-Scenario "update.bat - Task 4: snapshots the uploads folder byte-for-byte before the new image starts, ACL-restricted, and the marker reaches the container's environment"
$origin = New-GitRemote "uploads-up1" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "uploads-up1"
Set-SqliteInstall $work "7040"
Add-UploadsSeed $work
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$ups = @(Get-UploadsBackups $work)
Assert (($ups.Count -eq 1) -and ($ups[0] -match "^uploads-\d{8}-\d{6}$")) "one uploads snapshot backups\uploads-<ts> (got: $($ups -join ', '))"
if ($ups.Count -eq 1) {
  $snapDir = Join-Path $work "backups\$($ups[0])"
  Assert (Test-UserOnlyAcl $snapDir) "the uploads snapshot folder is restricted to the current user"
  Assert ((Get-Content (Join-Path $snapDir "photo1.jpg") -Raw) -eq "fake jpeg bytes") "photo1.jpg copied byte-for-byte"
  Assert ((Get-Content (Join-Path $snapDir "documents\doc1.pdf") -Raw) -eq "fake pdf bytes") "documents\doc1.pdf copied byte-for-byte (nested folder preserved)"
  Assert ($r.Output -match [regex]::Escape("Uploads snapshot saved: backups\$($ups[0])")) "prints the snapshot path"
  Assert ($r.StubLog -match [regex]::Escape("ENV BLACKVAULT_UPLOADS_SNAPSHOT=[backups\$($ups[0])]")) "the marker reached the container's environment at the 'up' that starts the new image"
}
Assert (-not (Test-Path (Join-Path $work "backups\.uploads-snapshot-marker"))) "the marker file was read once and removed, not left lying around"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UP2
Write-Scenario "update.bat - Task 4: an empty uploads folder still succeeds, takes no snapshot, and passes no marker"
$origin = New-GitRemote "uploads-up2" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "uploads-up2"
Set-SqliteInstall $work "7041" # data\uploads exists (Set-SqliteInstall creates it) and is empty
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert (@(Get-UploadsBackups $work).Count -eq 0) "no uploads snapshot directory was created"
Assert ($r.StubLog -match [regex]::Escape("ENV BLACKVAULT_UPLOADS_SNAPSHOT=[]")) "no marker was passed through (empty value)"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UP3
Write-Scenario "update.bat - Task 4: a failed uploads copy (a locked file) exits non-zero, stops the update, restarts the OLD container, and never starts the new image"
$origin = New-GitRemote "uploads-up3" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "uploads-up3"
Set-SqliteInstall $work "7042"
Add-UploadsSeed $work
$lockedFile = Join-Path $work "data\uploads\photo1.jpg"
$lockFlag = Join-Path $Sandboxes "uploads-up3-locked.flag"
Remove-Item -Force $lockFlag -ErrorAction SilentlyContinue
Remove-Item -Force "$lockFlag.release" -ErrorAction SilentlyContinue
$lockJob = Start-FileLockJob $lockedFile $lockFlag
try {
  if (-not (Wait-ForFile $lockFlag 30)) { throw "the lock job never reported it held the lock on $lockedFile" }
  $r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
} finally {
  Stop-FileLockJob $lockJob $lockFlag
}
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "database snapshot failed") "update.bat says the snapshot failed"
Assert ((Get-CallIndex $r.StubLog "compose up -d") -eq -1) "the new image was never started (no 'compose up -d')"
Assert ((Get-CallIndex $r.StubLog "compose start blackvault") -ge 0) "the old container was started again"
Assert (@(Get-UploadsBackups $work).Count -eq 0) "no uploads snapshot directory was left behind"
Assert (@(Get-ChildItem (Join-Path $work "backups") -Filter "uploads-*.partial" -ErrorAction SilentlyContinue).Count -eq 0) "no partial uploads directory left behind"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UP4
# Final review FIX 7: like scripts/uploads-snapshot.sh, the Windows copy leaves
# out the app's own plain-text .pre-encryption-* folders and the *.tmp / *.rot
# work files, so they are not copied again on every update.
Write-Scenario "update.bat - final review FIX 7: the uploads snapshot skips .pre-encryption-* folders and *.tmp / *.rot files"
$origin = New-GitRemote "uploads-up4" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "uploads-up4"
Set-SqliteInstall $work "7043"
Add-UploadsSeed $work
$up4 = Join-Path $work "data\uploads"
New-Item -ItemType Directory -Force -Path (Join-Path $up4 ".pre-encryption-x") | Out-Null
Set-Content -Path (Join-Path $up4 ".pre-encryption-x\a.jpg") -Value "plain snapshot" -NoNewline -Encoding Ascii
Set-Content -Path (Join-Path $up4 "a.jpg.rot") -Value "staged rotation" -NoNewline -Encoding Ascii
Set-Content -Path (Join-Path $up4 "a.jpg.0123abcd.tmp") -Value "half written" -NoNewline -Encoding Ascii
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "")
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$ups = @(Get-UploadsBackups $work)
Assert ($ups.Count -eq 1) "one uploads snapshot (got: $($ups -join ', '))"
if ($ups.Count -eq 1) {
  $snapDir = Join-Path $work "backups\$($ups[0])"
  Assert (Test-Path (Join-Path $snapDir "photo1.jpg")) "photo1.jpg is in the snapshot"
  Assert (Test-Path (Join-Path $snapDir "documents\doc1.pdf")) "documents\doc1.pdf is in the snapshot"
  Assert (-not (Test-Path (Join-Path $snapDir ".pre-encryption-x"))) "the .pre-encryption-x folder was not copied"
  Assert (-not (Test-Path (Join-Path $snapDir "a.jpg.rot"))) "a.jpg.rot was not copied"
  Assert (-not (Test-Path (Join-Path $snapDir "a.jpg.0123abcd.tmp"))) "a.jpg.0123abcd.tmp was not copied"
  $snapFiles = @(Get-ChildItem -LiteralPath $snapDir -Recurse -Force -File)
  Assert ($snapFiles.Count -eq 2) "exactly 2 files in the snapshot (got $($snapFiles.Count): $(($snapFiles | ForEach-Object { $_.Name }) -join ', '))"
}
Assert (Test-Path (Join-Path $up4 ".pre-encryption-x\a.jpg")) "the skipped files stay where they were in uploads"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario UP5
# Final review FIX 5: a BLACKVAULT_UPLOADS_SNAPSHOT inherited from the caller
# never reaches the `up` that starts the new image.
Write-Scenario "update.bat - final review FIX 5: an inherited BLACKVAULT_UPLOADS_SNAPSHOT is cleared before 'up'"
$origin = New-GitRemote "uploads-up5" (Join-Path $RepoRoot "update.bat")
$work = New-WorkingClone $origin "uploads-up5"
Set-SqliteInstall $work "7044" # empty uploads: no marker of its own
$r = Invoke-Bat -Dir $work -Script "update.bat" -Answers @("https://vault.example.com", "", "") -EnvVars @{ "BLACKVAULT_UPLOADS_SNAPSHOT" = "backups\uploads-stale" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.StubLog -match [regex]::Escape("ENV BLACKVAULT_UPLOADS_SNAPSHOT=[]")) "the 'up' saw an empty value"
Assert (-not ($r.StubLog -match "uploads-stale")) "the inherited value never reached the stub"
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

# ══════════════════════════════════════════════════════════════════════════
# backup.bat (full backups, Task 6)
# ══════════════════════════════════════════════════════════════════════════
# The docker stub stands in for the backup program: it records the argv it
# was called with (the stub log), every byte it got on standard input
# (BV_STUB_STDIN_FILE) and its whole environment (BV_STUB_ENV_FILE). That is
# how "the passphrase reaches the program on stdin and nowhere else" is
# checked on the real script. What the program itself does with --keep and
# --verify is covered on Linux (scripts/full-backup-cli.test.ts).
#
# NOT covered here: the typed passphrase (Read-Host -AsSecureString, asked
# twice, the mismatch refusal). The harness has no console - standard input
# is always redirected - so only "no console and no --passphrase-file: exit 1
# at once" can be run. The typed path shares everything after the prompt
# (starting docker, writing the pipe, the exit code) with the file path.

$BackupPass = " bat tëst 'pass' `"phrase`" %PATH% ^ & | * "
$BackupOkLine = "BLACKVAULT_FULL_BACKUP_OK file=blackvault-full-20261002-180405.bvb files=2 bytes=10 archive_bytes=99 skipped=0 unreadable=0"
$BackupExec = "compose exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs"
$BackupRun = "compose run --rm -T blackvault node dist/scripts/full-backup.mjs"

function New-BackupSandbox([string]$Name, [string[]]$EnvLines = @("PORT=3000", "BLACKVAULT_DB_PROVIDER=sqlite")) {
  $dir = Join-Path $Sandboxes $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($f in @("backup.bat", "docker-compose.yml")) { Copy-Item (Join-Path $RepoRoot $f) $dir }
  [IO.File]::WriteAllText((Join-Path $dir ".env"), (($EnvLines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)
  return $dir
}

# Writes the passphrase file as UTF-8 without a byte-order mark and returns its path.
function New-PassFile([string]$Dir, [string]$Content, [string]$Name = "pass.txt") {
  $p = Join-Path $Dir $Name
  [IO.File]::WriteAllBytes($p, (New-Object Text.UTF8Encoding($false)).GetBytes($Content))
  return $p
}

function Invoke-Backup([string]$Dir, [string]$BatArgs, [hashtable]$EnvVars = @{}, [int]$TimeoutSeconds = 120) {
  $vars = @{ "BV_STUB_STDIN_FILE" = (Join-Path $Dir "__stdin.bin"); "BV_STUB_ENV_FILE" = (Join-Path $Dir "__env.txt"); "BV_STUB_APP_RUNNING" = $null; "BV_STUB_BACKUP_EXIT" = $null; "BV_STUB_BACKUP_STDOUT" = $null; "BV_STUB_BACKUP_STDERR" = $null; "BV_STUB_BACKUP_SLEEP_MS" = $null; "BLACKVAULT_BACKUP_TIMEOUT" = $null; "BLACKVAULT_BACKUP_DIR" = $null }
  foreach ($k in $EnvVars.Keys) { $vars[$k] = $EnvVars[$k] }
  Remove-Item -Force $vars["BV_STUB_STDIN_FILE"], $vars["BV_STUB_ENV_FILE"] -ErrorAction SilentlyContinue
  return Invoke-Bat -Dir $Dir -Script "backup.bat" -BatArgs $BatArgs -EnvVars $vars -NoPad -TimeoutSeconds $TimeoutSeconds
}

function Get-BackupCalls([pscustomobject]$Result) {
  return @($Result.StubLog -split "`r?`n" | Where-Object { $_ -match "full-backup\.mjs" })
}

# ---------------------------------------------------------------- scenario BK1
Write-Scenario "backup.bat - --passphrase-file, app running: exec -T -u 1001:1001 with --keep 7; the file's bytes arrive on stdin unchanged; the passphrase is in no argv and no environment"
$d = New-BackupSandbox "backup-running"
$passBytesText = "$BackupPass`r`n`n"
$pf = New-PassFile $d $passBytesText
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_BACKUP_STDOUT" = $BackupOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$calls = @(Get-BackupCalls $r)
Assert ($calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --keep 7") "exactly one backup call: '$BackupExec --keep 7' (got: $($calls -join ' || '))"
Assert ($r.StubLog -match "compose ps --status running -q blackvault") "asked whether the app is running"
$stdinFile = Join-Path $d "__stdin.bin"
$expected = (New-Object Text.UTF8Encoding($false)).GetBytes($passBytesText)
# Not `$got = if (...) {...} else { [byte[]]@() }`: an `if` that yields an
# empty array yields $null, and ToBase64String($null) throws.
Assert (Test-Path $stdinFile) "the backup program's standard input was recorded (it was started)"
$gotLength = if (Test-Path $stdinFile) { (Get-Item $stdinFile).Length } else { -1 }
Assert ((Get-FileBase64 $stdinFile) -eq [Convert]::ToBase64String($expected)) "stdin is the passphrase file byte for byte ($gotLength bytes, expected $($expected.Length)): nothing stripped, no byte-order mark added"
Assert (-not $r.StubLog.Contains("bat t")) "the passphrase is in no docker argv"
$envDump = if (Test-Path (Join-Path $d "__env.txt")) { [IO.File]::ReadAllText((Join-Path $d "__env.txt")) } else { "" }
Assert ($envDump.Contains("BV_DOCKER_ARGS=")) "the environment of the backup call was recorded"
Assert (-not $envDump.Contains("bat t") -and -not $envDump.Contains("'pass'")) "the passphrase is not in the environment docker inherited"
Assert ($r.Output.Contains($BackupOkLine)) "the program's OK line is passed through"
Assert (-not $r.Output.Contains("bat t")) "the passphrase is never printed"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK2
Write-Scenario "backup.bat - app stopped: a one-off container, 'run --rm -T' with no --user and no --no-deps; --keep is passed through normalised"
$d = New-BackupSandbox "backup-stopped"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--keep 03 --passphrase-file `"$pf`""
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$calls = @(Get-BackupCalls $r)
Assert ($calls.Count -eq 1 -and $calls[0] -eq "$BackupRun --keep 3") "exactly one backup call: '$BackupRun --keep 3' (got: $($calls -join ' || '))"
Assert ($r.StubLog -notmatch "--user|--no-deps") "no --user and no --no-deps"
$got = if (Test-Path (Join-Path $d "__stdin.bin")) { [IO.File]::ReadAllText((Join-Path $d "__stdin.bin"), (New-Object Text.UTF8Encoding($false))) } else { "" }
Assert ($got -eq "$BackupPass`n") "the passphrase arrived on stdin"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK3
Write-Scenario "backup.bat - no --passphrase-file and no console (Task Scheduler): exits 1 at once with one clear line, docker never called, nothing waits"
$d = New-BackupSandbox "backup-no-console"
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-Backup $d "" @{ "BV_STUB_APP_RUNNING" = "1" } 60
$sw.Stop()
Assert ($r.ExitCode -eq 1) "exits 1, not a timeout (got $($r.ExitCode))"
Assert ($sw.Elapsed.TotalSeconds -lt 30) "returned promptly ($([int]$sw.Elapsed.TotalSeconds) s)"
Assert ($r.Output -match "ERROR: no passphrase: standard input is not a console") "says why"
Assert ($r.Output -match "--passphrase-file") "says what to do"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK4
Write-Scenario "backup.bat - the lock: the program's exit 2 is passed through unchanged, from exec and from a one-off container"
$d = New-BackupSandbox "backup-exit2"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_BACKUP_EXIT" = "2"; "BV_STUB_BACKUP_STDERR" = "full-backup: Another full backup is already running (pid 7 on abc)." }
Assert ($r.ExitCode -eq 2) "exec: exits 2 (got $($r.ExitCode))"
Assert ($r.Output -match "Another full backup is already running") "the program's message is shown"
Assert ($r.Output -notmatch "ERROR:") "the wrapper adds no error line of its own"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_BACKUP_EXIT" = "2" }
Assert ($r.ExitCode -eq 2) "run: exits 2 (got $($r.ExitCode))"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK5
Write-Scenario "backup.bat - exit codes: the program's 1 stays 1; anything else becomes 1 with one ERROR line"
$d = New-BackupSandbox "backup-exit-codes"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_BACKUP_EXIT" = "1"; "BV_STUB_BACKUP_STDERR" = "full-backup: The backup folder /app/backups is not writable (EACCES)." }
Assert ($r.ExitCode -eq 1) "exit 1 stays 1 (got $($r.ExitCode))"
Assert ($r.Output -match "The backup folder /app/backups is not writable") "the program's message is shown"
Assert ($r.Output -notmatch "ended unexpectedly") "nothing added for exit 1"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_BACKUP_EXIT" = "137" }
Assert ($r.ExitCode -eq 1) "exit 137 becomes 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: the backup command ended unexpectedly \(exit 137\)") "says the command ended unexpectedly"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK6
Write-Scenario "backup.bat - a bad --keep, --keep with --verify, a missing or empty passphrase file, an unknown argument: exit 1 before docker is touched"
$d = New-BackupSandbox "backup-bad-args"
$pf = New-PassFile $d "$BackupPass`n"
# "1;2": Windows CI (fa9f32f) showed for /f drops a value whose first
# character AFTER its leading delimiters is ";", not only one that starts
# with it - the same hole as "a;b.bvb" in BK9. It is passed in quotes:
# unquoted, cmd.exe itself splits the argument at the semicolon.
foreach ($bad in @("0", "000", "-1", "1.5", "seven", "1000000", "`"1;2`"")) {
  $r = Invoke-Backup $d "--keep $bad --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
  Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: --keep needs a whole number" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "--keep $bad refused, docker never invoked (exit $($r.ExitCode))"
  Show-EvidenceIfFailed $r
}
$r = Invoke-Backup $d "--keep `";3`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: --keep needs a whole number" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "--keep `";3`" (a leading semicolon, for /f's eol character) refused, docker never invoked (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--verify x.bvb --keep 2 --passphrase-file `"$pf`""
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: --keep cannot be used with --verify" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "--keep with --verify refused (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase-file `"$(Join-Path $d 'nope.txt')`""
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: cannot read the passphrase file" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "a missing passphrase file is refused (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$empty = New-PassFile $d "" "empty.txt"
$r = Invoke-Backup $d "--passphrase-file `"$empty`""
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: the passphrase file .* is empty" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "an empty passphrase file is refused (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase typed-here-by-mistake"
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: unknown argument") "an unknown argument is refused (exit $($r.ExitCode))"
Assert (-not $r.Output.Contains("typed-here-by-mistake")) "and is not echoed back"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK7
Write-Scenario "backup.bat - Docker Compose too old: exit 1 with one line, the backup program never started"
$d = New-BackupSandbox "backup-old-compose"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_COMPOSE_VERSION" = "2.19.0" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: BlackVault needs Docker Compose v2\.20 or newer") "explains the v2.20 requirement"
Assert (@(Get-BackupCalls $r).Count -eq 0) "the backup program was never started"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK8
Write-Scenario "backup.bat - --verify: a bare name, and a path inside the backup folder (default, DATA_DIR, BLACKVAULT_BACKUP_DIR), map to the file name; no --keep is passed"
$name = "blackvault-full-20261002-180405.bvb"
$d = New-BackupSandbox "backup-verify"
$pf = New-PassFile $d "$BackupPass`n"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\backups") | Out-Null
$r = Invoke-Backup $d "--verify $name --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --verify $name") "bare name: '$BackupExec --verify $name' (exit $($r.ExitCode); got: $($calls -join ' || '))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--verify `"$(Join-Path $d "data\backups\$name")`" --passphrase-file `"$pf`""
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupRun --verify $name") "absolute path in the default folder, app stopped: '$BackupRun --verify $name' (exit $($r.ExitCode); got: $($calls -join ' || '))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--verify data\backups\$name --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --verify $name") "relative path (the harness runs it from the install folder) maps too (exit $($r.ExitCode); got: $($calls -join ' || '))"
Show-EvidenceIfFailed $r

$dataDir = Join-Path $Sandboxes "backup verify data"
$nas = Join-Path $Sandboxes "backup-verify-nas"
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "backups"), $nas | Out-Null
$d = New-BackupSandbox "backup-verify-datadir" @("DATA_DIR=$dataDir")
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--verify `"$(Join-Path $dataDir "backups\$name")`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --verify $name") "follows DATA_DIR (a path with a space) (exit $($r.ExitCode); got: $($calls -join ' || '))"
Show-EvidenceIfFailed $r
$d = New-BackupSandbox "backup-verify-nas-env" @("DATA_DIR=$dataDir", "BLACKVAULT_BACKUP_DIR=$nas")
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--verify `"$(Join-Path $nas $name)`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --verify $name") "follows BLACKVAULT_BACKUP_DIR (exit $($r.ExitCode); got: $($calls -join ' || '))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--verify `"$(Join-Path $dataDir "backups\$name")`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 1 -and @(Get-BackupCalls $r).Count -eq 0) "with BLACKVAULT_BACKUP_DIR set, DATA_DIR\backups is no longer the backup folder (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK8b
Write-Scenario "backup.bat --verify - .env forms: an export line with a comment is followed; a double-quoted Windows path is refused before docker is touched"
$name = "blackvault-full-20261002-180405.bvb"
$dataDir = Join-Path $Sandboxes "backup-envforms-data"
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir "backups") | Out-Null
$d = New-BackupSandbox "backup-envforms-read" @("export DATA_DIR = $dataDir # the data")
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--verify `"$(Join-Path $dataDir "backups\$name")`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --verify $name") "follows 'export DATA_DIR = path # comment' (exit $($r.ExitCode); got: $($calls -join ' || '))"
Show-EvidenceIfFailed $r
$d = New-BackupSandbox "backup-envforms-refused" @("DATA_DIR=`"$dataDir`"")
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--verify `"$(Join-Path $dataDir "backups\$name")`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 1) "a double-quoted path: exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "Note: the DATA_DIR line in \.env is written in a form this script does not read") "says which line it does not read"
Assert ($r.Output -match "ERROR: \.env holds a line this script does not read") "says why it stopped"
Assert (@(Get-BackupCalls $r).Count -eq 0) "the backup program was never started"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario BK9
Write-Scenario "backup.bat - --verify with a path OUTSIDE the backup folder, or a name that is not a file name: exit 1, the backup program never started"
$d = New-BackupSandbox "backup-verify-outside"
$pf = New-PassFile $d "$BackupPass`n"
New-Item -ItemType Directory -Force -Path (Join-Path $d "data\backups\sub") | Out-Null
foreach ($outside in @((Join-Path $Sandboxes $name), (Join-Path $d "data\$name"), (Join-Path $d "data\backups\sub\$name"), "..\$name")) {
  $r = Invoke-Backup $d "--verify `"$outside`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
  Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: --verify: .* is not in the backup folder" -and @(Get-BackupCalls $r).Count -eq 0) "refused: $outside (exit $($r.ExitCode))"
  Show-EvidenceIfFailed $r
}
# Fix round 1: for /f skips a value that starts with ";" (its default eol
# character), so ";a b.bvb" used to pass the character check and reach the
# backup program as extra arguments. A leading ";" is refused outright.
foreach ($badName in @("-x.bvb", "a b.bvb", "a;b.bvb", ";a b.bvb", ";x.bvb")) {
  $r = Invoke-Backup $d "--verify `"$badName`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
  Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: --verify: that is not a backup file name" -and @(Get-BackupCalls $r).Count -eq 0) "refused as a name: $badName (exit $($r.ExitCode))"
  Show-EvidenceIfFailed $r
}

# --------------------------------------------------------------- scenario BK10
Write-Scenario "backup.bat - BLACKVAULT_* set in the console do not reach docker; BLACKVAULT_BACKUP_TIMEOUT ends a run that takes too long with exit 1"
$d = New-BackupSandbox "backup-env-timeout"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BLACKVAULT_BACKUP_DIR" = "C:\somewhere\else"; "BLACKVAULT_DATABASE_URL" = "file:./dev.db" }
$envDump = if (Test-Path (Join-Path $d "__env.txt")) { [IO.File]::ReadAllText((Join-Path $d "__env.txt")) } else { "MISSING" }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($envDump -ne "MISSING" -and $envDump -notmatch "BLACKVAULT_BACKUP_DIR=|BLACKVAULT_DATABASE_URL=") "docker compose would read those keys from .env only"
Show-EvidenceIfFailed $r
$sw = [Diagnostics.Stopwatch]::StartNew()
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_BACKUP_SLEEP_MS" = "30000"; "BLACKVAULT_BACKUP_TIMEOUT" = "2" } 90
$sw.Stop()
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: the backup did not finish within 2 seconds \(BLACKVAULT_BACKUP_TIMEOUT\)") "says the limit was reached"
Assert ($sw.Elapsed.TotalSeconds -lt 25) "did not wait for the program to finish ($([int]$sw.Elapsed.TotalSeconds) s)"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BLACKVAULT_BACKUP_TIMEOUT" = ";5 x" }
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: BLACKVAULT_BACKUP_TIMEOUT must be a number of seconds" -and @(Get-BackupCalls $r).Count -eq 0) "a limit starting with a semicolon is refused before the program starts (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BLACKVAULT_BACKUP_TIMEOUT" = "5;5" }
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: BLACKVAULT_BACKUP_TIMEOUT must be a number of seconds" -and @(Get-BackupCalls $r).Count -eq 0) "a limit with a semicolon after a digit is refused before the program starts (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Backup $d "--passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BLACKVAULT_BACKUP_TIMEOUT" = "6h" }
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: BLACKVAULT_BACKUP_TIMEOUT must be a number of seconds" -and @(Get-BackupCalls $r).Count -eq 0) "a non-numeric limit is refused before the program starts (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario BK11
# Windows CI (269a53f): the argument parser used a bare `shift`, which moves
# the arguments into %0 too, so `cd /d "%~dp0"` went to the folder of the
# LAST argument - the passphrase file. Every scenario above keeps that file
# in the install folder, which hid it.
Write-Scenario "backup.bat - the passphrase file lives in ANOTHER folder: the script still works from its own folder (.env is read there)"
$elsewhere = Join-Path $Sandboxes "backup-pass-elsewhere-secrets"
$nas2 = Join-Path $Sandboxes "backup-pass-elsewhere-nas"
New-Item -ItemType Directory -Force -Path $elsewhere, $nas2 | Out-Null
$d = New-BackupSandbox "backup-pass-elsewhere" @("BLACKVAULT_BACKUP_DIR=$nas2")
$pf = New-PassFile $elsewhere "$BackupPass`n"
$r = Invoke-Backup $d "--verify `"$(Join-Path $nas2 $name)`" --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1" }
$calls = @(Get-BackupCalls $r)
Assert ($r.ExitCode -eq 0 -and $calls.Count -eq 1 -and $calls[0] -eq "$BackupExec --verify $name") "BLACKVAULT_BACKUP_DIR was read from the .env beside the script (exit $($r.ExitCode); got: $($calls -join ' || '))"
$got = if (Test-Path (Join-Path $d "__stdin.bin")) { [IO.File]::ReadAllText((Join-Path $d "__stdin.bin"), (New-Object Text.UTF8Encoding($false))) } else { "" }
Assert ($got -eq "$BackupPass`n") "the passphrase arrived on stdin"
Show-EvidenceIfFailed $r

# ══════════════════════════════════════════════════════════════════════════
# restore.bat (full restore, Task 7)
# ══════════════════════════════════════════════════════════════════════════
# REAL here: restore.bat and scripts\db-snapshot.bat (the snapshot is really
# copied into backups\). STUBBED: the check program (full-backup.mjs
# --verify, knobs BV_STUB_BACKUP_*), the restore program (full-restore.mjs,
# knobs BV_STUB_RESTORE_*), psql, and the rollback container
# (/bv-snapshot-restore.sh, knob BV_STUB_ROLLBACK_EXIT). So these scenarios
# prove the ORDER of the docker calls, what is passed, where the passphrase
# goes and the exit codes. They do NOT prove what the rollback does to files:
# scripts/snapshot-restore.sh runs inside a Linux container, and is proven
# on Linux (src/lib/backup/full-restore.real-db.test.ts,
# scripts/full-restore-wrapper.test.ts).
#
# NOT covered here: the typed passphrase and the typed RESTORE confirmation
# (the harness has no console; standard input is always redirected). Only
# "no console: exit 1 at once" can be run for both.
#
# restore.bat starts docker through the SAME PowerShell line as backup.bat.
# Ruling R27: ONE PowerShell process reads the passphrase once, runs the
# check, then steps 5-7 (restore.bat again, in a child cmd.exe), then the
# restore. What these scenarios prove of that: both programs get the
# passphrase file's bytes on stdin (RS1), the docker calls keep their order
# through the child (RS1, RS2, RS7), a refusal in the child stops the restore
# and is reported once (RS8), and a failed check never reaches the child
# (RS4). That the PROMPT appears once cannot be run here.
# Every scenario below prints the script's whole output and the stub log
# when one of its checks fails (Show-EvidenceIfFailed).

$RestoreName = "blackvault-full-20261002-180405.bvb"
$RestoreVerify = "compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify $RestoreName"
$RestoreOkLine = "BLACKVAULT_FULL_RESTORE_OK file=$RestoreName files=2 bytes=10 pre_restore=.pre-restore-20261003-000000"
$RestorePs = "compose ps --status running -q blackvault"
$RestoreLockStatus = "compose exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs --lock-status"
$RestoreLockHeld = "BLACKVAULT_FULL_BACKUP_LOCK state=held pid=57 hostname=0123456789ab started=2026-10-03T03:15:00.000Z"

function New-RestoreSandbox([string]$Name, [switch]$Postgres) {
  $dir = Join-Path $Sandboxes $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($f in @("restore.bat", "docker-compose.yml", "scripts\db-snapshot.bat", "scripts\snapshot-restore.sh")) { Copy-RepoFile $f $dir }
  New-Item -ItemType Directory -Force -Path (Join-Path $dir "data\db") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $dir "data\backups") | Out-Null
  Add-UploadsSeed $dir
  if ($Postgres) {
    $envLines = @("COMPOSE_PROFILES=postgres", "BLACKVAULT_DB_PROVIDER=postgres", "BLACKVAULT_POSTGRES_PASSWORD=x", "BLACKVAULT_DATABASE_URL=postgresql://blackvault:x@db:5432/blackvault")
  } else {
    Set-Content -Path (Join-Path $dir "data\db\vault.db") -Value "the database as it was" -NoNewline -Encoding Ascii
    $envLines = @("PORT=3000", "BLACKVAULT_DB_PROVIDER=sqlite")
  }
  [IO.File]::WriteAllText((Join-Path $dir ".env"), (($envLines -join "`r`n") + "`r`n"), [Text.Encoding]::ASCII)
  return $dir
}

function Invoke-Restore([string]$Dir, [string]$BatArgs, [hashtable]$EnvVars = @{}, [int]$TimeoutSeconds = 180, [string]$InvokeAs = "", [string]$WorkDir = "") {
  $vars = @{
    "BV_STUB_STDIN_FILE" = (Join-Path $Dir "__stdin-verify.bin"); "BV_STUB_RESTORE_STDIN_FILE" = (Join-Path $Dir "__stdin-restore.bin"); "BV_STUB_ENV_FILE" = (Join-Path $Dir "__env.txt")
    "BV_STUB_BACKUP_EXIT" = $null; "BV_STUB_BACKUP_STDOUT" = $null; "BV_STUB_BACKUP_STDERR" = $null; "BV_STUB_BACKUP_SLEEP_MS" = $null
    "BV_STUB_RESTORE_EXIT" = $null; "BV_STUB_RESTORE_STDOUT" = $null; "BV_STUB_RESTORE_STDERR" = $null; "BV_STUB_ROLLBACK_EXIT" = $null
    "BV_STUB_RESTORE_MARKER_DIR" = $null; "BV_STUB_RESTORE_RECOVERY_COPY" = (Join-Path $Dir "__recovery-during.txt"); "DATA_DIR" = $null
    "BV_STUB_APP_RUNNING" = $null; "BLACKVAULT_BACKUP_TIMEOUT" = $null; "BLACKVAULT_BACKUP_DIR" = $null
    "BV_RESTORE_PHASE" = $null; "BV_HANDOFF" = $null
    "BV_STUB_LOCK_EXIT" = $null; "BV_STUB_LOCK_STDOUT" = $null; "BV_STUB_LOCK_STDERR" = $null
    "BV_STUB_STATE_ANSWER" = $null; "BV_STUB_HANDOFF_READONLY" = $null; "BV_STUB_CLEAR_MARKER_EXIT" = $null
    "BV_STUB_MARKERS_ANSWER" = $null; "BV_STUB_RECOVERY_READONLY" = $null
  }
  foreach ($k in $EnvVars.Keys) { $vars[$k] = $EnvVars[$k] }
  Remove-Item -Force $vars["BV_STUB_STDIN_FILE"], $vars["BV_STUB_RESTORE_STDIN_FILE"], $vars["BV_STUB_ENV_FILE"], (Join-Path $Dir "__recovery-during.txt") -ErrorAction SilentlyContinue
  return Invoke-Bat -Dir $Dir -Script "restore.bat" -BatArgs $BatArgs -EnvVars $vars -NoPad -TimeoutSeconds $TimeoutSeconds -InvokeAs $InvokeAs -WorkDir $WorkDir
}

# Runs ONE command line in cmd.exe the way a user pastes it at a Command
# Prompt: `cmd /d /s /c "<line>"`, so it is read as a command line, not as a
# batch file (a `for` variable is %S there, %%S in a batch file). The stub
# docker is first on PATH; -StateAnswer is what it prints for
# `/bv-snapshot-restore.sh state`. Standard input is empty. Returns the same
# object as Invoke-Bat (ExitCode, Output, StubLog, Dir).
function Invoke-CmdLine([string]$Dir, [string]$Line, [string]$StateAnswer, [int]$TimeoutSeconds = 120) {
  $logFile = Join-Path $Dir "__stub.log"
  Remove-Item -Force $logFile -ErrorAction SilentlyContinue
  $saved = @{}
  $vars = @{ "BV_STUB_LOG" = $logFile; "BV_STUB_COMPOSE_VERSION" = "2.30.1"; "BV_STUB_FAIL_ON" = $null; "BV_STUB_ROLLBACK_EXIT" = $null; "BV_STUB_STATE_ANSWER" = $StateAnswer }
  foreach ($k in $vars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k)
    [Environment]::SetEnvironmentVariable($k, $vars[$k])
  }
  $oldPath = $env:PATH
  $env:PATH = "$StubDir;$oldPath"
  $timedOut = $false
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    # /s: strip exactly the outer pair of quotes; the line's own quotes stay.
    $psi.Arguments = "/d /s /c `"$Line`""
    $psi.WorkingDirectory = $Dir
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $p = [System.Diagnostics.Process]::Start($psi)
    $p.StandardInput.Close()
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
  if ($timedOut) { $out += "`r`n[harness] TIMED OUT after $TimeoutSeconds s; process tree killed`r`n" }
  $stub = if (Test-Path $logFile) { (Get-Content $logFile -Raw) } else { "" }
  if ($null -eq $stub) { $stub = "" }
  if ($null -eq $out) { $out = "" }
  return [pscustomobject]@{ ExitCode = $code; Output = $out; StubLog = $stub; Dir = $Dir }
}

# The stub log's lines without the Compose version probes.
function Get-RestoreSteps([pscustomobject]$Result) {
  return @($Result.StubLog -split "`r?`n" | Where-Object { $_ -and $_ -ne "compose version --short" -and $_ -notmatch "^ENV " })
}

# Index of the first step matching the regular expression; -1 when absent.
function Get-StepIndex([string[]]$Steps, [string]$Pattern) {
  for ($i = 0; $i -lt $Steps.Count; $i++) { if ($Steps[$i] -match $Pattern) { return $i } }
  return -1
}

# The restore-<time>-RECOVERY.txt files in backups\ (ruling R25).
function Get-RecoveryFiles([string]$Dir) {
  return @(Get-Backups $Dir | Where-Object { $_ -match '^restore-\d{8}-\d{6}-RECOVERY\.txt$' })
}

# The HOST uploads folder of a restore sandbox: where the stub leaves the
# "database step started" marker (ruling R24) when a scenario asks for it.
function Get-UploadsDir([string]$Dir) { return (Join-Path $Dir "data\uploads") }

$RestoreCallPattern = '^compose run --rm -T --name blackvault-restore-(\d{8}-\d{6}) blackvault node dist/scripts/full-restore\.mjs --stamp \1 ' + [regex]::Escape($RestoreName) + '$'

# ---------------------------------------------------------------- scenario RS1
Write-Scenario "restore.bat - success (SQLite): check, stop, snapshot, restore, start - in that order; the passphrase file reaches BOTH programs on stdin; it is in no argv and no environment"
$d = New-RestoreSandbox "restore-ok"
$passBytesText = "$BackupPass`r`n`n"
$pf = New-PassFile $d $passBytesText
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$iVerify = Get-StepIndex $steps ([regex]::Escape($RestoreVerify) + '$')
$iStop = Get-StepIndex $steps '^compose stop blackvault$'
$iRestore = Get-StepIndex $steps $RestoreCallPattern
$iUp = Get-StepIndex $steps '^compose up -d$'
$during = if (Test-Path (Join-Path $d "__recovery-during.txt")) { [IO.File]::ReadAllText((Join-Path $d "__recovery-during.txt")) } else { "" }
Assert ($during -match "BlackVault restore \d{8}-\d{6}: RECOVERY") "R25: the recovery file existed WHILE the restore ran"
Assert ($during -match "database: backups\\blackvault-\d{8}-\d{6}\.db" -and $during -match "docker stop blackvault-restore-\d{8}-\d{6}" -and $during -match "/bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}") "R25: it names the snapshot, the container to stop, and the rollback commands"
Assert ($during -match "/bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}" -and $during -match "complete\s+The restore FINISHED" -and $during -match "started\s+The restore had reached the database" -and $during -match "untouched\s+The restore never reached the database") "R28: it tells the three states apart, and how to find out which one it is"
Assert ($during -match "(?m)^  docker compose run [^\r\n]* /bv-snapshot-restore\.sh uploads /app/uploads \d{8}-\d{6} /bv-backups/uploads-\d{8}-\d{6} && docker compose run [^\r\n]* /bv-snapshot-restore\.sh sqlite [^\r\n]* && docker compose run [^\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}\s*$") "the rollback is ONE command line joined with &&: clear-marker runs only if the uploads and the database lines worked"
Assert ($during -notmatch "(?m)^  docker compose run [^&\r\n]* /bv-snapshot-restore\.sh clear-marker ") "clear-marker is never a line of its own"
Assert ($r.Output.Contains("How to put it back is in")) "R25: it was printed before the restore started"
Assert (@(Get-RecoveryFiles $d).Count -eq 0) "R25: it is gone after a successful restore"
Assert ($iVerify -eq 0) "the first call is the check: '$RestoreVerify' (index $iVerify)"
Assert ($iStop -gt $iVerify -and $iRestore -gt $iStop -and $iUp -gt $iRestore) "order: check ($iVerify), stop ($iStop), restore in a NAMED container ($iRestore), start ($iUp)"
Assert (@($steps | Where-Object { $_ -match "full-restore\.mjs|full-backup\.mjs" } | Where-Object { $_ -match "--user|--no-deps" }).Count -eq 0) "the two program calls have no --user and no --no-deps"
Assert (@($steps | Where-Object { $_ -match "bv-snapshot-restore" }).Count -eq 0) "no rollback container was started"
Assert ((Get-StepIndex $steps ('^' + [regex]::Escape($RestorePs) + '$')) -gt $iVerify -and (Get-StepIndex $steps ('^' + [regex]::Escape($RestorePs) + '$')) -lt $iStop) "before the stop it asks whether BlackVault is running"
Assert ((Get-StepIndex $steps '--lock-status') -eq -1) "BlackVault is not running: nobody is asked about the lock"
$snaps = @(Get-Backups $d | Where-Object { $_ -match '^blackvault-\d{8}-\d{6}\.db$' })
Assert ($snaps.Count -eq 1) "the database snapshot was taken into backups\ before the restore (found: $($snaps -join ', '))"
Assert (@(Get-UploadsBackups $d).Count -eq 1) "the uploads snapshot was taken"
Assert (-not (Test-Path (Join-Path $d "backups\.uploads-snapshot-marker"))) "the uploads-snapshot marker was cleared"
$expected = [Convert]::ToBase64String((New-Object Text.UTF8Encoding($false)).GetBytes($passBytesText))
Assert ((Get-FileBase64 (Join-Path $d "__stdin-verify.bin")) -eq $expected) "the check program got the passphrase file byte for byte on stdin"
Assert ((Get-FileBase64 (Join-Path $d "__stdin-restore.bin")) -eq $expected) "the restore program got the passphrase file byte for byte on stdin"
Assert (-not $r.StubLog.Contains("bat t")) "the passphrase is in no docker argv"
$envDump = if (Test-Path (Join-Path $d "__env.txt")) { [IO.File]::ReadAllText((Join-Path $d "__env.txt")) } else { "" }
Assert ($envDump.Contains("BV_DOCKER_ARGS=")) "the environment of the program call was recorded"
Assert (-not $envDump.Contains("bat t") -and -not $envDump.Contains("'pass'")) "the passphrase is not in the environment docker inherited"
Assert ($r.Output.Contains($RestoreOkLine)) "the restore program's OK line is passed through"
Assert ($r.Output.Contains("Restore complete.")) "says the restore is complete"
Assert (-not $r.Output.Contains("bat t")) "the passphrase is never printed"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS2
Write-Scenario "restore.bat - the restore fails AFTER reaching the database (marker present, SQLite): uploads, database, clear the marker, start - in that order; exit 1; the last line says nothing is changed"
$d = New-RestoreSandbox "restore-fails"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "1"; "BV_STUB_RESTORE_STDERR" = "full-restore: [stub] failed."; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d) }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$iRestore = Get-StepIndex $steps 'full-restore\.mjs --stamp \d{8}-\d{6} '
$stamp = if ($iRestore -ge 0 -and $steps[$iRestore] -match '--stamp (\d{8}-\d{6}) ') { $Matches[1] } else { "" }
$dbSnap = @(Get-Backups $d | Where-Object { $_ -match '^blackvault-\d{8}-\d{6}\.db$' }) | Select-Object -First 1
$upSnap = @(Get-UploadsBackups $d) | Select-Object -First 1
$iDb = Get-StepIndex $steps ('--user 0:0 --entrypoint /bin/sh .*backups:/bv-backups:ro .*snapshot-restore\.sh:/bv-snapshot-restore\.sh:ro blackvault /bv-snapshot-restore\.sh sqlite /bv-backups/' + [regex]::Escape("$dbSnap") + ' /app/data/vault\.db /app/uploads ' + [regex]::Escape($stamp) + '$')
$iUploads = Get-StepIndex $steps ('blackvault /bv-snapshot-restore\.sh uploads /app/uploads ' + [regex]::Escape($stamp) + ' /bv-backups/' + [regex]::Escape("$upSnap") + '\s*$')
$iUp = Get-StepIndex $steps '^compose up -d$'
Assert ($iRestore -ge 0 -and $stamp) "the restore program was started with a stamp ($stamp)"
$iClear = Get-StepIndex $steps ('blackvault /bv-snapshot-restore\.sh clear-marker /app/uploads ' + [regex]::Escape($stamp) + '\s*$')
Assert ($iUploads -gt $iRestore) "first the uploads are put back from backups\$upSnap with the same stamp (index $iUploads)"
Assert ($iDb -gt $iUploads) "then the database is put back from backups\$dbSnap, as root, backups mounted read-only (index $iDb)"
Assert ($iClear -gt $iDb) "then the marker is cleared (index $iClear)"
Assert ($iUp -gt $iClear) "then BlackVault is started (index $iUp)"
Assert (@(Get-RecoveryFiles $d).Count -eq 0) "R25: the recovery file is gone after a successful rollback"
Assert ($r.Output -match "ERROR: the restore failed \(the reason is above\)\. The database and the uploads were put back from the snapshot taken before it \(backups\\blackvault-\d{8}-\d{6}\.db\), so nothing is changed\. BlackVault was started again\.") "the last line says it was rolled back and nothing is changed"
Assert ($r.Output.Contains("full-restore: [stub] failed.")) "the program's own reason is shown"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS3
Write-Scenario "restore.bat - the rollback itself fails: BlackVault is NOT started; the snapshot and the commands to put it back are printed"
$d = New-RestoreSandbox "restore-rollback-fails"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "137"; "BV_STUB_ROLLBACK_EXIT" = "1"; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d) }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps '^compose up -d$') -eq -1) "BlackVault was NOT started"
Assert (@($steps | Where-Object { $_ -match "bv-snapshot-restore\.sh (sqlite|uploads) " }).Count -eq 2) "both rollback steps were attempted"
Assert ($r.Output.Contains("ERROR: the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started. What to do is in")) "says the rollback failed, the app was not started, and where the recovery file is"
Assert (@(Get-RecoveryFiles $d).Count -eq 1) "R25: the recovery file stays after a failed rollback"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh clear-marker') -eq -1) "the marker is not cleared after a failed rollback"
Assert ($r.Output -match "database: backups\\blackvault-\d{8}-\d{6}\.db") "names the database snapshot"
Assert ($r.Output -match "uploads:\s+backups\\uploads-\d{8}-\d{6}") "names the uploads snapshot"
Assert ($r.Output -match "docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh .* /bv-snapshot-restore\.sh sqlite /bv-backups/blackvault-\d{8}-\d{6}\.db /app/data/vault\.db") "prints the command that puts the database back"
Assert ($r.Output -match "/bv-snapshot-restore\.sh uploads /app/uploads \d{8}-\d{6} /bv-backups/uploads-\d{8}-\d{6}") "prints the command that puts the uploads back"
$dbSnap = @(Get-Backups $d | Where-Object { $_ -match '^blackvault-\d{8}-\d{6}\.db$' }) | Select-Object -First 1
Assert ($dbSnap -and ([IO.File]::ReadAllText((Join-Path $d "backups\$dbSnap")) -eq "the database as it was")) "the snapshot itself is intact"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS4
Write-Scenario "restore.bat - the backup does not pass the check (wrong passphrase, damaged file): exit 1, BlackVault never stopped, nothing snapshotted"
$d = New-RestoreSandbox "restore-verify-fails"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_BACKUP_EXIT" = "1"; "BV_STUB_BACKUP_STDERR" = "full-backup: Wrong passphrase, or the backup is damaged." }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -eq 1 -and $steps[0] -eq $RestoreVerify) "the check is the only docker call (got: $($steps -join ' || '))"
Assert ($r.Output.Contains("ERROR: the backup $RestoreName did not pass the check (the reason is on the line above). Nothing was changed; BlackVault was not stopped.")) "says nothing was changed and the app was not stopped"
Assert (-not (Test-Path (Join-Path $d "backups"))) "no snapshot folder was created"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS5
Write-Scenario "restore.bat - R21 and no console: without --yes, or without --passphrase-file, it stops before docker is ever called"
$d = New-RestoreSandbox "restore-guards"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --passphrase-file `"$pf`"" @{} 60
Assert ($r.ExitCode -eq 1) "no --yes: exits 1 (got $($r.ExitCode))"
Assert ($r.Output.Contains("ERROR: a restore replaces all data and must be confirmed, but standard input is not a console. Add --yes to confirm. Nothing was done.")) "no --yes: says to add --yes"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "no --yes: docker was never called"
Show-EvidenceIfFailed $r
$r = Invoke-Restore $d "$RestoreName --yes" @{} 60
Assert ($r.ExitCode -eq 1) "no --passphrase-file: exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: no passphrase: standard input is not a console") "no --passphrase-file: says there is nobody to ask"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "no --passphrase-file: docker was never called"
Show-EvidenceIfFailed $r
$r = Invoke-Restore $d "--yes --passphrase-file `"$pf`"" @{} 60
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: no backup file was given") "no file: exit 1 with a usage line (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Restore $d "$RestoreName --passphrase typed-by-mistake --yes" @{} 60
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: unknown argument" -and -not $r.Output.Contains("typed-by-mistake")) "an unknown option is refused and never echoed (exit $($r.ExitCode))"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never called"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS6
Write-Scenario "restore.bat - the file: a path inside the backup folder maps to its name; a path outside it, or a bad name, is refused before anything runs"
$d = New-RestoreSandbox "restore-file"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "data\backups\$RestoreName --yes --passphrase-file `"$pf`""
Assert ($r.ExitCode -eq 0) "a relative path into the backup folder: exits 0 (got $($r.ExitCode))"
Assert ((Get-StepIndex @(Get-RestoreSteps $r) ([regex]::Escape($RestoreVerify) + '$')) -eq 0) "it was mapped to the file name"
Show-EvidenceIfFailed $r
foreach ($outside in @((Join-Path $d $RestoreName), "data\$RestoreName", "C:\Windows\win.ini")) {
  $r = Invoke-Restore $d "`"$outside`" --yes --passphrase-file `"$pf`""
  Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: restore: .* is not in the backup folder") "outside the backup folder is refused: $outside (exit $($r.ExitCode))"
  Assert (@(Get-RestoreSteps $r).Count -eq 0) "nothing was run for $outside"
  Show-EvidenceIfFailed $r
}
foreach ($badName in @("a&b.bvb", ";x.bvb", "a b.bvb", "a;b.bvb")) {
  $r = Invoke-Restore $d "`"$badName`" --yes --passphrase-file `"$pf`""
  Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: restore: that is not a backup file name") "a bad file name is refused: $badName (exit $($r.ExitCode))"
  Assert (@(Get-RestoreSteps $r).Count -eq 0) "nothing was run for $badName"
  Show-EvidenceIfFailed $r
}

# ---------------------------------------------------------------- scenario RS7
Write-Scenario "restore.bat - PostgreSQL, the restore fails after reaching the database (marker present): the uploads, then the dump is loaded into a NEW database and swapped in, then start"
$d = New-RestoreSandbox "restore-postgres" -Postgres
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "1"; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d) }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$psql = 'compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault'
$iRestore = Get-StepIndex $steps 'full-restore\.mjs --stamp '
$iDump = Get-StepIndex $steps '^compose exec -T db pg_dump -U blackvault -d blackvault$'
$iCreate = Get-StepIndex $steps ('^' + [regex]::Escape("$psql -d postgres -c DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE) -c CREATE DATABASE blackvault_rollback OWNER blackvault") + '$')
$iLoad = Get-StepIndex $steps ('^' + [regex]::Escape("$psql -d blackvault_rollback --single-transaction -f -") + '$')
$iSwap = Get-StepIndex $steps ('^' + [regex]::Escape("$psql -d postgres -c DROP DATABASE IF EXISTS blackvault WITH (FORCE) -c ALTER DATABASE blackvault_rollback RENAME TO blackvault") + '$')
$iUploads = Get-StepIndex $steps 'bv-snapshot-restore\.sh uploads /app/uploads \d{8}-\d{6} /bv-backups/uploads-'
Assert ($iDump -ge 0 -and $iDump -lt $iRestore) "the snapshot (pg_dump) was taken before the restore (dump $iDump, restore $iRestore)"
Assert ($iUploads -gt $iRestore) "first the uploads (index $iUploads)"
Assert ($iCreate -gt $iUploads -and $iLoad -gt $iCreate -and $iSwap -gt $iLoad) "then: new database ($iCreate), load in one transaction ($iLoad), swap ($iSwap)"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh clear-marker') -gt $iSwap) "then the marker is cleared"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh sqlite') -eq -1) "no SQLite file copy on PostgreSQL"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "BlackVault is started last (last call: $($steps | Select-Object -Last 1))"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS8
Write-Scenario "restore.bat - no snapshot, no restore: a failing snapshot, or no database yet, stops before the restore program and starts BlackVault again"
$d = New-RestoreSandbox "restore-no-db"
Remove-Item -Force (Join-Path $d "data\db\vault.db")
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`""
Assert ($r.ExitCode -eq 1) "no database yet: exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps 'full-restore\.mjs') -eq -1) "no database yet: the restore program was never started"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "no database yet: BlackVault was started again"
Assert ($r.Output -match "ERROR: there is no database to snapshot yet") "no database yet: says so"
Show-EvidenceIfFailed $r
$d = New-RestoreSandbox "restore-snapshot-fails"
# A FILE named backups: db-snapshot.bat cannot create its folder and fails.
Set-Content -Path (Join-Path $d "backups") -Value "in the way" -Encoding Ascii
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`""
Assert ($r.ExitCode -eq 1) "snapshot fails: exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps 'full-restore\.mjs') -eq -1) "snapshot fails: the restore program was never started"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "snapshot fails: BlackVault was started again"
Assert ($r.Output.Contains("ERROR: the snapshot before the restore failed (see above), so the restore did not start. Nothing was changed.")) "snapshot fails: says nothing was changed"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "snapshot fails: the database file is untouched"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RS9
Write-Scenario "restore.bat - R24: the restore fails BEFORE reaching the database (no marker, SQLite): only the uploads are checked; NO database rollback command; the database file is untouched"
$d = New-RestoreSandbox "restore-fails-early"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "1"; "BV_STUB_RESTORE_STDERR" = "full-restore: [stub] refused. Nothing was changed." }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh uploads /app/uploads ') -gt (Get-StepIndex $steps $RestoreCallPattern)) "the uploads are checked against the snapshot"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh (sqlite|clear-marker)') -eq -1 -and (Get-StepIndex $steps 'psql') -eq -1) "no database rollback command was issued"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "BlackVault is started again"
Assert ($r.Output.Contains("ERROR: the restore failed (the reason is above). It had not reached the database, which was not touched; the uploads were checked against the snapshot. Nothing is changed. BlackVault was started again.")) "the last line says the database was not touched"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
Assert (@(Get-RecoveryFiles $d).Count -eq 0) "the recovery file is gone"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS10
Write-Scenario "restore.bat - R25: a recovery file left by an earlier restore blocks a new one before docker is called; DATA_DIR set in the console and different from .env is refused too"
$d = New-RestoreSandbox "restore-blocked"
$pf = New-PassFile $d "$BackupPass`n"
New-Item -ItemType Directory -Force -Path (Join-Path $d "backups") | Out-Null
Set-Content -Path (Join-Path $d "backups\restore-20260101-000000-RECOVERY.txt") -Value "left by an earlier restore" -Encoding Ascii
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{} 60
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: an earlier restore did not finish cleanly: a restore-\[time\]-RECOVERY\.txt file is still in .*\\backups\. Read it") "says an earlier restore did not finish, and to read the file"
Assert ($r.Output -match "delete that file instead; or, if you mean to replace this install with a backup anyway, delete that file\. Then run the restore again\. Nothing was done\.") "says how to go on for someone who means to restore over it anyway"
Assert (@(Get-RestoreSteps $r).Count -eq 0) "docker was not asked to do anything"
Assert (Test-Path (Join-Path $d "backups\restore-20260101-000000-RECOVERY.txt")) "the earlier file is left alone"
Show-EvidenceIfFailed $r
Remove-Item -Force (Join-Path $d "backups\restore-20260101-000000-RECOVERY.txt")
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "DATA_DIR" = "C:\somewhere\else" } 60
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: DATA_DIR is set in this console and is not the DATA_DIR in \.env") "a different DATA_DIR in the console is refused (exit $($r.ExitCode))"
Assert (@(Get-RestoreSteps $r).Count -eq 0) "docker was not asked to do anything"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS11
Write-Scenario "restore.bat - R24 on PostgreSQL: the restore fails before reaching the database (no marker): not one psql command"
$d = New-RestoreSandbox "restore-postgres-early" -Postgres
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps 'psql') -eq -1) "no psql command: the database is never dropped"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh uploads ') -ge 0) "the uploads are checked"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "BlackVault is started again"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS12
# Task 7 re-review, item 3. restore.bat used to call this state "started" and
# put the PostgreSQL database back; had the restore in fact finished, that
# gave old records with new files. Now, as restore.sh: nothing blindly.
Write-Scenario "restore.bat - the uploads folder is not there to look into (PostgreSQL): how far the restore got is unknown, so NOTHING is rolled back, BlackVault is NOT started, the recovery file stays and is shown"
$d = New-RestoreSandbox "restore-state-unknown" -Postgres
Remove-Item -Recurse -Force (Get-UploadsDir $d)
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "1"; "BV_STUB_RESTORE_STDERR" = "full-restore: [stub] failed." }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$iRestore = Get-StepIndex $steps 'full-restore\.mjs --stamp '
Assert ($iRestore -ge 0) "the restore program was started (index $iRestore)"
Assert ((Get-StepIndex $steps 'psql') -eq -1) "not one psql command: the database is not put back blindly"
Assert (@($steps | Where-Object { $_ -match 'bv-snapshot-restore\.sh' -and $_ -notmatch 'bv-snapshot-restore\.sh markers /app/uploads$' }).Count -eq 0) "no rollback container was started (only the question about older markers, before anything else)"
Assert ($iRestore -ge 0 -and $iRestore -eq ($steps.Count - 1)) "BlackVault was NOT started: the restore program is the last docker call (last call: $($steps | Select-Object -Last 1))"
Assert ($r.Output -match "how far it got could not be found out: the uploads folder .*\\uploads is not there to look into\. Nothing is rolled back blindly\.") "says how far it got is unknown and nothing is rolled back blindly"
Assert ($r.Output.Contains("BlackVault was NOT started. What to do is in")) "says the app was not started and points at the recovery file"
Assert ($r.Output -match "/bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}") "the recovery text (how to ask for the state inside a container) is shown"
Assert (@(Get-RecoveryFiles $d).Count -eq 1) "the recovery file stays"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS13
# Ruling R27: BV_RESTORE_PHASE is how the PowerShell step re-enters
# restore.bat for steps 5-7. Left set in a console, it must not send a
# user's run into the middle of the script.
Write-Scenario "restore.bat - BV_RESTORE_PHASE set in the console: refused with one line before docker is called"
$d = New-RestoreSandbox "restore-phase-set"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_RESTORE_PHASE" = "prepare" } 60
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: BV_RESTORE_PHASE is set in this console") "says why"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never called"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS14
# Windows CI (269a53f): see BK11. In restore.bat the bare `shift` also made
# %~f0 the passphrase file, which is what the PowerShell step starts for
# steps 5-7 - so cmd.exe "ran" a .txt file and the restore never went on.
Write-Scenario "restore.bat - the passphrase file lives in ANOTHER folder: the whole restore still runs from the script's own folder"
$elsewhere = Join-Path $Sandboxes "restore-pass-elsewhere-secrets"
New-Item -ItemType Directory -Force -Path $elsewhere | Out-Null
$d = New-RestoreSandbox "restore-pass-elsewhere"
$pf = New-PassFile $elsewhere "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps '^compose stop blackvault$') -gt 0 -and (Get-StepIndex $steps $RestoreCallPattern) -gt (Get-StepIndex $steps '^compose stop blackvault$')) "check, stop, restore - in that order"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "BlackVault is started last"
Assert (@(Get-Backups $d | Where-Object { $_ -match '^blackvault-\d{8}-\d{6}\.db$' }).Count -eq 1) "the snapshot went into the backups folder of the install"
Assert ($r.Output.Contains("Restore complete.")) "says the restore is complete"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS15
# cmd.exe works out %~f0 again from the CURRENT folder when the script was
# started by a quoted, relative name. restore.bat read %~f0 AFTER its
# `cd /d "%~dp0"`, so started as "bv\restore.bat" from the folder above, the
# path it handed to the PowerShell step for steps 5-7 was ...\bv\bv\restore.bat:
# the check passed, the child could not be started, and the user was told the
# backup "did not pass the check". The path is now read before the folder changes.
Write-Scenario "restore.bat - started by a quoted RELATIVE name from the parent folder: steps 5-7 still run (the script's own path is read before the folder changes)"
$d = New-RestoreSandbox "restore-relative-quoted"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine } 180 "restore-relative-quoted\restore.bat" $Sandboxes
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "did not pass the check") "does not claim the backup failed its check"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps '^compose stop blackvault$') -gt 0 -and (Get-StepIndex $steps $RestoreCallPattern) -gt (Get-StepIndex $steps '^compose stop blackvault$')) "check, stop, restore - in that order"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "BlackVault is started last"
Assert (@(Get-Backups $d | Where-Object { $_ -match '^blackvault-\d{8}-\d{6}\.db$' }).Count -eq 1) "the snapshot went into the backups folder of the install"
Assert ($r.Output.Contains("Restore complete.")) "says the restore is complete"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS16
# A backup started from the Settings button runs inside the app: stopping the
# app would end it. restore.bat asks the running app for the lock first.
Write-Scenario "restore.bat - a full backup is running (the lock is held): exit 1 before BlackVault is stopped; nothing is snapshotted"
$d = New-RestoreSandbox "restore-lock-held"
$passBytesText = "$BackupPass`n"
$pf = New-PassFile $d $passBytesText
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_LOCK_EXIT" = "2"; "BV_STUB_LOCK_STDOUT" = $RestoreLockHeld }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -eq 3 -and $steps[0] -eq $RestoreVerify -and $steps[1] -eq $RestorePs -and $steps[2] -eq $RestoreLockStatus) "the docker calls are the check, 'is it running', and the lock question - nothing else (got: $($steps -join ' || '))"
Assert ($r.Output.Contains($RestoreLockHeld)) "the holder is shown"
Assert ($r.Output.Contains("ERROR: a full backup is running (the line above names it), so the restore did not start. Nothing was changed; BlackVault was not stopped. Run the restore again when the backup has finished.")) "says a backup is running, nothing was changed, and to run it again later"
Assert ($r.Output -notmatch "did not pass the check") "does not claim the backup failed its check"
Assert (-not (Test-Path (Join-Path $d "backups"))) "no snapshot folder was created"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
$expected = [Convert]::ToBase64String((New-Object Text.UTF8Encoding($false)).GetBytes($passBytesText))
Assert ((Get-FileBase64 (Join-Path $d "__stdin-verify.bin")) -eq $expected) "the lock question was given nothing on stdin: the check program's record of the passphrase is still the only one"
Assert (-not (Test-Path (Join-Path $d "__stdin-restore.bin"))) "the restore program never ran"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS17
Write-Scenario "restore.bat - BlackVault is running and the lock is free: check, ask, stop, restore; a lock question that FAILS (an older image) is one WARNING and the restore goes on"
$d = New-RestoreSandbox "restore-lock-free"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_LOCK_STDOUT" = "BLACKVAULT_FULL_BACKUP_LOCK state=free"; "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "free: exits 0 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$iLock = Get-StepIndex $steps ('^' + [regex]::Escape($RestoreLockStatus) + '$')
$iStop = Get-StepIndex $steps '^compose stop blackvault$'
Assert ($iLock -gt 0 -and $steps[$iLock - 1] -eq $RestorePs) "free: the lock is asked for right after 'is it running' (index $iLock)"
Assert ($iStop -gt $iLock -and (Get-StepIndex $steps $RestoreCallPattern) -gt $iStop) "free: then stop ($iStop), then the restore"
Assert (@($steps | Where-Object { $_ -eq $RestoreLockStatus }).Count -eq 1) "free: asked once"
Assert ($r.Output -notmatch "WARNING: could not check") "free: no warning"
Assert ($r.Output -notmatch "BLACKVAULT_FULL_BACKUP_LOCK") "free: the lock's own line (state=free) is not printed"
Assert ($r.Output.Contains("Restore complete.")) "free: says the restore is complete"
Show-EvidenceIfFailed $r
$d = New-RestoreSandbox "restore-lock-question-fails"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_LOCK_EXIT" = "1"; "BV_STUB_LOCK_STDERR" = "full-backup: unknown argument."; "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "question fails: exits 0 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$iLock = Get-StepIndex $steps ('^' + [regex]::Escape($RestoreLockStatus) + '$')
Assert ($iLock -gt 0 -and (Get-StepIndex $steps '^compose stop blackvault$') -gt $iLock) "question fails: the question was asked (index $iLock) and the restore goes on to the stop"
Assert ($r.Output.Contains("WARNING: could not check whether a full backup is running (exit 1; an image from before this check answers like that). If one is running, stopping BlackVault ends it. Going on with the restore.")) "question fails: one WARNING says so"
Assert ($r.Output.Contains("full-backup: unknown argument.")) "question fails: what the question printed is shown"
Assert ($r.Output.Contains("Restore complete.")) "question fails: says the restore is complete"
Show-EvidenceIfFailed $r
# Held takes the exit code 2 AND a line that says state=held: an exit 2 from
# anything else is "could not check", and the restore goes on.
$d = New-RestoreSandbox "restore-lock-exit2-other"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_LOCK_EXIT" = "2"; "BV_STUB_LOCK_STDERR" = "OCI runtime exec failed: the container is restarting"; "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "exit 2 without the line: exits 0 (got $($r.ExitCode))"
Assert ($r.Output -notmatch "ERROR: a full backup is running") "exit 2 without the line: not taken for a running backup"
Assert ($r.Output.Contains("WARNING: could not check whether a full backup is running (exit 2;")) "exit 2 without the line: one WARNING says the question failed"
Assert ($r.Output.Contains("OCI runtime exec failed: the container is restarting")) "exit 2 without the line: what the question printed is shown"
Assert ($r.Output.Contains("Restore complete.")) "exit 2 without the line: says the restore is complete"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS18
# On PostgreSQL the database is put back with psql, which no script guards.
# The recovery file's rollback line therefore starts with a state test. Here
# that line is taken from the file restore.bat wrote and run AS PRINTED, at a
# command prompt, once per state. The stub answers the state question
# (BV_STUB_STATE_ANSWER); what the rollback does to files is proven on Linux.
Write-Scenario "restore.bat - PostgreSQL: the recovery file's rollback line, run exactly as printed in a Command Prompt, sends psql ONLY when the state is 'started'"
$d = New-RestoreSandbox "restore-postgres-printed" -Postgres
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "the restore that writes the file exits 0 (got $($r.ExitCode))"
$during = if (Test-Path (Join-Path $d "__recovery-during.txt")) { [IO.File]::ReadAllText((Join-Path $d "__recovery-during.txt")) } else { "" }
$chain = @($during -split "`r?`n" | Where-Object { $_ -match 'psql' -and $_ -match 'clear-marker' }) | Select-Object -First 1
$chain = if ($chain) { $chain.Trim() } else { "" }
Assert ($chain -match '^for /f %S in \(''docker compose run [^'']* /bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}''\) do if "%S"=="started" docker compose run [^&]* /bv-snapshot-restore\.sh uploads /app/uploads \d{8}-\d{6} /bv-backups/uploads-\d{8}-\d{6} && docker compose up -d --wait db && ') "the line starts with the state test, with ONE percent sign, and the chain is its body (got: $chain)"
Assert ($chain -match ' -f - < "backups\\blackvault-\d{8}-\d{6}\.sql" && ' -and $chain -match ' && docker compose run [^&]* /bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}$') "it loads the dump from the quoted snapshot path and ends with clear-marker"
Assert ($during -match "The line asks for the state again first, and does nothing unless that\s+prints started\.") "the text says the line tests the state itself, in restore.sh's words"
Show-EvidenceIfFailed $r
$psql = 'compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault'
foreach ($state in @("complete", "untouched")) {
  $c = Invoke-CmdLine $d $chain $state
  $steps = @(Get-RestoreSteps $c)
  Assert ($steps.Count -eq 1 -and $steps[0] -match '/bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}$') "state '$state': the only docker call is the state question (got: $($steps -join ' || '))"
  Assert ((Get-StepIndex $steps 'psql|clear-marker|bv-snapshot-restore\.sh uploads|up -d') -eq -1) "state '$state': no psql, no uploads rollback, no clear-marker"
  Assert ($c.Output -notmatch "is not recognized as an internal or external command" -and $c.Output -notmatch "was unexpected at this time" -and $c.Output -notmatch "The syntax of the command is incorrect") "state '$state': the line is valid at a command prompt"
  Show-EvidenceIfFailed $c
}
$c = Invoke-CmdLine $d $chain "started"
$steps = @(Get-RestoreSteps $c)
Assert ($c.ExitCode -eq 0) "state 'started': the line exits 0 (got $($c.ExitCode))"
Assert ($steps.Count -eq 7) "state 'started': seven docker calls (got $($steps.Count): $($steps -join ' || '))"
if ($steps.Count -eq 7) {
  Assert ($steps[0] -match '/bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}$') "started: 1. the state question"
  Assert ($steps[1] -match '/bv-snapshot-restore\.sh uploads /app/uploads \d{8}-\d{6} /bv-backups/uploads-\d{8}-\d{6}$') "started: 2. the uploads"
  Assert ($steps[2] -eq "compose up -d --wait db") "started: 3. the database container"
  Assert ($steps[3] -eq "$psql -d postgres -c DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE) -c CREATE DATABASE blackvault_rollback OWNER blackvault") "started: 4. a NEW database"
  Assert ($steps[4] -eq "$psql -d blackvault_rollback --single-transaction -f -") "started: 5. the dump, in one transaction"
  Assert ($steps[5] -eq "$psql -d postgres -c DROP DATABASE IF EXISTS blackvault WITH (FORCE) -c ALTER DATABASE blackvault_rollback RENAME TO blackvault") "started: 6. the swap"
  Assert ($steps[6] -match '/bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}$') "started: 7. the marker, last"
}
Assert ($c.Output -notmatch "is not recognized as an internal or external command" -and $c.Output -notmatch "was unexpected at this time" -and $c.Output -notmatch "The system cannot find the file specified") "state 'started': the line is valid at a command prompt and the dump file was found"
Show-EvidenceIfFailed $c

# -------------------------------------------------------------- scenario RS18b
# The same line when the checkout folder has an apostrophe in its name: the
# state test is `for /f %S in ('...') do`, and the folder is inside it twice
# (the two -v mounts).
Write-Scenario "restore.bat - PostgreSQL, a checkout folder with an apostrophe in its name (Rob's vault): the recovery file's rollback line, run as printed, still works in each state"
$d = New-RestoreSandbox "restore-postgres-rob's vault" -Postgres
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "the restore that writes the file exits 0 (got $($r.ExitCode))"
$during = if (Test-Path (Join-Path $d "__recovery-during.txt")) { [IO.File]::ReadAllText((Join-Path $d "__recovery-during.txt")) } else { "" }
$chain = @($during -split "`r?`n" | Where-Object { $_ -match 'psql' -and $_ -match 'clear-marker' }) | Select-Object -First 1
$chain = if ($chain) { $chain.Trim() } else { "" }
Assert ($chain.Contains("rob's vault\backups:/bv-backups:ro")) "the line holds the folder with its apostrophe (got: $chain)"
Show-EvidenceIfFailed $r
foreach ($state in @("complete", "untouched")) {
  $c = Invoke-CmdLine $d $chain $state
  $steps = @(Get-RestoreSteps $c)
  Assert ($steps.Count -eq 1 -and $steps[0] -match '/bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}$') "apostrophe, state '$state': the only docker call is the state question (got: $($steps -join ' || '))"
  Assert ($c.Output -notmatch "is not recognized as an internal or external command" -and $c.Output -notmatch "was unexpected at this time" -and $c.Output -notmatch "The syntax of the command is incorrect") "apostrophe, state '$state': the line is valid at a command prompt"
  Show-EvidenceIfFailed $c
}
$c = Invoke-CmdLine $d $chain "started"
$steps = @(Get-RestoreSteps $c)
Assert ($c.ExitCode -eq 0) "apostrophe, state 'started': the line exits 0 (got $($c.ExitCode))"
Assert ($steps.Count -eq 7) "apostrophe, state 'started': seven docker calls (got $($steps.Count): $($steps -join ' || '))"
if ($steps.Count -eq 7) {
  Assert ($steps[0] -match "rob's vault\\backups:/bv-backups:ro .* /bv-snapshot-restore\.sh state /app/uploads \d{8}-\d{6}$") "apostrophe, started: the state question got the mount with the whole folder name"
  Assert ($steps[6] -match '/bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}$') "apostrophe, started: the marker, last"
}
Assert ($c.Output -notmatch "is not recognized as an internal or external command" -and $c.Output -notmatch "was unexpected at this time" -and $c.Output -notmatch "The system cannot find the file specified") "apostrophe, state 'started': the line is valid at a command prompt and the dump file was found"
Show-EvidenceIfFailed $c

# -------------------------------------------------------------- scenario RS19b
# restore.bat looks for BOTH lines in the handoff file before it lets the
# restore program run: ready=1, and a db= line that is not empty (the path a
# rollback is made from). RS19 below loses every line at once; here the lines
# of that check are cut out of restore.bat and run on handoff files that lack
# only one of them.
Write-Scenario "restore.bat - the handoff check, run on its own: a file without its db line, or with an empty one, is refused although ready=1 is there"
$d = Join-Path $Sandboxes "handoff-check"
New-Item -ItemType Directory -Force -Path $d | Out-Null
$lines = [IO.File]::ReadAllText((Join-Path $RepoRoot "restore.bat")) -split "`r`n"
$from = [Array]::IndexOf($lines, 'findstr /x /c:"ready=1" "!BV_HANDOFF!" >nul 2>&1')
$to = [Array]::IndexOf($lines, 'findstr /b /r /c:"db=." "!BV_HANDOFF!" >nul 2>&1')
Assert ($from -gt 0 -and $to -gt $from -and $lines[$to + 1] -eq "if errorlevel 1 goto :handoff_failed") "both checks are in restore.bat, the db line second (lines $from and $to)"
$driver = @("@echo off", "setlocal EnableDelayedExpansion", "set `"BV_HANDOFF=%~dp0handoff.txt`"") + $lines[$from..($to + 1)] + @("echo RESULT=go-on", "exit /b 0", ":handoff_failed", "echo RESULT=handoff-failed", "exit /b 0", "")
[IO.File]::WriteAllText((Join-Path $d "handoffdrv.bat"), ($driver -join "`r`n"), [Text.Encoding]::ASCII)
$HandoffCases = @(
  @("both lines", "phase=prepare`r`ndb=backups\blackvault-20261003-000000.db`r`nuploads=`r`nready=1`r`n", "go-on"),
  @("no db line", "phase=prepare`r`nuploads=`r`nready=1`r`n", "handoff-failed"),
  @("an empty db line", "phase=prepare`r`ndb=`r`nuploads=`r`nready=1`r`n", "handoff-failed"),
  @("db= only inside another line", "phase=prepare`r`nuploads=db=x`r`nready=1`r`n", "handoff-failed"),
  @("no ready line", "phase=prepare`r`ndb=backups\blackvault-20261003-000000.db`r`nuploads=`r`n", "handoff-failed")
)
foreach ($case in $HandoffCases) {
  [IO.File]::WriteAllText((Join-Path $d "handoff.txt"), $case[1], [Text.Encoding]::ASCII)
  $r = Invoke-Bat -Dir $d -Script "handoffdrv.bat" -NoPad -TimeoutSeconds 60
  Assert ($r.Output -match ("(?m)^RESULT=" + $case[2] + "\r?$")) "$($case[0]): $($case[2])"
  Show-EvidenceIfFailed $r
}

# --------------------------------------------------------------- scenario RS19
# Steps 5-7 run in a child cmd.exe that hands back, through a small file in
# TEMP, where the snapshot is and a `ready` line. The stub makes that file
# read-only while the child runs (at `compose stop`), so the three appends
# fail. A batch file does not stop on a failed redirection: without the check
# the child would exit 0, the restore would RUN, and the script the user
# started, finding no `ready` line, would exit 1 with BlackVault stopped,
# the recovery file left behind and no message.
Write-Scenario "restore.bat - the handoff file cannot be written: the restore program never runs; exit 1 with one clear line; BlackVault is started again; no recovery file is left"
$d = New-RestoreSandbox "restore-handoff-fails"
$pf = New-PassFile $d "$BackupPass`n"
$handoffsBefore = @(Get-ChildItem -Path $env:TEMP -Filter "blackvault-restore-handoff-*.txt" -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_HANDOFF_READONLY" = "1"; "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps '^compose stop blackvault$') -gt 0) "it had got as far as stopping BlackVault (so the handoff file existed and was made read-only)"
Assert ((Get-StepIndex $steps 'full-restore\.mjs') -eq -1) "the restore program was never started"
Assert (-not (Test-Path (Join-Path $d "__stdin-restore.bin"))) "the restore program was never given the passphrase"
Assert (($steps | Select-Object -Last 1) -eq "compose up -d") "BlackVault was started again (last call: $($steps | Select-Object -Last 1))"
Assert ($r.Output -match "ERROR: could not write to .*blackvault-restore-handoff-\d+\.txt \(its ready line or its db line is missing\), so the restore did not start\. Nothing was changed\.") "one line says the handoff could not be written and nothing was changed"
Assert ($r.Output -notmatch "did not pass the check") "does not claim the backup failed its check"
Assert (-not $r.Output.Contains($RestoreOkLine) -and -not $r.Output.Contains("Restore complete.")) "does not claim a restore"
Assert (@(Get-RecoveryFiles $d).Count -eq 0) "the recovery file was removed again: the next restore is not blocked"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
$handoffsAfter = @(Get-ChildItem -Path $env:TEMP -Filter "blackvault-restore-handoff-*.txt" -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
Assert (@($handoffsAfter | Where-Object { $handoffsBefore -notcontains $_ }).Count -eq 0) "the read-only handoff file was still removed from TEMP"
Show-EvidenceIfFailed $r
# The same install, with nothing in the way: the restore now runs.
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0 -and $r.Output.Contains("Restore complete.")) "a second restore, with a writable handoff, runs to the end (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r

# BlackVault refuses to start while a restore marker (.restore-<time>.db-started)
# is in the uploads folder. RS20-RS23: restore.bat never starts it, and never
# tells anyone to, while one can still be there. The stub does not run
# snapshot-restore.sh, so a clear-marker that "works" leaves the folder on
# disk: what is proven here is the ORDER of the calls, what is printed, the
# exit code and the recovery file. That the script really removes the marker
# is proven on Linux (scripts/full-restore-wrapper.test.ts).
$ClearMarkerPattern = '--user 0:0 --entrypoint /bin/sh .*backups:/bv-backups:ro .*snapshot-restore\.sh:/bv-snapshot-restore\.sh:ro blackvault /bv-snapshot-restore\.sh clear-marker /app/uploads '

# --------------------------------------------------------------- scenario RS20
Write-Scenario "restore.bat - the restore finished but left its marker: the marker is cleared, as root in a container, BEFORE BlackVault is started; exit 0"
$d = New-RestoreSandbox "restore-marker-left"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d) }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
$iRestore = Get-StepIndex $steps 'full-restore\.mjs --stamp \d{8}-\d{6} '
$stamp = if ($iRestore -ge 0 -and $steps[$iRestore] -match '--stamp (\d{8}-\d{6}) ') { $Matches[1] } else { "" }
$iClear = Get-StepIndex $steps ($ClearMarkerPattern + [regex]::Escape($stamp) + '\s*$')
$iUp = Get-StepIndex $steps '^compose up -d$'
Assert ($iRestore -ge 0 -and $stamp) "the restore program was started with a stamp ($stamp)"
Assert ($iClear -gt $iRestore) "the marker is cleared after the restore program (index $iClear)"
Assert ($iUp -gt $iClear) "and only then is BlackVault started (index $iUp)"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh (sqlite|uploads) ') -eq -1 -and (Get-StepIndex $steps 'psql') -eq -1) "nothing is rolled back"
Assert ($r.Output -match "The restore finished but left its marker .*\.restore-\d{8}-\d{6}\.db-started\. Removing it\.\.\.") "says that it removes the marker"
Assert ($r.Output.Contains("Restore complete.")) "reports the restore as complete"
Assert (@(Get-RecoveryFiles $d).Count -eq 0) "the recovery file is gone"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS21
Write-Scenario "restore.bat - the restore finished, its marker is left and CANNOT be cleared: BlackVault is NOT started; exit 1; the message names the marker and the command; the recovery file says only that"
$d = New-RestoreSandbox "restore-marker-stuck"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d); "BV_STUB_CLEAR_MARKER_EXIT" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps ($ClearMarkerPattern + '\d{8}-\d{6}\s*$')) -ge 0) "clearing the marker was attempted"
Assert ((Get-StepIndex $steps '^compose up -d$') -eq -1) "BlackVault was NOT started"
Assert ((Get-StepIndex $steps 'bv-snapshot-restore\.sh (sqlite|uploads) ') -eq -1) "nothing is rolled back"
Assert ($r.Output -match "ERROR: the restore is complete and was NOT rolled back, but its marker .*\.restore-\d{8}-\d{6}\.db-started could not be removed, and BlackVault refuses to start while that marker exists\. BlackVault was NOT started\. Do NOT run the recovery commands that were printed before the restore started: they would undo the restore\. Remove the marker with:  docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh .* /bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}  Then start BlackVault: docker compose up -d  The same is in .*backups\\restore-\d{8}-\d{6}-RECOVERY\.txt\.") "the last line names the marker, the exact command and the file"
Assert (-not $r.Output.Contains("Restore complete.")) "does not report 'Restore complete.'"
$recovery = @(Get-RecoveryFiles $d)
Assert ($recovery.Count -eq 1) "the recovery file is kept (BlackVault's own refusal points at it)"
$left = if ($recovery.Count -eq 1) { [IO.File]::ReadAllText((Join-Path $d "backups\$($recovery[0])")) } else { "" }
Assert ($left -match "^BlackVault restore \d{8}-\d{6}: ONE STEP LEFT") "it now starts with ONE STEP LEFT"
Assert ($left -match "Do NOT run the recovery commands that restore\.bat printed before the restore\r?\nstarted \(they may still be on your screen\): they would put the old install\r?\nback and undo the restore\.") "it says not to run the recovery commands printed before the restore"
Assert (@(Get-ChildItem -Path (Join-Path $d "backups") -Filter "*.new" -ErrorAction SilentlyContinue).Count -eq 0) "no work file is left in backups"
Assert ($left -match "(?m)^  docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh [^\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}\r?$") "it holds the clear-marker command on a line of its own"
Assert ($left -match "(?m)^  docker compose up -d\r?$") "then the command that starts BlackVault"
Assert ($left -notmatch "bv-snapshot-restore\.sh (sqlite|uploads) " -and $left -notmatch "psql") "nothing in it puts the old install back"
Assert ($left -match "database: backups\\blackvault-\d{8}-\d{6}\.db") "it still names the snapshot"
Show-EvidenceIfFailed $r
# While that file exists, a new restore refuses to start.
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 1 -and $r.Output.Contains("an earlier restore did not finish cleanly")) "a second restore is refused while the file exists (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS22
Write-Scenario "restore.bat - the rollback worked but the marker CANNOT be cleared: BlackVault is NOT started; exit 1; the recovery file stays as it was written"
$d = New-RestoreSandbox "restore-rollback-marker-stuck"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_EXIT" = "1"; "BV_STUB_RESTORE_STDERR" = "full-restore: [stub] failed."; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d); "BV_STUB_CLEAR_MARKER_EXIT" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert (@($steps | Where-Object { $_ -match "bv-snapshot-restore\.sh (sqlite|uploads) " }).Count -eq 2) "both rollback steps ran"
Assert ((Get-StepIndex $steps ($ClearMarkerPattern + '\d{8}-\d{6}\s*$')) -ge 0) "clearing the marker was attempted"
Assert ((Get-StepIndex $steps '^compose up -d$') -eq -1) "BlackVault was NOT started"
Assert ($r.Output -match "ERROR: the restore failed \(the reason is above\)\. The database and the uploads were put back from the snapshot taken before it \(backups\\blackvault-\d{8}-\d{6}\.db\), but the marker .*\.restore-\d{8}-\d{6}\.db-started could not be removed, and BlackVault refuses to start while that marker exists\. BlackVault was NOT started\. Remove the marker with:  docker compose run [^\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}  Then start BlackVault: docker compose up -d  and delete .*backups\\restore-\d{8}-\d{6}-RECOVERY\.txt \(while it exists, a new restore refuses to start\)\.") "the last line says what was put back, names the marker, the exact command and the file"
Assert ($r.Output -notmatch "BlackVault was started again") "does not claim BlackVault was started"
$recovery = @(Get-RecoveryFiles $d)
Assert ($recovery.Count -eq 1) "the recovery file stays"
$kept = if ($recovery.Count -eq 1) { [IO.File]::ReadAllText((Join-Path $d "backups\$($recovery[0])")) } else { "" }
Assert ($kept -match "^BlackVault restore \d{8}-\d{6}: RECOVERY" -and $kept -match " && docker compose run [^&\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads \d{8}-\d{6}\r?\n") "it is the file written before the restore: its step 3 ends by clearing the marker"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS23
Write-Scenario "restore.bat - a marker left by an EARLIER restore, with no recovery file: refused before anything is checked, stopped or changed; the message names the marker and the command that removes it"
$d = New-RestoreSandbox "restore-old-marker"
$pf = New-PassFile $d "$BackupPass`n"
$oldMarker = Join-Path (Get-UploadsDir $d) ".restore-20250101-000000.db-started"
New-Item -ItemType Directory -Force -Path $oldMarker | Out-Null
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -eq 0) "docker was asked to do nothing: not the check, not the stop (calls: $($steps.Count))"
Assert ($r.Output -match "ERROR: the uploads folder holds a marker left by an earlier restore: .*uploads\\\.restore-20250101-000000\.db-started\. No recovery file says how to put that restore back\. BlackVault refuses to start while a marker exists") "names the older marker"
Assert ($r.Output -match 'remove every such marker first with:  docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh [^\r\n]* /bv-snapshot-restore\.sh clear-marker /app/uploads "20250101-000000"  Then run the restore again\. Nothing was done\.') "gives the exact command, for that stamp (quoted), and says nothing was done"
Assert (Test-Path $oldMarker) "the marker was not removed by the script"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
Show-EvidenceIfFailed $r
# With the marker gone, the same restore runs to the end.
Remove-Item -Recurse -Force $oldMarker
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0 -and $r.Output.Contains("Restore complete.")) "once the marker is removed the restore runs to the end (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS24
# The uploads folder is not on the host where .env says (it is mounted from
# somewhere else), so restore.bat cannot see a marker. It asks a container
# for older markers up front, and after a restore that finished it clears
# this run's marker without having seen it.
Write-Scenario "restore.bat - the uploads folder is not there to look into: a container is asked for older markers first; after the restore the marker is cleared UNSEEN, before BlackVault is started; exit 0"
$d = New-RestoreSandbox "restore-uploads-not-on-host" -Postgres
Remove-Item -Recurse -Force (Get-UploadsDir $d)
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -gt 0 -and $steps[0] -match '--user 0:0 --entrypoint /bin/sh .* blackvault /bv-snapshot-restore\.sh markers /app/uploads$') "the first docker call asks a container for the markers (first call: $($steps | Select-Object -First 1))"
$iRestore = Get-StepIndex $steps 'full-restore\.mjs --stamp \d{8}-\d{6} '
$stamp = if ($iRestore -ge 0 -and $steps[$iRestore] -match '--stamp (\d{8}-\d{6}) ') { $Matches[1] } else { "" }
$iClear = Get-StepIndex $steps ($ClearMarkerPattern + [regex]::Escape($stamp) + '\s*$')
$iUp = Get-StepIndex $steps '^compose up -d$'
Assert ($iRestore -gt 0 -and $stamp) "the restore program was started with a stamp ($stamp)"
Assert ($iClear -gt $iRestore) "the marker is cleared after the restore program although it was never seen (index $iClear)"
Assert ($iUp -gt $iClear) "and only then is BlackVault started (index $iUp)"
Assert ($r.Output -match "The uploads folder .*\\uploads is not there to look into, so whether the restore left its marker is not known\. Removing the marker if it is there\.\.\.") "says what is not known"
Assert ($r.Output -notmatch "The restore finished but left its marker") "does not claim that a marker was left"
Assert ($r.Output.Contains("Restore complete.")) "reports the restore as complete"
Show-EvidenceIfFailed $r
# The same, and the marker cannot be cleared: BlackVault is not started.
$d = New-RestoreSandbox "restore-uploads-not-on-host-stuck" -Postgres
Remove-Item -Recurse -Force (Get-UploadsDir $d)
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine; "BV_STUB_CLEAR_MARKER_EXIT" = "1" }
$steps = @(Get-RestoreSteps $r)
Assert ($r.ExitCode -eq 1 -and (Get-StepIndex $steps '^compose up -d$') -eq -1) "the marker cannot be cleared: exit 1 and BlackVault is NOT started (exit $($r.ExitCode))"
Assert ($r.Output -match "ERROR: the restore is complete and was NOT rolled back, but its marker, if it is still there \(the uploads folder .*\\uploads is not there to look into\), could not be removed, and BlackVault refuses to start while that marker exists\. BlackVault was NOT started\.") "the last line says the marker could not be removed and that it was never seen"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS25
Write-Scenario "restore.bat - the uploads folder is not there to look into and the container reports TWO older markers: refused before anything is checked; both are named, with one command line that removes both"
$d = New-RestoreSandbox "restore-old-markers-in-container"
Remove-Item -Recurse -Force (Get-UploadsDir $d)
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine; "BV_STUB_MARKERS_ANSWER" = "20250101-000000;20250202-000000" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -eq 1 -and $steps[0] -match '/bv-snapshot-restore\.sh markers /app/uploads$') "the only docker call is the question (calls: $($steps.Count))"
Assert ($r.Output -match "ERROR: the uploads folder holds a marker left by an earlier restore: /app/uploads/\.restore-20250101-000000\.db-started, /app/uploads/\.restore-20250202-000000\.db-started \(inside the container\)\. No recovery file says how to put that restore back\.") "names both markers, as the container sees them"
Assert ($r.Output -match 'remove every such marker first with:  docker compose run [^\r\n&]* /bv-snapshot-restore\.sh clear-marker /app/uploads "20250101-000000" && docker compose run [^\r\n&]* /bv-snapshot-restore\.sh clear-marker /app/uploads "20250202-000000"  Then run the restore again\. Nothing was done\.') "gives ONE command line that removes both, each stamp quoted"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS26
Write-Scenario "restore.bat - the uploads folder is not there to look into and the container cannot be asked: REFUSED (never taken for 'no marker'); nothing is checked, stopped or changed"
$d = New-RestoreSandbox "restore-markers-unknown"
Remove-Item -Recurse -Force (Get-UploadsDir $d)
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine; "BV_STUB_ROLLBACK_EXIT" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -eq 1 -and $steps[0] -match '/bv-snapshot-restore\.sh markers /app/uploads$') "the only docker call is the question that failed (calls: $($steps.Count))"
Assert ($r.Output -match "ERROR: could not check the uploads folder for a marker left by an earlier restore: .*\\uploads is not there to look into, and asking inside a container failed\. BlackVault refuses to start while such a marker exists, so the restore did not start\. Nothing was done\. Check that Docker is running \(docker compose ps\), then run the restore again\.") "says it could not check, that nothing was done, and what to do next"
Assert ($r.Output.Contains("ERROR: could not restore from the snapshot: [stub] failing on purpose (BV_STUB_ROLLBACK_EXIT)")) "what Docker wrote to standard error is shown"
Assert ([IO.File]::ReadAllText((Join-Path $d "data\db\vault.db")) -eq "the database as it was") "the database file is untouched"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS27
Write-Scenario "restore.bat - DATA_DIR=./data in .env (forward slashes): older markers are still found - a folder AND a file - and both are named with one command line"
$d = New-RestoreSandbox "restore-old-marker-forward-slash"
[IO.File]::AppendAllText((Join-Path $d ".env"), "DATA_DIR=./data`r`n", [Text.Encoding]::ASCII)
$pf = New-PassFile $d "$BackupPass`n"
New-Item -ItemType Directory -Force -Path (Join-Path (Get-UploadsDir $d) ".restore-20250101-000000.db-started") | Out-Null
Set-Content -Path (Join-Path (Get-UploadsDir $d) ".restore-20250202-000000.db-started") -Value "" -NoNewline -Encoding Ascii
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ($steps.Count -eq 0) "docker was asked to do nothing (calls: $($steps.Count))"
Assert ($r.Output -match "ERROR: the uploads folder holds a marker left by an earlier restore: \.\\data\\uploads\\\.restore-20250101-000000\.db-started, \.\\data\\uploads\\\.restore-20250202-000000\.db-started\. No recovery file") "names the folder and the file, with the host path in backslashes"
Assert ($r.Output -match 'clear-marker /app/uploads "20250101-000000" && docker compose run [^\r\n&]* clear-marker /app/uploads "20250202-000000"  Then run the restore again\. Nothing was done\.') "one command line removes both"
Show-EvidenceIfFailed $r
Remove-Item -Recurse -Force (Join-Path (Get-UploadsDir $d) ".restore-20250101-000000.db-started")
Remove-Item -Force (Join-Path (Get-UploadsDir $d) ".restore-20250202-000000.db-started")
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine }
Assert ($r.Output -notmatch "holds a marker left by an earlier restore" -and (Get-StepIndex @(Get-RestoreSteps $r) 'full-backup\.mjs --verify') -ge 0) "with both removed the same install gets past the marker check (the backup is checked)"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------- scenario RS28
Write-Scenario "restore.bat - finished, marker stuck, and the recovery file CANNOT be replaced: the last line does not say 'the same is in' it; the file is still the original, whole; no work file is left"
$d = New-RestoreSandbox "restore-marker-stuck-readonly"
$pf = New-PassFile $d "$BackupPass`n"
$r = Invoke-Restore $d "$RestoreName --yes --passphrase-file `"$pf`"" @{ "BV_STUB_RESTORE_STDOUT" = $RestoreOkLine; "BV_STUB_RESTORE_MARKER_DIR" = (Get-UploadsDir $d); "BV_STUB_CLEAR_MARKER_EXIT" = "1"; "BV_STUB_RECOVERY_READONLY" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
$steps = @(Get-RestoreSteps $r)
Assert ((Get-StepIndex $steps '^compose up -d$') -eq -1) "BlackVault was NOT started"
Assert ($r.Output -match "Do NOT run the recovery commands that were printed before the restore started: they would undo the restore\. Remove the marker with:  docker compose run [^\r\n]* clear-marker /app/uploads \d{8}-\d{6}  Then start BlackVault: docker compose up -d  .*backups\\restore-\d{8}-\d{6}-RECOVERY\.txt could not be rewritten: it still holds the steps written before the restore\. Do NOT follow them; delete that file once BlackVault is running\.") "the last line says the file could not be rewritten and not to follow it"
Assert (-not $r.Output.Contains("The same is in")) "it does not say 'The same is in'"
$recovery = @(Get-RecoveryFiles $d)
$kept = if ($recovery.Count -eq 1) { [IO.File]::ReadAllText((Join-Path $d "backups\$($recovery[0])")) } else { "" }
Assert ($kept -match "^BlackVault restore \d{8}-\d{6}: RECOVERY" -and $kept -notmatch "ONE STEP LEFT") "the recovery file is the original text, whole: never a mix of the two"
Assert (@(Get-ChildItem -Path (Join-Path $d "backups") -Filter "*.new" -ErrorAction SilentlyContinue).Count -eq 0) "no work file is left in backups"
Show-EvidenceIfFailed $r
foreach ($f in $recovery) { Set-ItemProperty -Path (Join-Path $d "backups\$f") -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue }

# ══════════════════════════════════════════════════════════════════════════
# reencrypt-files.bat (Task 8)
# ══════════════════════════════════════════════════════════════════════════
# REAL here: reencrypt-files.bat. STUBBED: docker - `compose ps`, `compose
# stop`, `compose start`, and the re-encryption program (any `compose run ...
# dist/scripts/reencrypt-files.mjs`, knobs BV_STUB_REENCRYPT_*). So these
# scenarios prove the ORDER of the docker calls, that the old key file's bytes
# reach the program on standard input and are in no argv and no environment,
# whether BlackVault is started again, and the exit codes. What the program
# does to files is proven on Linux (src/lib/files/reencrypt.real-fs.test.ts,
# scripts/reencrypt-files-cli.test.ts).
#
# The old key file is handed over by the SAME PowerShell line as a passphrase
# file in backup.bat (BK1-BK11 above).

$OldKey = "5a17c0de" * 8
$ReencryptCall = "compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs"
$ReencryptOkLine = "BLACKVAULT_REENCRYPT_OK reencrypted=4 already_current=2 unknown_key=1 not_encrypted=1 failed=0 stopped=0"
$ReencryptNothingLine = "BLACKVAULT_REENCRYPT_NOTHING reencrypted=0 already_current=6 unknown_key=1 not_encrypted=1 failed=0 stopped=0"
$ReencryptWhenRunning = "compose ps --status running -q blackvault || compose stop blackvault || $ReencryptCall || compose start blackvault"
$ReencryptWhenStopped = "compose ps --status running -q blackvault || compose stop blackvault || $ReencryptCall"

function New-ReencryptSandbox([string]$Name) {
  $dir = Join-Path $Sandboxes $Name
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  foreach ($f in @("reencrypt-files.bat", "docker-compose.yml")) { Copy-Item (Join-Path $RepoRoot $f) $dir }
  [IO.File]::WriteAllText((Join-Path $dir ".env"), "PORT=3000`r`nBLACKVAULT_DB_PROVIDER=sqlite`r`n", [Text.Encoding]::ASCII)
  return $dir
}

function Invoke-Reencrypt([string]$Dir, [string]$BatArgs, [hashtable]$EnvVars = @{}, [int]$TimeoutSeconds = 120) {
  $vars = @{
    "BV_STUB_REENCRYPT_STDIN_FILE" = (Join-Path $Dir "__stdin.bin"); "BV_STUB_ENV_FILE" = (Join-Path $Dir "__env.txt")
    "BV_STUB_REENCRYPT_EXIT" = $null; "BV_STUB_REENCRYPT_STDOUT" = $null; "BV_STUB_REENCRYPT_STDERR" = $null
    "BV_STUB_APP_RUNNING" = $null; "BV_STUB_BACKUP_SLEEP_MS" = $null; "BV_LIMIT" = $null; "BV_PASSFILE" = $null
    "BLACKVAULT_BACKUP_TIMEOUT" = $null; "BLACKVAULT_BACKUP_DIR" = $null
  }
  foreach ($k in $EnvVars.Keys) { $vars[$k] = $EnvVars[$k] }
  Remove-Item -Force $vars["BV_STUB_REENCRYPT_STDIN_FILE"], $vars["BV_STUB_ENV_FILE"] -ErrorAction SilentlyContinue
  return Invoke-Bat -Dir $Dir -Script "reencrypt-files.bat" -BatArgs $BatArgs -EnvVars $vars -NoPad -TimeoutSeconds $TimeoutSeconds
}

# The docker calls of one run, without the Compose version probe, joined with " || ".
function Get-ReencryptCalls([pscustomobject]$Result) {
  return (@(Get-RestoreSteps $Result) -join " || ")
}

# ---------------------------------------------------------------- scenario RF1
Write-Scenario "reencrypt-files.bat - BlackVault running: ps, stop, the program in a one-off container, start; the old key file's bytes arrive on stdin unchanged and are in no argv and no environment; the key file is untouched"
$d = New-ReencryptSandbox "reencrypt-running"
$keyText = "$OldKey`r`n"
$kf = New-PassFile $d $keyText "old.key"
$keyBefore = Get-FileBase64 $kf
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_REENCRYPT_STDOUT" = $ReencryptOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$calls = Get-ReencryptCalls $r
Assert ($calls -eq $ReencryptWhenRunning) "the docker calls, in order: $ReencryptWhenRunning (got: $calls)"
Assert ($r.StubLog -notmatch "--user|--no-deps|compose exec") "a one-off container with no --user and no --no-deps; never exec"
$stdinFile = Join-Path $d "__stdin.bin"
$expected = (New-Object Text.UTF8Encoding($false)).GetBytes($keyText)
Assert (Test-Path $stdinFile) "the program's standard input was recorded (it was started)"
$gotLength = if (Test-Path $stdinFile) { (Get-Item $stdinFile).Length } else { -1 }
Assert ((Get-FileBase64 $stdinFile) -eq [Convert]::ToBase64String($expected)) "stdin is the old key file byte for byte ($gotLength bytes, expected $($expected.Length)): nothing stripped, no byte-order mark added"
Assert (-not $r.StubLog.Contains("5a17c0de")) "the old key is in no docker argv"
$envDump = if (Test-Path (Join-Path $d "__env.txt")) { [IO.File]::ReadAllText((Join-Path $d "__env.txt")) } else { "" }
Assert ($envDump.Contains("BV_DOCKER_ARGS=")) "the environment of the program's call was recorded"
Assert (-not $envDump.Contains("5a17c0de")) "the old key is not in the environment docker inherited"
Assert (-not $r.Output.Contains("5a17c0de")) "the old key is never printed"
Assert ($r.Output.Contains($ReencryptOkLine)) "the program's line is passed through"
Assert ($r.Output.Contains("Done. Keep the old key file until BlackVault has started and your photos and documents open. BlackVault was started again.")) "says it is done and that BlackVault was started again"
Assert ((Test-Path $kf) -and ((Get-FileBase64 $kf) -eq $keyBefore)) "the old key file is still there, byte for byte"
Assert (@(Get-ChildItem -Force $d | Where-Object { $_.Name -notmatch '^(__.*|\.env|docker-compose\.yml|reencrypt-files\.bat|old\.key)$' }).Count -eq 0) "nothing was written into the install folder"
Assert ($r.Output -notmatch "is not recognized as an internal or external command") "no stray command fragment was executed"
Assert ($r.Output -notmatch "The syntax of the command is incorrect") "no syntax error"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF2
Write-Scenario "reencrypt-files.bat - BlackVault NOT running: stopped anyway, the program runs, and it is NOT started - said plainly"
$d = New-ReencryptSandbox "reencrypt-stopped"
$kf = New-PassFile $d "$OldKey`n" "old.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_REENCRYPT_STDOUT" = $ReencryptOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
$calls = Get-ReencryptCalls $r
Assert ($calls -eq $ReencryptWhenStopped) "the docker calls, in order, with no start: $ReencryptWhenStopped (got: $calls)"
Assert ($r.Output.Contains("BlackVault was not running before, so it was NOT started. Start it with: docker compose up -d")) "says it was not started, and how to start it"
$got = if (Test-Path (Join-Path $d "__stdin.bin")) { [IO.File]::ReadAllText((Join-Path $d "__stdin.bin"), (New-Object Text.UTF8Encoding($false))) } else { "" }
Assert ($got -eq "$OldKey`n") "the old key arrived on stdin"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF3
Write-Scenario "reencrypt-files.bat - the program's exit 3 (no file under the old key; also the second run) is passed through; BlackVault is started again if it was running"
$d = New-ReencryptSandbox "reencrypt-exit3"
$kf = New-PassFile $d "$OldKey`n" "old.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_REENCRYPT_EXIT" = "3"; "BV_STUB_REENCRYPT_STDOUT" = $ReencryptNothingLine; "BV_STUB_REENCRYPT_STDERR" = "reencrypt-files: nothing to do: no uploaded file is encrypted with the old key (key id 02d449a3)." }
Assert ($r.ExitCode -eq 3) "exits 3 (got $($r.ExitCode))"
Assert ($r.Output.Contains($ReencryptNothingLine)) "the program's line is passed through"
Assert ($r.Output -match "nothing to do: no uploaded file is encrypted with the old key") "the program's reason is shown"
Assert ($r.Output.Contains("Nothing was changed. BlackVault was started again.")) "says nothing was changed and that BlackVault was started again"
Assert ((Get-ReencryptCalls $r) -eq $ReencryptWhenRunning) "started again: $ReencryptWhenRunning (got: $(Get-ReencryptCalls $r))"
Assert ($r.Output -notmatch "ERROR:") "no ERROR line: nothing failed"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_REENCRYPT_EXIT" = "3" }
Assert ($r.ExitCode -eq 3) "not running before: exits 3 (got $($r.ExitCode))"
Assert ($r.Output.Contains("Nothing was changed. BlackVault was not running before, so it was NOT started.")) "and says it was NOT started"
Assert ((Get-ReencryptCalls $r) -eq $ReencryptWhenStopped) "no start (got: $(Get-ReencryptCalls $r))"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF4
Write-Scenario "reencrypt-files.bat - exit codes: the program's 1 stays 1; anything else becomes 1 with one ERROR line; both say whether BlackVault was started"
$d = New-ReencryptSandbox "reencrypt-exit-codes"
$kf = New-PassFile $d "$OldKey`n" "old.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_REENCRYPT_EXIT" = "1"; "BV_STUB_REENCRYPT_STDERR" = "reencrypt-files: Could not write documents/d.pdf (ENOSPC); it was left as it was." }
Assert ($r.ExitCode -eq 1) "exit 1 stays 1 (got $($r.ExitCode))"
Assert ($r.Output -match "Could not write documents/d\.pdf \(ENOSPC\)") "the program's message is shown"
Assert ($r.Output.Contains("ERROR: the re-encryption did not complete. The lines above say why, and whether running reencrypt-files.bat again will continue or the files named there must be restored or moved out first. BlackVault was started again.")) "says it did not complete, points at the program's own lines for what to do, and says BlackVault was started again"
Assert ($r.Output -notmatch "again to continue") "does not promise that running it again continues (a file that cannot be converted would fail again)"
Assert ($r.Output -notmatch "ended unexpectedly") "nothing added for exit 1"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_REENCRYPT_EXIT" = "137" }
Assert ($r.ExitCode -eq 1) "exit 137 becomes 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: the re-encryption command ended unexpectedly \(exit 137\)") "says the command ended unexpectedly"
Assert ($r.Output.Contains("BlackVault was not running before, so it was NOT started.")) "and that BlackVault was NOT started"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF5
Write-Scenario "reencrypt-files.bat - a missing or empty old key file, or a folder: exit 3 before docker is touched; no --from-key-file or an unknown argument: exit 1, never echoed"
$d = New-ReencryptSandbox "reencrypt-bad-args"
$r = Invoke-Reencrypt $d "--from-key-file `"$(Join-Path $d 'nope.key')`"" @{ "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 3 -and $r.Output -match "ERROR: cannot read the old key file" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "a missing old key file: exit 3, docker never invoked (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$empty = New-PassFile $d "" "empty.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$empty`"" @{ "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 3 -and $r.Output -match "ERROR: the old key file .* is empty" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "an empty old key file: exit 3, docker never invoked (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file `"$d`"" @{ "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 3 -and $r.Output -match "ERROR: cannot read the old key file" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "a folder instead of a file: exit 3, docker never invoked (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d ""
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: no old key file was given" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "no --from-key-file: exit 1, docker never invoked (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file"
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: --from-key-file needs a path" -and [string]::IsNullOrWhiteSpace($r.StubLog)) "--from-key-file without a value: exit 1 (exit $($r.ExitCode))"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key $OldKey"
Assert ($r.ExitCode -eq 1 -and $r.Output -match "ERROR: unknown argument") "an unknown argument is refused (exit $($r.ExitCode))"
Assert (-not $r.Output.Contains("5a17c0de")) "and is not echoed back (it could be a key)"
Assert ([string]::IsNullOrWhiteSpace($r.StubLog)) "docker was never invoked"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF6
# See BK11: a bare `shift` in the argument parser would move the key file's
# path into %0, and `cd /d "%~dp0"` would then go to the key file's folder.
Write-Scenario "reencrypt-files.bat - the old key file lives in ANOTHER folder: the script still works from its own folder"
$elsewhere = Join-Path $Sandboxes "reencrypt-key-elsewhere-secrets"
New-Item -ItemType Directory -Force -Path $elsewhere | Out-Null
$d = New-ReencryptSandbox "reencrypt-key-elsewhere"
$kf = New-PassFile $elsewhere "$OldKey`n" "old.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_REENCRYPT_STDOUT" = $ReencryptOkLine }
Assert ($r.ExitCode -eq 0) "exits 0 (got $($r.ExitCode))"
Assert ((Get-ReencryptCalls $r) -eq $ReencryptWhenRunning) "the docker calls, in order (got: $(Get-ReencryptCalls $r))"
$got = if (Test-Path (Join-Path $d "__stdin.bin")) { [IO.File]::ReadAllText((Join-Path $d "__stdin.bin"), (New-Object Text.UTF8Encoding($false))) } else { "" }
Assert ($got -eq "$OldKey`n") "the old key arrived on stdin"
Assert (@(Get-ChildItem -Force $elsewhere).Count -eq 1) "nothing was written beside the key file"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF7
Write-Scenario "reencrypt-files.bat - stop fails: exit 1 and the program is never started; the restart fails after a good run, or after a run that changed nothing: exit 1, saying only starting BlackVault failed (ruling R31)"
$d = New-ReencryptSandbox "reencrypt-stop-start-fail"
$kf = New-PassFile $d "$OldKey`n" "old.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_FAIL_ON" = "stop" }
Assert ($r.ExitCode -eq 1) "stop fails: exits 1 (got $($r.ExitCode))"
Assert ($r.Output.Contains("ERROR: could not stop BlackVault. Nothing was changed; BlackVault was left as it was.")) "says so"
Assert ((Get-ReencryptCalls $r) -eq "compose ps --status running -q blackvault || compose stop blackvault") "the program was never started, nothing was started (got: $(Get-ReencryptCalls $r))"
Assert (-not (Test-Path (Join-Path $d "__stdin.bin"))) "the old key was handed to nothing"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_FAIL_ON" = "start"; "BV_STUB_REENCRYPT_STDOUT" = $ReencryptOkLine }
Assert ($r.ExitCode -eq 1) "the restart fails after a good run: exits 1 (got $($r.ExitCode))"
Assert ($r.Output.Contains($ReencryptOkLine)) "the program's own line still says OK"
Assert ($r.Output.Contains("ERROR: the re-encryption itself completed, and only starting BlackVault again failed. Keep the old key file until BlackVault has started and your photos and documents open. BlackVault did NOT start again: check the logs (docker compose logs blackvault) and start it by hand: docker compose up -d")) "says the re-encryption itself completed and only the start failed, with the command"
Assert (-not $r.Output.Contains("BlackVault was started again.") -and -not $r.Output.Contains("Done.")) "and does not claim it was started, or that all is done"
Assert ((Get-ReencryptCalls $r) -eq $ReencryptWhenRunning) "the start was attempted once (got: $(Get-ReencryptCalls $r))"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BV_STUB_FAIL_ON" = "start"; "BV_STUB_REENCRYPT_EXIT" = "3"; "BV_STUB_REENCRYPT_STDOUT" = $ReencryptNothingLine }
Assert ($r.ExitCode -eq 1) "the restart fails after a run that changed nothing: exits 1, not 3 (got $($r.ExitCode))"
Assert ($r.Output.Contains("ERROR: nothing was changed, and only starting BlackVault again failed. BlackVault did NOT start again: check the logs (docker compose logs blackvault) and start it by hand: docker compose up -d")) "says nothing was changed and only the start failed, with the command"
Show-EvidenceIfFailed $r

# ---------------------------------------------------------------- scenario RF8
Write-Scenario "reencrypt-files.bat - Docker Compose too old: exit 1 before anything is stopped; BLACKVAULT_* and BV_LIMIT set in the console do not reach or limit the run"
$d = New-ReencryptSandbox "reencrypt-compose-env"
$kf = New-PassFile $d "$OldKey`n" "old.key"
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_COMPOSE_VERSION" = "2.19.0"; "BV_STUB_APP_RUNNING" = "1" }
Assert ($r.ExitCode -eq 1) "exits 1 (got $($r.ExitCode))"
Assert ($r.Output -match "ERROR: BlackVault needs Docker Compose v2\.20 or newer") "explains the v2.20 requirement"
Assert ((Get-ReencryptCalls $r) -eq "") "nothing was stopped or run (got: $(Get-ReencryptCalls $r))"
Show-EvidenceIfFailed $r
$r = Invoke-Reencrypt $d "--from-key-file `"$kf`"" @{ "BV_STUB_APP_RUNNING" = "1"; "BLACKVAULT_DATABASE_URL" = "file:./dev.db"; "BLACKVAULT_UPLOADS_SNAPSHOT" = "backups\uploads-x"; "BV_LIMIT" = "1"; "BV_STUB_BACKUP_SLEEP_MS" = "4000"; "BV_STUB_REENCRYPT_STDOUT" = $ReencryptOkLine }
$envDump = if (Test-Path (Join-Path $d "__env.txt")) { [IO.File]::ReadAllText((Join-Path $d "__env.txt")) } else { "MISSING" }
Assert ($r.ExitCode -eq 0) "exits 0: a BV_LIMIT of 1 second in the console did not cut a 4 second run short (got $($r.ExitCode))"
Assert ($envDump -ne "MISSING" -and $envDump -notmatch "BLACKVAULT_DATABASE_URL=|BLACKVAULT_UPLOADS_SNAPSHOT=") "docker compose would read those keys from .env only"
Assert ($r.Output -notmatch "did not finish within") "no time-limit message"
Show-EvidenceIfFailed $r

# --------------------------------------------------------------------- report
Write-Host "`n================ summary ================"
Write-Host "$($script:Checks) checks, $($script:Failures.Count) failed"
if ($script:Failures.Count -gt 0) {
  foreach ($f in $script:Failures) { Write-Host "  FAILED: $f" -ForegroundColor Red }
  exit 1
}
Write-Host "install.bat, update.bat, rotate-key.bat, backup.bat, restore.bat, reencrypt-files.bat and scripts\db-snapshot.bat verified on Windows (Docker stubbed)." -ForegroundColor Green
exit 0
