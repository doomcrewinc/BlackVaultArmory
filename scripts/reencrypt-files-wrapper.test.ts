/**
 * reencrypt-files.sh (full-backups spec §3, Task 8), run for real under bash
 * with a stub `docker` first on PATH. As in scripts/full-backup-wrapper.test.ts
 * the stub records, per call, its argv, its whole environment and the argv of
 * every process alive at that moment, and — for the re-encryption program's
 * call — the bytes it was given on standard input. That is how "the old key
 * reaches the program on stdin and nowhere else" is checked on the real
 * script. The same limit applies: the `ps` record cannot see a helper that
 * has already exited, so "the key file is only ever redirected, never read
 * by a program the script starts" is pinned by the static checks below.
 *
 * What the program does with the key and the files is in
 * scripts/reencrypt-files-cli.test.ts (the bundle) and
 * src/lib/files/reencrypt.real-fs.test.ts (the engine). Here the stub only
 * proves what the wrapper runs, in which order, and how it maps exit codes.
 * reencrypt-files.bat is covered by scripts/ci/windows/Test-WindowsInstallers.ps1
 * (scenarios RF1–RF8) and by the static checks at the bottom.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";

// A key that appears nowhere else: any trace of it in an argv or an environment is a leak.
const KEY = "5a17c0de".repeat(8);
const KEY_FILE_BYTES = Buffer.from(`﻿${KEY}\r\n`, "utf8"); // a key file as Windows tools write one: handed over byte for byte
const OK_LINE = "BLACKVAULT_REENCRYPT_OK reencrypted=4 already_current=2 unknown_key=1 not_encrypted=1 failed=0";
const NOTHING_LINE = "BLACKVAULT_REENCRYPT_NOTHING reencrypted=0 already_current=6 unknown_key=1 not_encrypted=1 failed=0";
const PROGRAM = "compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs";
const VERSION = "compose version --short";
const PS = "compose ps --status running -q blackvault";
const STOP = "compose stop blackvault";
const START = "compose start blackvault";

let tmp: string;
let app: string;
let bin: string;
let rec: string;

/**
 * The docker stub. `compose version --short` → BV_STUB_COMPOSE_VERSION
 * (default 2.30.1); `compose ps --status running -q blackvault` → a container
 * id when BV_STUB_RUNNING=1; `compose stop|start blackvault` → exit 1 when
 * BV_STUB_FAIL_ON names it; the program's call → records stdin, prints
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
  "compose stop blackvault") [ "\${BV_STUB_FAIL_ON:-}" = stop ] && exit 1 ;;
  "compose start blackvault") [ "\${BV_STUB_FAIL_ON:-}" = start ] && exit 1 ;;
  *"dist/scripts/reencrypt-files.mjs"*)
    cat > "${rec}/stdin"
    [ -n "\${BV_STUB_STDOUT:-}" ] && echo "$BV_STUB_STDOUT"
    [ -n "\${BV_STUB_STDERR:-}" ] && echo "$BV_STUB_STDERR" >&2
    exit "\${BV_STUB_EXIT:-0}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${bin}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: tmp, ...extra } as unknown as NodeJS.ProcessEnv;
}

const read = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name), "utf8") : "");
const readBytes = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name)) : null);
const callLines = () => read("calls").split("\n").filter(Boolean);
const lines = (text: string) => text.split("\n").filter(Boolean);
const lastLine = (text: string) => lines(text).pop() ?? "";

function run(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}) {
  const r = spawnSync("bash", [path.join(app, "reencrypt-files.sh"), ...args], {
    cwd: opts.cwd ?? app,
    env: baseEnv(opts.env),
    encoding: "utf8",
    timeout: 30_000,
    input: "",
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function keyFile(content: string | Buffer = KEY_FILE_BYTES, name = "old.key") {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

/** The old key is in no recorded argv, no recorded environment, and no process's argv at the time of any docker call. */
function expectKeyOnlyOnStdin() {
  for (const needle of [KEY, KEY.slice(0, 16), KEY.toUpperCase()]) {
    expect(read("calls")).not.toContain(needle);
    expect(read("env")).not.toContain(needle);
    expect(read("ps")).not.toContain(needle);
  }
  expect(read("env")).toContain("PATH="); // the environment really was recorded
  if (fs.existsSync(path.join(rec, "ps"))) expect(read("ps")).toContain("docker");
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-reencrypt-sh-"));
  app = path.join(tmp, "app");
  bin = path.join(tmp, "bin");
  rec = path.join(tmp, "rec");
  for (const d of [bin, rec, path.join(app, "scripts")]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["reencrypt-files.sh", "scripts/compose-provider.sh", "scripts/backup-common.sh", "docker-compose.yml"]) fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  fs.writeFileSync(path.join(app, ".env"), "PORT=3000\nBLACKVAULT_DB_PROVIDER=sqlite\n");
  writeStub();
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(isWindows)("reencrypt-files.sh", () => {
  describe("the old key", () => {
    it("--from-key-file: the file's bytes reach the program on stdin UNCHANGED; the key is in no argv, no environment, and is never printed; the file itself is not touched", () => {
      const file = keyFile();
      const past = new Date("2026-01-02T03:04:05.000Z");
      fs.utimesSync(file, past, past);
      const r = run(["--from-key-file", file], { env: { BV_STUB_RUNNING: "1", BV_STUB_STDOUT: OK_LINE } });
      expect(r.code, r.stderr).toBe(0);
      expect(readBytes("stdin")!.equals(KEY_FILE_BYTES)).toBe(true);
      expectKeyOnlyOnStdin();
      expect(r.stdout).toBe(`${OK_LINE}\n`); // exactly the program's line, nothing added
      expect(`${r.stdout}${r.stderr}`).not.toContain(KEY);
      // Never deleted, moved or rewritten.
      expect(fs.readFileSync(file).equals(KEY_FILE_BYTES)).toBe(true);
      expect(fs.statSync(file).mtimeMs).toBe(past.getTime());
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      // Nothing was copied into the install's folder (docker-compose.yml mounts parts of it into the container).
      const inApp = fs.readdirSync(app, { recursive: true }).map(String).sort();
      expect(inApp).toEqual([".env", "docker-compose.yml", "reencrypt-files.sh", "scripts", "scripts/backup-common.sh", "scripts/compose-provider.sh"]);
    });

    it("a relative --from-key-file is relative to where the user ran the script, not to the script's folder", () => {
      const elsewhere = path.join(tmp, "elsewhere");
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, "k.txt"), `${KEY}\n`);
      const r = run(["--from-key-file", "k.txt"], { cwd: elsewhere });
      expect(r.code, r.stderr).toBe(0);
      expect(read("stdin")).toBe(`${KEY}\n`);
    });

    it("a missing, unreadable-as-a-file or empty old key file: exit 3, one line on stderr, docker never called (BlackVault is not stopped)", () => {
      const missing = run(["--from-key-file", path.join(tmp, "nope.key")], { env: { BV_STUB_RUNNING: "1" } });
      expect(missing.code).toBe(3);
      expect(missing.stdout).toBe("");
      expect(lines(missing.stderr)).toHaveLength(1);
      expect(missing.stderr).toMatch(/^ERROR: cannot read the old key file .*nope\.key\.\n$/);
      const folder = run(["--from-key-file", tmp]);
      expect(folder.code).toBe(3);
      expect(folder.stderr).toMatch(/^ERROR: cannot read the old key file /);
      const empty = run(["--from-key-file", keyFile("", "empty.key")]);
      expect(empty.code).toBe(3);
      expect(empty.stderr).toMatch(/^ERROR: the old key file .*empty\.key is empty\.\n$/);
      expect(callLines()).toEqual([]);
    });

    it("no --from-key-file, a missing value, or an unknown argument: exit 1, the argument is NOT echoed (it could be a key), docker never called", () => {
      const none = run([]);
      expect(none.code).toBe(1);
      expect(none.stderr).toBe("ERROR: no old key file was given. Usage: ./reencrypt-files.sh --from-key-file <path>\n");
      const noValue = run(["--from-key-file"]);
      expect(noValue.code).toBe(1);
      expect(noValue.stderr).toMatch(/^ERROR: --from-key-file needs a path\. Usage: /);
      const typed = run(["--from-key", KEY]);
      expect(typed.code).toBe(1);
      expect(typed.stderr).toMatch(/^ERROR: unknown argument\. Usage: /);
      expect(typed.stderr).not.toContain(KEY);
      const bare = run([KEY]);
      expect(bare.code).toBe(1);
      expect(bare.stderr).not.toContain(KEY);
      expect(callLines()).toEqual([]);
    });
  });

  describe("stopping and starting BlackVault", () => {
    it("it was running: ps, stop, the program in a one-off container (no --user, no --no-deps), then start — and it says it was started again", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_STDOUT: OK_LINE } });
      expect(r.code, r.stderr).toBe(0);
      expect(callLines()).toEqual([VERSION, PS, STOP, PROGRAM, START]);
      expect(read("calls")).not.toMatch(/--user|--no-deps|-u 1001|exec/);
      expect(lastLine(r.stderr)).toBe("Done. Keep the old key file until BlackVault has started and your photos and documents open. BlackVault was started again.");
    });

    it("it was NOT running: it is still stopped first (a container that keeps restarting), the program runs, and it is NOT started — said plainly, with the command", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_STDOUT: OK_LINE } });
      expect(r.code, r.stderr).toBe(0);
      expect(callLines()).toEqual([VERSION, PS, STOP, PROGRAM]);
      expect(lastLine(r.stderr)).toBe(
        "Done. Keep the old key file until BlackVault has started and your photos and documents open. BlackVault was not running before, so it was NOT started. Start it with: docker compose up -d",
      );
    });

    it("stop fails: exit 1, the program is never started, nothing is started", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_FAIL_ON: "stop" } });
      expect(r.code).toBe(1);
      expect(callLines()).toEqual([VERSION, PS, STOP]);
      expect(lastLine(r.stderr)).toBe("ERROR: could not stop BlackVault. Nothing was changed; BlackVault was left as it was.");
      expect(fs.existsSync(path.join(rec, "stdin"))).toBe(false);
    });

    it("the restart fails after a good run: the exit code stays the program's (0), with a WARNING that says BlackVault did NOT start and how to start it", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_STDOUT: OK_LINE, BV_STUB_FAIL_ON: "start" } });
      expect(r.code).toBe(0);
      expect(callLines()).toEqual([VERSION, PS, STOP, PROGRAM, START]);
      expect(lastLine(r.stderr)).toMatch(/WARNING: BlackVault did NOT start again: check the logs \(docker compose logs blackvault\) and start it by hand: docker compose up -d$/);
    });

    it("BLACKVAULT_* keys exported in the shell do not reach docker compose; Docker Compose older than 2.20 stops before anything is touched", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BLACKVAULT_DATABASE_URL: "file:./dev.db", BLACKVAULT_UPLOADS_SNAPSHOT: "backups/uploads-x", BLACKVAULT_BACKUP_DIR: "/x" } });
      expect(r.code, r.stderr).toBe(0);
      const programCallEnv = read("env").split("PATH=").pop()!; // the last recorded environment: the program's call
      expect(programCallEnv).not.toMatch(/BLACKVAULT_DATABASE_URL|BLACKVAULT_UPLOADS_SNAPSHOT|BLACKVAULT_BACKUP_DIR/);
      fs.rmSync(path.join(rec, "calls"));
      const old = run(["--from-key-file", keyFile()], { env: { BV_STUB_COMPOSE_VERSION: "2.19.3", BV_STUB_RUNNING: "1" } });
      expect(old.code).toBe(1);
      expect(old.stderr).toMatch(/^ERROR: BlackVault needs Docker Compose v2\.20 or newer/);
      expect(callLines()).toEqual([VERSION]);
    });
  });

  describe("exit codes: the program's 0, 1 and 3 are passed through, and every ending says whether BlackVault was started", () => {
    it("3 (nothing to do — also the second run): exit 3, the program's lines, 'Nothing was changed.', started again because it was running", () => {
      const r = run(["--from-key-file", keyFile()], {
        env: { BV_STUB_RUNNING: "1", BV_STUB_EXIT: "3", BV_STUB_STDOUT: NOTHING_LINE, BV_STUB_STDERR: "reencrypt-files: nothing to do: no uploaded file is encrypted with the old key (key id 02d449a3)." },
      });
      expect(r.code).toBe(3);
      expect(r.stdout).toBe(`${NOTHING_LINE}\n`);
      expect(r.stderr).toContain("reencrypt-files: nothing to do: no uploaded file is encrypted with the old key (key id 02d449a3).\n");
      expect(lastLine(r.stderr)).toBe("Nothing was changed. BlackVault was started again.");
      expect(callLines()).toEqual([VERSION, PS, STOP, PROGRAM, START]);
    });

    it("3 with BlackVault not running before: exit 3 and NOT started", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_EXIT: "3" } });
      expect(r.code).toBe(3);
      expect(lastLine(r.stderr)).toBe("Nothing was changed. BlackVault was not running before, so it was NOT started. Start it with: docker compose up -d");
      expect(callLines()).toEqual([VERSION, PS, STOP, PROGRAM]);
    });

    it("1 (failed): exit 1, says every file is whole and that running it again continues, and whether BlackVault was started", () => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_EXIT: "1", BV_STUB_STDERR: "reencrypt-files: Could not write documents/d.pdf (ENOSPC); it was left as it was." } });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("reencrypt-files: Could not write documents/d.pdf (ENOSPC); it was left as it was.\n");
      expect(lastLine(r.stderr)).toBe(
        "ERROR: the re-encryption failed (the reason is above). Every file is whole, under the old key or the current one; run ./reencrypt-files.sh again to continue. BlackVault was started again.",
      );
      const stopped = run(["--from-key-file", keyFile()], { env: { BV_STUB_EXIT: "1" } });
      expect(stopped.code).toBe(1);
      expect(lastLine(stopped.stderr)).toMatch(/BlackVault was not running before, so it was NOT started\. Start it with: docker compose up -d$/);
    });

    it.each(["2", "125", "137"])("any other exit code (%s) → 1, with one ERROR line that names it", (code) => {
      const r = run(["--from-key-file", keyFile()], { env: { BV_STUB_RUNNING: "1", BV_STUB_EXIT: code } });
      expect(r.code).toBe(1);
      expect(lastLine(r.stderr)).toMatch(new RegExp(`^ERROR: the re-encryption command ended unexpectedly \\(exit ${code}\\); see the output above\\. .* BlackVault was started again\\.$`));
    });
  });
});

