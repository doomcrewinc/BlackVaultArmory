/**
 * backup.sh (full-backups spec §2, Task 6), run for real under bash with a
 * stub `docker` first on PATH. The stub records, per call, its argv, its
 * whole environment and the argv of every process alive at that moment, and
 * — for the backup program's call — the bytes it was given on standard
 * input. That is how "the passphrase reaches the program on stdin and
 * nowhere else" is checked on the real script instead of read off it.
 * Limit of the `ps` record (found by injection): it sees docker's siblings
 * and ancestors, not a short-lived helper that has already exited — a
 * wrapper that ran `/bin/echo "$PASSPHRASE" |` would pass it. That the
 * typed passphrase is only ever handled by shell builtins is by inspection.
 *
 * What the backup program itself does with --keep and --verify (real files,
 * a corrupted newest archive, the lock) is in scripts/full-backup-cli.test.ts:
 * pruning runs inside the container (ruling R18), so here the stub only
 * proves what the wrapper passes on and how it maps the exit code.
 * backup.bat is covered by scripts/ci/windows/Test-WindowsInstallers.ps1.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;
const has = (cmd: string) => !isWindows && spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const hasPython = has("python3");
const hasTimeout = has("timeout");

// Shell metacharacters, quotes, non-ASCII and leading/trailing spaces: none of it may be interpreted or trimmed.
const PASS = " wrapper tëst 'pass' \"phrase\" $HOME `id` \\n * ";
const OK_LINE = "BLACKVAULT_FULL_BACKUP_OK file=blackvault-full-20261002-180405.bvb files=2 bytes=10 archive_bytes=99 skipped=0 unreadable=0";
const BACKUP_EXEC = "compose exec -T -u 1001 blackvault node dist/scripts/full-backup.mjs";
const BACKUP_RUN = "compose run --rm -T blackvault node dist/scripts/full-backup.mjs";

let tmp: string;
let app: string;
let bin: string;
let rec: string;

/**
 * The docker stub. `compose version --short` → BV_STUB_COMPOSE_VERSION
 * (default 2.30.1); `compose ps --status running -q blackvault` → a container
 * id when BV_STUB_RUNNING=1, nothing otherwise; the backup program's call →
 * records stdin, optionally sleeps BV_STUB_SLEEP seconds, prints
 * BV_STUB_STDOUT / BV_STUB_STDERR and exits BV_STUB_EXIT (default 0).
 */
function writeStub() {
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "${rec}/calls"
env >> "${rec}/env"
ps -Ao args >> "${rec}/ps" 2>/dev/null
case "$*" in
  "compose version --short") echo "\${BV_STUB_COMPOSE_VERSION-2.30.1}" ;;
  "compose ps --status running -q blackvault") [ "\${BV_STUB_RUNNING:-}" = 1 ] && echo "0123456789ab" ;;
  *"dist/scripts/full-backup.mjs"*)
    cat > "${rec}/stdin"
    [ -n "\${BV_STUB_SLEEP:-}" ] && sleep "$BV_STUB_SLEEP"
    [ -n "\${BV_STUB_STDOUT:-}" ] && echo "$BV_STUB_STDOUT"
    [ -n "\${BV_STUB_STDERR:-}" ] && echo "$BV_STUB_STDERR" >&2
    exit "\${BV_STUB_EXIT:-0}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
}

/** Drives a command on a pseudo-terminal: waits for each prompt (output ending in ": ") before typing the next line of the answers file. */
const PTY_HELPER = `
import os, pty, select, sys, time
answers = open(sys.argv[1], "rb").read().split(b"\\n")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out = b""
seen = 0
deadline = time.time() + 40
def pump(until_prompt):
    global out
    while time.time() < deadline:
        if until_prompt and out[seen:].endswith(b": "):
            return True
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                return False
            if not data:
                return False
            out += data
    return False
for line in answers:
    if not pump(True):
        break
    seen = len(out)
    os.write(fd, line + b"\\n")
pump(False)
_, status = os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 99)
`;