/**
 * The stub's `ps` record cannot see a helper that has already exited, so
 * "the old key file is only ever REDIRECTED to the program, never read by
 * anything this script starts" is pinned here: every line that names
 * PASSFILE (the variable holding the file's PATH) must be one of a short
 * list of shapes. scripts/full-backup-wrapper.test.ts pins the typed
 * passphrase's variables for the same three shared lines of code.
 */
describe("reencrypt-files.sh and scripts/backup-common.sh (static checks: the old key file is only ever tested and redirected)", () => {
  const codeOf = (file: string) =>
    fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const own = codeOf("reencrypt-files.sh");
  const shared = codeOf("scripts/backup-common.sh");
  const REDIRECT = '"${CMD[@]}" < "$PASSFILE"';
  const REDIRECT_WAITED = '"${CMD[@]}" < "$PASSFILE" &';

  it("reencrypt-files.sh: PASSFILE is cleared, assigned from the argument, and tested with `[` — nothing else", () => {
    const uses = own.filter((l) => /\bPASSFILE\b/.test(l));
    expect(uses).toEqual(['PASSFILE=""', "PASSFILE=$2", '[ -n "$PASSFILE" ] || die "no old key file was given. $USAGE"']);
    // The script itself never redirects, pipes into, or substitutes from anything: the one hand-over is the shared function.
    expect(own.filter((l) => /(^|[^<])<[^<]|\$\(<|<\(/.test(l.replace(/<path>|<n>|<OK\|NOTHING\|FAILED>/g, "")))).toEqual([]);
    // No program that could read, copy or remove a file is ever started (a word on its own; `--rm` is docker's flag).
    expect(own.filter((l) => /(^|\s)(cat|head|tail|tr|sed|awk|xxd|od|base64|cp|mv|rm|tee|dd)(\s|$)/.test(l))).toEqual([]);
    expect(own).toContain('bv_check_secret_file "old key file" 3');
    expect(own).toContain("bv_run_with_passphrase");
    expect(own.filter((l) => l.includes("bv_run_with_passphrase"))).toEqual(["bv_run_with_passphrase"]);
  });

  it("scripts/backup-common.sh: every line naming PASSFILE is a `[` test, the path made absolute, a message, or the redirect to the program", () => {
    const ALLOWED = [
      /^case "\$PASSFILE" in \/\*\) ;; \*\) PASSFILE="\$ORIG_PWD\/\$PASSFILE" ;; esac$/,
      /^if \[ ! -f "\$PASSFILE" \] \|\| \[ ! -r "\$PASSFILE" \]; then$/,
      /^if \[ ! -s "\$PASSFILE" \]; then$/,
      /^(el)?if \[ -n "\$PASSFILE" \]; then$/,
      /^printf 'ERROR: %s\\n' "(cannot read the \$1 \$PASSFILE\.|the \$1 \$PASSFILE is empty\.)" >&2$/, // the PATH, never the content
      /^"\$\{CMD\[@\]\}" < "\$PASSFILE"( &)?$/,
    ];
    const uses = shared.filter((l) => /\bPASSFILE\b/.test(l));
    expect(uses.filter((l) => !ALLOWED.some((re) => re.test(l)))).toEqual([]);
    expect(uses.filter((l) => l === REDIRECT || l === REDIRECT_WAITED)).toEqual([REDIRECT, REDIRECT_WAITED]);
    expect(uses.length).toBe(10);
  });

  it("nothing is exported, no allexport, no xtrace; bash; it does not assign the names docker compose interpolates", () => {
    expect(own.filter((l) => /\b(export|typeset|declare)\b/.test(l))).toEqual([]);
    expect(own.filter((l) => /\bset\s+[-+][a-zA-Z]*[ax]/.test(l) || /\bset\s+-o\s+(allexport|xtrace)/.test(l))).toEqual([]);
    expect(fs.readFileSync(path.join(ROOT, "reencrypt-files.sh"), "utf8").split("\n")[0]).toBe("#!/bin/bash");
    expect(own.filter((l) => /^(local )?(DATA_DIR|PORT|COMPOSE_PROFILES|COMPOSE_FILE|COMPOSE_PROJECT_NAME)=/.test(l))).toEqual([]);
    expect(fs.statSync(path.join(ROOT, "reencrypt-files.sh")).mode & 0o111).not.toBe(0);
  });

  it("the shared code is shared, not copied; the program runs as backup.sh's one-off container; stop and start are rotate-key.sh's", () => {
    for (const definition of shared.filter((l) => /^[a-z_]+\(\) \{$/.test(l))) expect(own, `reencrypt-files.sh redefines ${definition}`).not.toContain(definition);
    expect(own).toContain(". ./scripts/backup-common.sh");
    expect(own).toContain("CMD=($COMPOSE run --rm -T blackvault node dist/scripts/reencrypt-files.mjs)");
    expect(own.join("\n")).not.toMatch(/--user|--no-deps/);
    const rotate = fs.readFileSync(path.join(ROOT, "rotate-key.sh"), "utf8");
    expect(rotate).toContain("$COMPOSE stop blackvault");
    expect(rotate).toContain("$COMPOSE start blackvault");
    expect(own).toContain("if ! $COMPOSE stop blackvault >&2; then");
    expect(own).toContain("elif $COMPOSE start blackvault >&2; then");
    // It never deletes anything: no rm, and the only file it names is the one it redirects.
    expect(own.filter((l) => /(^|\s)(rm|unlink|mv)(\s|$)/.test(l))).toEqual([]);
  });
});

/**
 * reencrypt-files.bat cannot be RUN here (no cmd.exe); the Windows CI job
 * runs it (scripts/ci/windows/Test-WindowsInstallers.ps1, scenarios RF1–RF8).
 * These are the properties that can be read off the file on any platform.
 * Batch cannot include another file, so what it shares with backup.bat is a
 * COPY, and it must be the same copy.
 */
describe("reencrypt-files.bat (static checks; executed only by the Windows CI job)", () => {
  const raw = fs.readFileSync(path.join(ROOT, "reencrypt-files.bat"));
  const text = raw.toString("utf8");
  const code = text.split("\r\n").filter((l) => !l.startsWith("::"));
  const backupCode = fs.readFileSync(path.join(ROOT, "backup.bat"), "utf8").split("\r\n").filter((l) => !l.startsWith("::"));
  const powershellStep = (ls: string[]) => ls.filter((l) => l.startsWith('powershell -NoProfile -Command "'));
  const subroutine = (file: string) => {
    const t = fs.readFileSync(path.join(ROOT, file), "utf8").replace(/\r\n/g, "\n");
    const start = t.indexOf("\n:require_compose\n");
    return t.slice(start, t.indexOf("\ngoto :eof\n", t.indexOf("if !_CMAJ! EQU 2", start)));
  };

  it("is pure ASCII with CRLF line endings throughout (.gitattributes: *.bat eol=crlf)", () => {
    expect(raw.every((b) => b < 0x80)).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("hands the old key file over through backup.bat's PowerShell step, character for character, making exactly one call", () => {
    expect(powershellStep(code)).toHaveLength(1);
    expect(powershellStep(backupCode)).toHaveLength(1);
    expect(powershellStep(code)[0]).toBe(powershellStep(backupCode)[0]);
    const at = code.indexOf(powershellStep(code)[0]);
    expect(code.slice(at - 3, at)).toEqual(['set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs"', 'set "BV_DOCKER_ARGS_2="', 'set "BV_BETWEEN="']);
    expect(code[at + 1]).toBe('set "BV_RC=!errorlevel!"');
    expect(code).toContain('set "BV_LIMIT="'); // backup.bat's time limit never applies here
    expect(code.filter((l) => /^set "BV_DOCKER_ARGS=/.test(l))).toHaveLength(1);
    expect(code.join("\n")).not.toMatch(/--no-deps|--user|compose exec/);
  });

  it("never reads the old key into a cmd variable: no `set /p`, no `type`, no `for /f` over the file; BV_PASSFILE is its PATH and is only tested", () => {
    expect(code.filter((l) => /set\s+\/p/i.test(l))).toEqual([]);
    expect(code.filter((l) => /^\s*(type|copy|move|del|erase|ren|more|findstr|certutil)\b/i.test(l))).toEqual([]);
    const uses = code.filter((l) => l.includes("BV_PASSFILE") && !l.trimStart().startsWith(">&2 echo") && !l.startsWith("powershell "));
    for (const l of uses) expect(l).toMatch(/^(set "BV_PASSFILE=(%~f2)?"|if (not )?(defined BV_PASSFILE|exist "!BV_PASSFILE!\\?") goto :\w+|for %%F in \("!BV_PASSFILE!"\) do if %%~zF EQU 0 goto :keyfile_empty)$/);
    expect(uses.length).toBe(6);
    // A missing or empty key file is exit 3, before docker is touched.
    const at = code.indexOf(":keyfile_unreadable");
    expect(code.slice(at, at + 6)).toEqual([
      ":keyfile_unreadable",
      ">&2 echo ERROR: cannot read the old key file !BV_PASSFILE!.",
      "exit /b 3",
      ":keyfile_empty",
      ">&2 echo ERROR: the old key file !BV_PASSFILE! is empty.",
      "exit /b 3",
    ]);
    expect(at).toBeLessThan(code.indexOf("call :require_compose"));
  });

  it("parses its arguments with `shift /1` before `cd /d \"%~dp0\"`, never pauses, and its :require_compose is rotate-key.bat's, line for line", () => {
    expect(code.filter((l) => /^\s*shift\b/i.test(l))).toEqual(Array(2).fill("shift /1"));
    expect(code.indexOf('cd /d "%~dp0"')).toBeGreaterThan(code.lastIndexOf("shift /1"));
    expect(code.filter((l) => /^\s*pause\b/i.test(l))).toEqual([]);
    expect(subroutine("reencrypt-files.bat").length).toBeGreaterThan(300);
    expect(subroutine("reencrypt-files.bat")).toBe(subroutine("rotate-key.bat"));
  });

  it("the steps are reencrypt-files.sh's, in order: ps, stop, the program, start only if it was running; exit codes 0, 3 and 1 map the same way", () => {
    const order = [
      "for /f \"usebackq delims=\" %%I in (`%COMPOSE% ps --status running -q blackvault 2^>nul`) do set \"BV_RUNNING=1\"",
      "%COMPOSE% stop blackvault 1>&2",
      'set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/reencrypt-files.mjs"',
      'set "BV_RC=!errorlevel!"',
      "if not defined BV_RUNNING goto :start_done",
      "%COMPOSE% start blackvault 1>&2",
      ":start_done",
      'if "!BV_RC!"=="0" goto :ended_ok',
      'if "!BV_RC!"=="3" goto :ended_nothing',
      'if "!BV_RC!"=="1" goto :ended_failed',
    ].map((l) => code.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code.filter((l) => l === "%COMPOSE% start blackvault 1>&2")).toHaveLength(1);
    const exits = (label: string) => {
      const at = code.indexOf(label);
      return code.slice(at, at + 3);
    };
    expect(exits(":ended_ok")[2]).toBe("exit /b 0");
    expect(exits(":ended_nothing")[2]).toBe("exit /b 3");
    expect(exits(":ended_failed")[2]).toBe("exit /b 1");
    // Every ending prints the sentence that says whether BlackVault was started.
    for (const label of [":ended_ok", ":ended_nothing", ":ended_failed"]) expect(exits(label)[1]).toContain("!BV_STARTED!");
    expect(code.filter((l) => l.includes("!BV_STARTED!"))).toHaveLength(4);
    // The wording is the .sh's.
    const sh = fs.readFileSync(path.join(ROOT, "reencrypt-files.sh"), "utf8");
    for (const sentence of [
      "BlackVault was started again.",
      "BlackVault was not running before, so it was NOT started. Start it with: ",
      "Done. Keep the old key file until BlackVault has started and your photos and documents open.",
      "Every file is whole, under the old key or the current one; run ",
    ]) {
      expect(sh).toContain(sentence);
      expect(text).toContain(sentence);
    }
    // No exclamation mark, ampersand, pipe or angle bracket inside a message (cmd would interpret it).
    for (const l of code.filter((x) => x.startsWith(">&2 echo ") || x.startsWith('set "BV_STARTED='))) {
      expect(l.replace(/^>&2 echo /, "").replace(/![A-Z_]+!/g, ""), l).not.toMatch(/[!&|<>^]/);
    }
  });

  it("the Windows harness runs it (RF1–RF8), printing the evidence whenever a check fails, and the docker stub knows the program", () => {
    const harness = fs.readFileSync(path.join(ROOT, "scripts/ci/windows/Test-WindowsInstallers.ps1"), "utf8");
    for (let i = 1; i <= 8; i++) expect(harness).toContain(`scenario RF${i}\r\n`);
    const section = harness.slice(harness.indexOf("# reencrypt-files.bat (Task 8)"), harness.indexOf("# --------------------------------------------------------------------- report"));
    const runs = section.match(/^\s*\$r = Invoke-Reencrypt /gm) ?? [];
    const evidence = section.match(/^\s*Show-EvidenceIfFailed \$r/gm) ?? [];
    expect(runs.length).toBeGreaterThanOrEqual(12);
    expect(evidence.length).toBe(runs.length);
    const stub = fs.readFileSync(path.join(ROOT, "scripts/ci/windows/docker-stub.cs"), "utf8");
    expect(stub).toContain('"dist/scripts/reencrypt-files.mjs"');
    expect(stub).toContain('"BV_STUB_REENCRYPT_"');
  });
});