interface RunOpts {
  env?: Record<string, string>;
  cwd?: string;
  input?: string;
  devNull?: boolean;
  timeout?: number;
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${bin}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: tmp, ...extra } as unknown as NodeJS.ProcessEnv;
}

const read = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name), "utf8") : "");
const readBytes = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name)) : null);
const callLines = () => read("calls").split("\n").filter(Boolean);
const lines = (text: string) => text.split("\n").filter(Boolean);

/** bash backup.sh <args>, with stdin a pipe (never a terminal) or /dev/null. */
function run(args: string[], opts: RunOpts = {}) {
  const started = Date.now();
  const r = spawnSync("bash", [path.join(app, "backup.sh"), ...args], {
    cwd: opts.cwd ?? app,
    env: baseEnv(opts.env),
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
    ...(opts.devNull ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input: opts.input ?? "" }),
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - started };
}

/** bash backup.sh <args> on a pseudo-terminal, typing `answers` (one per prompt). stdout and stderr arrive mixed. */
function runOnTty(args: string[], answers: string[], env: Record<string, string> = {}) {
  const helper = path.join(tmp, "pty-helper.py");
  fs.writeFileSync(helper, PTY_HELPER);
  // In a FILE, not on python's command line: the stub records every process's argv.
  const answersFile = path.join(tmp, "answers");
  fs.writeFileSync(answersFile, answers.join("\n"));
  const r = spawnSync("python3", [helper, answersFile, "bash", path.join(app, "backup.sh"), ...args], {
    cwd: app,
    env: baseEnv(env),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The passphrase is in no recorded argv, no recorded environment, and no process's argv at the time of any docker call. */
function expectPassphraseOnlyOnStdin(passphrase: string) {
  for (const needle of [passphrase, passphrase.trim(), "wrapper tëst", "phrase\\\""]) {
    expect(read("calls")).not.toContain(needle);
    expect(read("env")).not.toContain(needle);
    expect(read("ps")).not.toContain(needle);
  }
  expect(read("env")).toContain("PATH="); // the environment really was recorded
  if (fs.existsSync(path.join(rec, "ps"))) expect(read("ps")).toContain("docker");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-backup-sh-"));
  app = path.join(tmp, "app");
  bin = path.join(tmp, "bin");
  rec = path.join(tmp, "rec");
  for (const d of [bin, rec, path.join(app, "scripts")]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["backup.sh", "scripts/compose-provider.sh", "docker-compose.yml"]) fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  fs.writeFileSync(path.join(app, ".env"), "PORT=3000\nBLACKVAULT_DB_PROVIDER=sqlite\n");
  writeStub();
});
afterEach(() => {
  const backups = path.join(app, "data/backups");
  if (fs.existsSync(backups)) fs.chmodSync(backups, 0o700);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function passFile(content: string | Buffer = `${PASS}\n`, name = "pass.txt") {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

describe.skipIf(isWindows)("backup.sh", () => {
  describe("the passphrase", () => {
    it("--passphrase-file: the file's bytes reach the backup program on stdin UNCHANGED, and the passphrase is in no argv and no environment", () => {
      // CRLF + an extra blank line: the wrapper strips nothing (the program drops exactly one trailing line ending).
      const bytes = Buffer.from(`${PASS}\r\n\n`, "utf8");
      const r = run(["--passphrase-file", passFile(bytes)], { env: { BV_STUB_RUNNING: "1", BV_STUB_STDOUT: OK_LINE } });
      expect(r.code, r.stderr).toBe(0);
      expect(readBytes("stdin")!.equals(bytes)).toBe(true);
      expectPassphraseOnlyOnStdin(PASS);
      expect(r.stdout).toBe(`${OK_LINE}\n`); // exactly the program's line, nothing added
      expect(r.stderr).toBe("");
    });

    it("a relative --passphrase-file is relative to where the user ran the script, not to the script's folder", () => {
      const elsewhere = path.join(tmp, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, "p.txt"), `${PASS}\n`);
      const r = run(["--passphrase-file", "p.txt"], { cwd: elsewhere, env: { BV_STUB_RUNNING: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(read("stdin")).toBe(`${PASS}\n`);
    });

    it("a missing or empty passphrase file: exit 1, one line on stderr, docker never called", () => {
      const missing = run(["--passphrase-file", path.join(tmp, "nope.txt")]);
      expect(missing.code).toBe(1);
      expect(lines(missing.stderr)).toHaveLength(1);
      expect(missing.stderr).toMatch(/^ERROR: cannot read the passphrase file .*nope\.txt/);
      const empty = run(["--passphrase-file", passFile("", "empty.txt")]);
      expect(empty.code).toBe(1);
      expect(empty.stderr).toMatch(/^ERROR: the passphrase file .* is empty\.\n$/);
      expect(callLines()).toEqual([]);
    });

    it("Review Focus 5 (cron): no --passphrase-file and no terminal → exit 1 at once with one clear line; docker is never called and nothing waits", () => {
      for (const opts of [{ input: "" }, { devNull: true }, { input: `${PASS}\n${PASS}\n` }] as RunOpts[]) {
        const r = run([], { ...opts, timeout: 15_000, env: { BV_STUB_RUNNING: "1" } });
        expect(r.signal).toBeNull(); // not killed by the test's timeout
        expect(r.code).toBe(1);
        expect(r.ms).toBeLessThan(10_000);
        expect(r.stdout).toBe("");
        expect(lines(r.stderr)).toHaveLength(1);
        expect(r.stderr).toMatch(/^ERROR: no passphrase: standard input is not a terminal.*--passphrase-file/);
      }
      const v = run(["--verify", "blackvault-full-20261002-180405.bvb"], { devNull: true, timeout: 15_000 });
      expect(v.code).toBe(1);
      expect(v.stderr).toMatch(/^ERROR: no passphrase: standard input is not a terminal/);
      expect(callLines()).toEqual([]);
    });

    it.skipIf(!hasPython)("typed at the prompt (R19): asked twice without echo; the same passphrase twice → sent on stdin exactly as typed, in no argv or environment", () => {
      const r = runOnTty([], [PASS, PASS], { BV_STUB_RUNNING: "1", BV_STUB_STDOUT: OK_LINE });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("Backup passphrase: ");
      expect(r.out).toContain("Repeat the passphrase: ");
      expect(r.out).not.toContain(PASS); // never echoed
      expect(r.out).not.toContain("wrapper tëst");
      expect(r.out).toContain(OK_LINE);
      expect(read("stdin")).toBe(PASS); // spaces, quotes, $, backticks and backslashes intact
      expectPassphraseOnlyOnStdin(PASS);
      expect(callLines()).toContain(`${BACKUP_EXEC} --keep 7`);
    });

    it.skipIf(!hasPython)("typed at the prompt (R19): two different passphrases → exit 1, says so, and the backup program is never started", () => {
      const r = runOnTty([], [PASS, `${PASS}x`], { BV_STUB_RUNNING: "1" });
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("ERROR: the two passphrases do not match. Nothing was done.");
      expect(r.out).not.toContain("wrapper tëst");
      expect(callLines().filter((c) => c.includes("full-backup.mjs"))).toEqual([]);
      expect(fs.existsSync(path.join(rec, "stdin"))).toBe(false);
      expectPassphraseOnlyOnStdin(PASS);
    });

    it.skipIf(!hasPython)("typed at the prompt: an empty passphrase is refused; --verify asks ONCE (no confirmation)", () => {
      const empty = runOnTty([], ["", ""], { BV_STUB_RUNNING: "1" });
      expect(empty.code, empty.out).toBe(1);
      expect(empty.out).toContain("ERROR: the passphrase is empty.");
      expect(callLines().filter((c) => c.includes("full-backup.mjs"))).toEqual([]);

      const v = runOnTty(["--verify", "blackvault-full-20261002-180405.bvb"], [PASS], { BV_STUB_RUNNING: "1" });
      expect(v.code, v.out).toBe(0);
      expect(v.out).toContain("Backup passphrase: ");
      expect(v.out).not.toContain("Repeat the passphrase");
      expect(read("stdin")).toBe(PASS);
      expect(callLines()).toContain(`${BACKUP_EXEC} --verify blackvault-full-20261002-180405.bvb`);
    });
  });

  describe("running or stopped", () => {
    it("app running → `docker compose exec -T -u 1001 blackvault node dist/scripts/full-backup.mjs --keep 7` (the default keep is the wrapper's)", () => {
      const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(callLines()).toEqual(["compose version --short", "compose ps --status running -q blackvault", `${BACKUP_EXEC} --keep 7`]);
    });

    it("app stopped → `docker compose run --rm -T blackvault …`: no --user (the entrypoint must start as root to place the key) and no --no-deps (PostgreSQL must be started)", () => {
      const r = run(["--passphrase-file", passFile(), "--keep", "3"]);
      expect(r.code, r.stderr).toBe(0);
      expect(callLines()).toEqual(["compose version --short", "compose ps --status running -q blackvault", `${BACKUP_RUN} --keep 3`]);
      expect(read("calls")).not.toMatch(/--user|--no-deps|-u 1001/);
      expect(read("stdin")).toBe(`${PASS}\n`);
      expectPassphraseOnlyOnStdin(PASS);
    });

    it("BLACKVAULT_* keys exported in the shell do not reach docker compose (it must read them from .env only)", () => {
      const r = run(["--passphrase-file", passFile()], {
        env: { BLACKVAULT_BACKUP_DIR: "/somewhere/else", BLACKVAULT_DATABASE_URL: "file:./dev.db", BLACKVAULT_UPLOADS_SNAPSHOT: "backups/uploads-x" },
      });
      expect(r.code, r.stderr).toBe(0);
      const backupCallEnv = read("env").split("PATH=").pop()!; // the last recorded environment: the backup call's
      expect(backupCallEnv).not.toMatch(/BLACKVAULT_BACKUP_DIR|BLACKVAULT_DATABASE_URL|BLACKVAULT_UPLOADS_SNAPSHOT/);
    });

    it("Docker Compose missing or older than 2.20: exit 1, one line, nothing run", () => {
      for (const version of ["2.19.3", ""]) {
        fs.rmSync(path.join(rec, "calls"), { force: true });
        const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_COMPOSE_VERSION: version } });
        expect(r.code).toBe(1);
        expect(lines(r.stderr)).toHaveLength(1);
        expect(r.stderr).toMatch(/^ERROR: BlackVault needs Docker Compose v2\.20 or newer/);
        expect(callLines()).toEqual(["compose version --short"]);
      }
    });
  });

  describe("--keep", () => {
    it("passes the number through, normalised (leading zeros dropped)", () => {
      const r = run(["--keep", "02", "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(callLines().pop()).toBe(`${BACKUP_EXEC} --keep 2`);
    });

    it.each(["0", "000", "-1", "1.5", "seven", "2e3", "1000000", " 3", ""])("--keep %j is refused before anything runs: exit 1, one line, docker never called", (value) => {
      const r = run(["--keep", value, "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(lines(r.stderr)).toHaveLength(1);
      expect(r.stderr).toMatch(/^ERROR: --keep needs a /);
      expect(callLines()).toEqual([]);
    });

    it("--keep together with --verify is refused", () => {
      const r = run(["--verify", "x.bvb", "--keep", "2", "--passphrase-file", passFile()]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ERROR: --keep cannot be used with --verify/);
      expect(callLines()).toEqual([]);
    });

    it("does not run a second verify pass or delete anything itself: exactly one backup-program call", () => {
      fs.mkdirSync(path.join(app, "data/backups"), { recursive: true });
      const old = ["blackvault-full-20200101-000000.bvb", "blackvault-full-20200102-000000.bvb", "blackvault-full-20200103-000000.bvb"];
      for (const f of old) fs.writeFileSync(path.join(app, "data/backups", f), "x");
      const r = run(["--keep", "1", "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_STDOUT: OK_LINE } });
      expect(r.code, r.stderr).toBe(0);
      expect(callLines().filter((c) => c.includes("full-backup.mjs"))).toEqual([`${BACKUP_EXEC} --keep 1`]);
      expect(fs.readdirSync(path.join(app, "data/backups")).sort()).toEqual(old);
    });
  });

  describe("exit codes", () => {
    it("the lock: the program's exit 2 (another backup is already running) is passed through unchanged, with its message", () => {
      const r = run(["--passphrase-file", passFile()], {
        env: { BV_STUB_RUNNING: "1", BV_STUB_EXIT: "2", BV_STUB_STDERR: "full-backup: Another full backup is already running (pid 7 on abc, started 2026-10-02T18:04:05.000Z)." },
      });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("full-backup: Another full backup is already running (pid 7 on abc, started 2026-10-02T18:04:05.000Z).\n");
    });

    it("exit 2 is passed through from a one-off container too", () => {
      expect(run(["--passphrase-file", passFile()], { env: { BV_STUB_EXIT: "2" } }).code).toBe(2);
    });

    it("the program's exit 1 → 1, with its own line and nothing added", () => {
      const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_EXIT: "1", BV_STUB_STDERR: "full-backup: The backup folder /app/backups is not writable (EACCES)." } });
      expect(r.code).toBe(1);
      expect(r.stderr).toBe("full-backup: The backup folder /app/backups is not writable (EACCES).\n");
    });

    it.each(["3", "125", "137"])("any other exit code (%s) → 1, with one ERROR line", (code) => {
      const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_EXIT: code } });
      expect(r.code).toBe(1);
      expect(r.stderr).toBe(`ERROR: the backup command ended unexpectedly (exit ${code}); see the output above.\n`);
    });

    it("an unknown argument: exit 1, and the argument is NOT echoed (it could be a passphrase)", () => {
      const r = run(["--passphrase", "typed-on-the-command-line-by-mistake"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ERROR: unknown argument\. Usage: /);
      expect(r.stderr).not.toContain("typed-on-the-command-line-by-mistake");
      expect(callLines()).toEqual([]);
    });
  });

  describe("--verify <file>", () => {
    const NAME = "blackvault-full-20261002-180405.bvb";
    const verifyCall = () => callLines().filter((c) => c.includes("full-backup.mjs"));

    it("a bare file name is passed as it is; --verify does not confirm or prune (no --keep)", () => {
      const r = run(["--verify", NAME, "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(verifyCall()).toEqual([`${BACKUP_EXEC} --verify ${NAME}`]);
      expect(read("stdin")).toBe(`${PASS}\n`);
    });

    it("stopped app: the same mapping through a one-off container", () => {
      const r = run(["--verify", NAME, "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      expect(verifyCall()).toEqual([`${BACKUP_RUN} --verify ${NAME}`]);
    });

    it("a host path inside the default backup folder (<DATA_DIR>/backups, here ./data/backups) maps to the file name — absolute, or relative to the user's folder", () => {
      const dir = path.join(app, "data/backups");
      fs.mkdirSync(dir, { recursive: true });
      const abs = run(["--verify", path.join(dir, NAME), "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(abs.code, abs.stderr).toBe(0);
      const rel = run(["--verify", `./${NAME}`, "--passphrase-file", passFile()], { cwd: dir, env: { BV_STUB_RUNNING: "1" } });
      expect(rel.code, rel.stderr).toBe(0);
      const rel2 = run(["--verify", `backups/../backups/${NAME}`, "--passphrase-file", passFile()], { cwd: path.join(app, "data"), env: { BV_STUB_RUNNING: "1" } });
      expect(rel2.code, rel2.stderr).toBe(0);
      expect(verifyCall()).toEqual(Array(3).fill(`${BACKUP_EXEC} --verify ${NAME}`));
    });

    it.skipIf(isRoot)("still maps when the host user cannot enter the backup folder (0700, owned by the app user on Linux)", () => {
      const dir = path.join(app, "data/backups");
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o000);
      const r = run(["--verify", path.join(dir, NAME), "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(verifyCall()).toEqual([`${BACKUP_EXEC} --verify ${NAME}`]);
    });

    it("follows DATA_DIR and BLACKVAULT_BACKUP_DIR from .env", () => {
      const dataDir = path.join(tmp, "my data");
      fs.mkdirSync(path.join(dataDir, "backups"), { recursive: true });
      fs.writeFileSync(path.join(app, ".env"), `DATA_DIR=${dataDir}\n`);
      const a = run(["--verify", path.join(dataDir, "backups", NAME), "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(a.code, a.stderr).toBe(0);

      const nas = path.join(tmp, "nas");
      fs.mkdirSync(nas);
      fs.writeFileSync(path.join(app, ".env"), `DATA_DIR=${dataDir}\nBLACKVAULT_BACKUP_DIR=${nas}\n`);
      const b = run(["--verify", path.join(nas, NAME), "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(b.code, b.stderr).toBe(0);
      expect(verifyCall()).toEqual(Array(2).fill(`${BACKUP_EXEC} --verify ${NAME}`));

      // With BLACKVAULT_BACKUP_DIR set, <DATA_DIR>/backups is no longer the backup folder.
      const c = run(["--verify", path.join(dataDir, "backups", NAME), "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(c.code).toBe(1);
      expect(verifyCall()).toHaveLength(2);
    });

    it("a path OUTSIDE the backup folder is an error: exit 1, one line naming the folder, the program never started", () => {
      fs.mkdirSync(path.join(app, "data/backups/sub"), { recursive: true });
      const outside = [path.join(tmp, NAME), path.join(app, "data", NAME), path.join(app, "data/backups/sub", NAME), `../${NAME}`, "/etc/passwd"];
      for (const file of outside) {
        const r = run(["--verify", file, "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
        expect(r.code, file).toBe(1);
        expect(lines(r.stderr)).toHaveLength(1);
        expect(r.stderr).toMatch(/^ERROR: --verify: .* is not in the backup folder \(\.\/data\/backups\)/);
      }
      expect(verifyCall()).toEqual([]);
    });

    it("a name that is not a file name (an option, or with a backslash) is refused", () => {
      for (const file of ["--dir", "-x", "a\\b.bvb", `${path.join(app, "data/backups")}/..`]) {
        fs.mkdirSync(path.join(app, "data/backups"), { recursive: true });
        const r = run(["--verify", file, "--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
        expect(r.code, file).toBe(1);
        expect(r.stderr).toMatch(/^ERROR: --verify: /);
      }
      expect(verifyCall()).toEqual([]);
    });
  });

  describe("time limit (BLACKVAULT_BACKUP_TIMEOUT)", () => {
    it("none by default: the docker call is not wrapped in `timeout`", () => {
      const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(read("ps")).not.toMatch(/^timeout \d+ docker compose/m);
    });

    it.skipIf(!hasTimeout)("when set, a run longer than the limit ends with exit 1 and one line saying so", () => {
      const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_SLEEP: "20", BLACKVAULT_BACKUP_TIMEOUT: "1" }, timeout: 15_000 });
      expect(r.signal).toBeNull();
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ERROR: the backup did not finish within 1 seconds \(BLACKVAULT_BACKUP_TIMEOUT\)/);
    });

    it("a value that is not a number is refused before the backup program starts", () => {
      const r = run(["--passphrase-file", passFile()], { env: { BV_STUB_RUNNING: "1", BLACKVAULT_BACKUP_TIMEOUT: "6h" } });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ERROR: BLACKVAULT_BACKUP_TIMEOUT must be a number of seconds\./);
      expect(callLines().filter((c) => c.includes("full-backup.mjs"))).toEqual([]);
    });
  });
});
