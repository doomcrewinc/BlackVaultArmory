/**
 * restore.sh (full-backups spec §3, Task 7), run for real under bash with a
 * stub `docker` first on PATH, against a scratch install on a real
 * filesystem: a real SQLite-file stand-in, a real uploads tree.
 *
 * What is REAL here: restore.sh, scripts/backup-common.sh,
 * scripts/db-snapshot.sh, scripts/uploads-snapshot.sh and
 * scripts/snapshot-restore.sh. The stub emulates the one-off containers the
 * same way scripts/installers-encryption.test.ts does: it runs the two
 * in-container scripts on the host, mapping /bv-backups, /app/data and
 * /app/uploads to the scratch install. So the snapshot is really taken and
 * the rollback really copies it back.
 * What is EMULATED: the restore program. With BV_STUB_RESTORE=crash the stub
 * leaves the install the way a restore killed mid-way would (database
 * overwritten, a hot journal, images swapped, staging left behind) and
 * exits non-zero. The real program's behaviour at each failure point is in
 * src/lib/backup/full-restore.real-db.test.ts and
 * scripts/full-restore-cli.test.ts.
 *
 * restore.bat is covered by scripts/ci/windows/Test-WindowsInstallers.ps1
 * (scenarios RS1–RS19) and by the static checks at the end of this file.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These two limits only guard against a real hang. They are far above anything a test asserts (the
// "at once" bounds below are explicit `toBeLessThan` checks on measured times, and the stub's longest
// sleep is 120 s), because on a stalled machine a 60 s limit on each script run was itself what failed.
const SPAWN_LIMIT_MS = 900_000;
const TEST_LIMIT_MS = 1_200_000;
vi.setConfig({ testTimeout: TEST_LIMIT_MS });

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const has = (cmd: string) => !isWindows && spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const hasPython = has("python3");

const PASS = " restore tëst 'pass' \"phrase\" $HOME `id` \\n * ";
const NAME = "blackvault-full-20261002-180405.bvb";
const OK_LINE = `BLACKVAULT_FULL_RESTORE_OK file=${NAME} files=2 bytes=10 pre_restore=.pre-restore-20261003-000000`;
const VERIFY = `compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify ${NAME}`;
const PS = "compose ps --status running -q blackvault";
const LOCK_STATUS = "compose exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs --lock-status";
const RESTORE = /^compose run --rm -T --name blackvault-restore-(\d{8}-\d{6}) blackvault node dist\/scripts\/full-restore\.mjs --stamp \1 blackvault-full-20261002-180405\.bvb$/;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let tmp: string;
let app: string;
let bin: string;
let rec: string;

function writeStub() {
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "${rec}/calls"
env >> "${rec}/env"
ps -Ao args >> "${rec}/ps" 2>/dev/null
if [ -n "\${BV_STUB_FAIL_ON:-}" ]; then
  case " $* " in *" $BV_STUB_FAIL_ON "*) [ "\${BV_STUB_FAIL_ON}" = "--single-transaction" ] && cat > /dev/null; echo "[stub] failing on purpose: $*" >&2; exit 1 ;; esac
fi
dd=$(sed -n 's/^DATA_DIR=//p' .env | tail -n 1); dd=\${dd:-./data}
# Container paths → the scratch install.
map() { case "$1" in /bv-backups/*) echo "backups/\${1#/bv-backups/}" ;; /app/data/*) echo "$dd/db/\${1#/app/data/}" ;; /app/uploads) echo "$dd/uploads" ;; *) echo "$1" ;; esac; }
case "$*" in
  "compose version --short") echo "\${BV_STUB_COMPOSE_VERSION-2.30.1}" ;;
  "compose config --images blackvault") echo "blackvault-blackvault" ;;
  # BV_STUB_APP_RUNNING=1: the app container is up.
  "${PS}") [ "\${BV_STUB_APP_RUNNING:-}" = 1 ] && echo "0123456789ab"; exit 0 ;;
  # The lock question, asked in the running app container. BV_STUB_LOCK: free (default), held, old-image (the CLI
  # does not know the option yet), killed (the exec itself died).
  "${LOCK_STATUS}")
    cat > "${rec}/stdin-lock-status"
    case "\${BV_STUB_LOCK:-free}" in
      free) echo "BLACKVAULT_FULL_BACKUP_LOCK state=free"; exit 0 ;;
      held) echo "BLACKVAULT_FULL_BACKUP_LOCK state=held pid=57 hostname=0123456789ab started=2026-10-03T03:15:00.000Z"; exit 2 ;;
      old-image) echo "full-backup: unknown argument. Usage: full-backup [--dir <folder>] [--keep <n>] | [--dir <folder>] --verify <file>; the passphrase is read from standard input." >&2; exit 1 ;;
      killed) exit 137 ;;
    esac ;;
  *"/bv-uploads-snapshot.sh /app/uploads /bv-backups "*)
    for a in "$@"; do name=$a; done
    sh scripts/uploads-snapshot.sh "$dd/uploads" backups "$name"; rc=$?
    [ -n "\${BV_STUB_SNAPSHOT_SLEEP:-}" ] && { : > "${rec}/snapshotting"; sleep "$BV_STUB_SNAPSHOT_SLEEP"; }
    # After the snapshot: the host user can no longer create a file in backups/.
    [ "\${BV_STUB_LOCK_BACKUPS:-}" = 1 ] && chmod 500 backups
    exit $rc ;;
  *"/bv-snapshot-restore.sh "*)
    case " $* " in *" \${BV_STUB_ROLLBACK_FAIL:-none} "*) echo "ERROR: could not restore from the snapshot: [stub] refused" >&2; exit 1 ;; esac
    args=(); seen=0
    for a in "$@"; do
      if [ "$seen" = 1 ]; then args+=("$(map "$a")"); fi
      chmod 755 "$dd/uploads" 2>/dev/null
      [ "$a" = "/bv-snapshot-restore.sh" ] && seen=1
    done
    # "root in the container" can enter a folder the host user cannot (BV_STUB_HIDE_PRE); the host still cannot afterwards.
    [ "\${BV_STUB_HIDE_PRE:-}" = 1 ] && chmod 700 "$dd"/uploads/.pre-restore-* 2>/dev/null
    sh scripts/snapshot-restore.sh "\${args[@]}"; rc=$?
    [ "\${BV_STUB_HIDE_PRE:-}" = 1 ] && chmod 000 "$dd"/uploads/.pre-restore-* 2>/dev/null
    exit $rc ;;
  *"dist/scripts/full-backup.mjs --verify"*)
    cat > "${rec}/stdin-verify"
    [ "\${BV_STUB_VERIFY_EXIT:-0}" = 0 ] && echo "BLACKVAULT_FULL_BACKUP_VERIFIED file=${NAME} files=2 bytes=10 archive_bytes=99"
    [ "\${BV_STUB_VERIFY_EXIT:-0}" != 0 ] && echo "full-backup: Wrong passphrase, or the backup is damaged." >&2
    exit "\${BV_STUB_VERIFY_EXIT:-0}" ;;
  *"dist/scripts/full-restore.mjs"*)
    cat > "${rec}/stdin-restore"
    # Once the "container" has ended, the host user can no longer look into the uploads folder.
    [ "\${BV_STUB_HIDE_UPLOADS:-}" = 1 ] && trap 'chmod 000 "$dd/uploads"' EXIT
    stamp=""; prev=""; for a in "$@"; do [ "$prev" = "--stamp" ] && stamp=$a; prev=$a; done
    # BV_STUB_HIDE_PRE=1: as on native Linux, the program's .pre-restore-<time> (mode 0700, uid 1001) cannot be entered by the host user.
    [ "\${BV_STUB_HIDE_PRE:-}" = 1 ] && trap 'chmod 000 "$dd/uploads/.pre-restore-$stamp" 2>/dev/null' EXIT
    # What is on disk WHILE the restore runs: the recovery file (ruling R25).
    cat backups/restore-*-RECOVERY.txt > "${rec}/recovery-during" 2>/dev/null
    marker() { mkdir -p "$dd/uploads/.restore-$stamp.db-started" && : > "$dd/uploads/.restore-$stamp.db-started/started"; }
    swap_images() {
      mkdir -p "$dd/uploads/.pre-restore-$stamp"
      mv "$dd/uploads/images" "$dd/uploads/.pre-restore-$stamp/images"
      mkdir -p "$dd/uploads/images"
      printf 'restored' > "$dd/uploads/images/from-backup.jpg"
    }
    # BV_STUB_THEN_HANG=1: leave the state, then keep "running" (the test kills the wrapper, as a closed window would).
    finish() { if [ "\${BV_STUB_THEN_HANG:-}" = 1 ]; then echo $$ > "${rec}/restore.pid.tmp"; mv "${rec}/restore.pid.tmp" "${rec}/restore.pid"; exec sleep 120; fi; exit "$1"; }
    case "\${BV_STUB_RESTORE:-ok}" in
      ok) echo "${OK_LINE}"; exit 0 ;;
      # Refused while staging: the database step was never reached, so NO marker.
      refuse)
        mkdir -p "$dd/uploads/.restore-$stamp/images"; printf 'staged' > "$dd/uploads/.restore-$stamp/images/x.jpg"
        echo "full-restore: [stub] refused. Nothing was changed." >&2; finish 1 ;;
      # The database step started (marker), the transaction rolled back: nothing actually changed.
      dbfail) marker; echo "full-restore: [stub] the database step failed." >&2; exit 1 ;;
      crash)
        # What a restore killed mid-way leaves behind.
        marker
        [ -f "$dd/db/vault.db" ] && printf 'REPLACED BY THE FAILED RESTORE' > "$dd/db/vault.db"
        [ -f "$dd/db/vault.db" ] && printf 'hot journal' > "$dd/db/vault.db-journal"
        mkdir -p "$dd/uploads/.restore-$stamp/documents"
        printf 'staged' > "$dd/uploads/.restore-$stamp/documents/from-backup.pdf"
        swap_images
        printf 'damaged' > "$dd/uploads/documents/doc1.pdf"
        echo "full-restore: [stub] killed." >&2; finish 137 ;;
      # Everything in place and the marker removed, but the exit status is lost (the container died on the way out).
      complete)
        [ -f "$dd/db/vault.db" ] && printf 'THE RESTORED RECORDS' > "$dd/db/vault.db"
        swap_images
        mv "$dd/uploads/documents" "$dd/uploads/.pre-restore-$stamp/documents"; mkdir -p "$dd/uploads/documents"
        echo "${OK_LINE}"; finish 137 ;;
      # The pid file appears complete or not at all (written beside, then renamed).
      hang) echo $$ > "${rec}/restore.pid.tmp"; mv "${rec}/restore.pid.tmp" "${rec}/restore.pid"; exec sleep 120 ;;
    esac ;;
  # BV_STUB_NO_CONTAINER=1: the container was never created, so "docker stop" finds nothing to stop.
  "stop blackvault-restore-"*) [ "\${BV_STUB_NO_CONTAINER:-}" != 1 ] && [ -f "${rec}/restore.pid" ] && kill "$(cat "${rec}/restore.pid")" 2>/dev/null; exit 0 ;;
  "ps -aq --filter name=^blackvault-restore-"*) [ "\${BV_STUB_CONTAINER_STUCK:-}" = 1 ] && echo "0123456789ab"; exit 0 ;;
  "compose stop blackvault") [ -n "\${BV_STUB_STOP_SLEEP:-}" ] && { : > "${rec}/stopping"; sleep "$BV_STUB_STOP_SLEEP"; } ;;
  "compose exec -T db pg_dump"*) echo "-- stub pg_dump of blackvault" ;;
  "compose exec -T db psql"*) cat >> "${rec}/psql-stdin" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
}

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
  devNull?: boolean;
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: `${bin}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: tmp, ...extra } as unknown as NodeJS.ProcessEnv;
}

const read = (name: string) => (fs.existsSync(path.join(rec, name)) ? fs.readFileSync(path.join(rec, name), "utf8") : "");
const calls = () => read("calls").split("\n").filter(Boolean);
const lines = (text: string) => text.split("\n").filter(Boolean);
/**
 * The recovery text's commands EXACTLY AS PRINTED: every line indented by two spaces that starts a
 * command, with the lines of an && chain (each ends in " &&") kept together as the one command they are.
 */
function printedCommands(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const l of lines(text)) {
    if (!/^ {2}(docker |rm |\[ "\$\(docker )/.test(l)) {
      if (open) throw new Error(`an && chain is cut off by: ${l}`);
      continue;
    }
    if (/^ {2}docker (stop|ps) |^ {2}docker compose (stop blackvault|up -d)$/.test(l)) continue; // steps 1 and 4
    if (open) out[out.length - 1] += `\n${l.trim()}`;
    else out.push(l.trim());
    open = l.endsWith(" &&");
  }
  if (open) throw new Error("the last && chain never ends");
  return out;
}
/** "rm", or the snapshot-restore.sh modes a printed command runs, joined as its chain is. */
const modesOf = (command: string) =>
  command.startsWith("rm ")
    ? "rm"
    : command
        .split(" &&\n")
        .map((c) => c.split("/bv-snapshot-restore.sh ")[1].split(" ")[0])
        .join(" && ");
/** Calls without the Compose version probe (restore.sh and db-snapshot.sh each make one). */
const steps = () => calls().filter((c) => c !== "compose version --short");

function run(args: string[], opts: RunOpts = {}) {
  const r = spawnSync("bash", [path.join(app, "restore.sh"), ...args], {
    cwd: opts.cwd ?? app,
    env: baseEnv(opts.env),
    encoding: "utf8",
    timeout: SPAWN_LIMIT_MS,
    ...(opts.devNull ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input: "" }),
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function runOnTty(args: string[], answers: string[], env: Record<string, string> = {}) {
  const helper = path.join(tmp, "pty-helper.py");
  fs.writeFileSync(helper, PTY_HELPER);
  const answersFile = path.join(tmp, "answers");
  fs.writeFileSync(answersFile, answers.join("\n"));
  const r = spawnSync("python3", [helper, answersFile, "bash", path.join(app, "restore.sh"), ...args], { cwd: app, env: baseEnv(env), encoding: "utf8", timeout: SPAWN_LIMIT_MS });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function passFile(content: string | Buffer = `${PASS}\n`) {
  const p = path.join(tmp, "pass.txt");
  fs.writeFileSync(p, content, { mode: 0o600 });
  return p;
}

/** Every file under the install's data folder (database, uploads — hidden entries too): path → sha256, folders as "dir". */
function install(): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string, rel: string) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const child = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (fs.lstatSync(child).isDirectory()) {
        out[childRel] = "dir";
        visit(child, childRel);
      } else out[childRel] = sha(fs.readFileSync(child));
    }
  };
  visit(path.join(app, "data"), "");
  return out;
}

function expectPassphraseOnlyOnStdin() {
  for (const needle of [PASS, PASS.trim(), "restore tëst", "phrase\\\""]) {
    expect(read("calls")).not.toContain(needle);
    expect(read("env")).not.toContain(needle);
    expect(read("ps")).not.toContain(needle);
  }
  expect(read("env")).toContain("PATH=");
}

function seedInstall(provider: "sqlite" | "postgres" = "sqlite") {
  fs.mkdirSync(path.join(app, "data/db"), { recursive: true });
  fs.mkdirSync(path.join(app, "data/uploads/images/firearms"), { recursive: true });
  fs.mkdirSync(path.join(app, "data/uploads/documents"), { recursive: true });
  fs.mkdirSync(path.join(app, "data/backups"), { recursive: true });
  if (provider === "sqlite") fs.writeFileSync(path.join(app, "data/db/vault.db"), "the database as it was before the restore", { mode: 0o644 });
  fs.writeFileSync(path.join(app, "data/uploads/images/firearms/photo1.jpg"), "BVF1 photo one", { mode: 0o600 });
  fs.writeFileSync(path.join(app, "data/uploads/images/half.jpg.1a2b3c4d.tmp"), "a work file no snapshot holds", { mode: 0o600 });
  fs.writeFileSync(path.join(app, "data/uploads/documents/doc1.pdf"), "BVF1 document one", { mode: 0o600 });
  fs.writeFileSync(
    path.join(app, ".env"),
    provider === "sqlite"
      ? "PORT=3000\nBLACKVAULT_DB_PROVIDER=sqlite\n"
      : "COMPOSE_PROFILES=postgres\nBLACKVAULT_DB_PROVIDER=postgres\nBLACKVAULT_POSTGRES_PASSWORD=x\nBLACKVAULT_DATABASE_URL=postgresql://blackvault:x@db:5432/blackvault\n",
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-restore-sh-"));
  app = fs.realpathSync(fs.mkdirSync(path.join(tmp, "app"), { recursive: true })!);
  bin = path.join(tmp, "bin");
  rec = path.join(tmp, "rec");
  for (const d of [bin, rec, path.join(app, "scripts")]) fs.mkdirSync(d, { recursive: true });
  for (const f of ["restore.sh", "scripts/compose-provider.sh", "scripts/backup-common.sh", "scripts/db-snapshot.sh", "scripts/uploads-snapshot.sh", "scripts/snapshot-restore.sh", "docker-compose.yml"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(app, f));
  }
  fs.chmodSync(path.join(app, "scripts/db-snapshot.sh"), 0o755);
  seedInstall();
  writeStub();
  // `date`, so that a test can fix the restore's time stamp (BV_STUB_DATE); everything else goes to the real one.
  fs.writeFileSync(
    path.join(bin, "date"),
    `#!/bin/bash\nif [ -n "\${BV_STUB_DATE:-}" ] && [ "$*" = "-u +%Y%m%d-%H%M%S" ]; then echo "$BV_STUB_DATE"; else PATH=/bin:/usr/bin exec date "$@"; fi\n`,
    { mode: 0o755 },
  );
  // `sync`, recorded instead of run: what was on disk when it was called, and whether the restore program had been started.
  fs.writeFileSync(
    path.join(bin, "sync"),
    `#!/bin/bash\n{ echo "sync $*"; ls backups/restore-*-RECOVERY.txt 2>/dev/null; echo "restore-started=$(grep -c full-restore.mjs "${rec}/calls")"; } >> "${rec}/sync"\n[ "\${BV_STUB_SYNC_FAIL:-}" = 1 ] && exit 1\nexit 0\n`,
    { mode: 0o755 },
  );
  // `uname`, so that a test can choose the system db-snapshot.sh believes it runs on (BV_STUB_UNAME).
  fs.writeFileSync(path.join(bin, "uname"), `#!/bin/bash\nif [ -n "\${BV_STUB_UNAME:-}" ] && [ "$*" = "-s" ]; then echo "$BV_STUB_UNAME"; else PATH=/bin:/usr/bin exec uname "$@"; fi\n`, { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(isWindows)("restore.sh", () => {
  const ROLLBACK = () => `compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${app}/backups:/bv-backups:ro -v ${app}/scripts/snapshot-restore.sh:/bv-snapshot-restore.sh:ro blackvault /bv-snapshot-restore.sh`;
  const PSQL = "compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault";
  const backupsDir = () => (fs.existsSync(path.join(app, "backups")) ? fs.readdirSync(path.join(app, "backups")).sort() : []);
  const dbSnapName = () => backupsDir().find((n) => /^blackvault-\d{8}-\d{6}\.(db|sql)$/.test(n))!;
  const upSnapName = () => backupsDir().find((n) => n.startsWith("uploads-"))!;
  const recoveryFiles = () => backupsDir().filter((n) => n.endsWith("-RECOVERY.txt"));
  const stampOf = () => RESTORE.exec(steps().find((c) => RESTORE.test(c))!)![1];
  /** The calls after the restore program's. */
  const afterRestore = () => steps().slice(steps().findIndex((c) => RESTORE.test(c)) + 1);
  const pgInstall = () => {
    fs.rmSync(path.join(app, "data"), { recursive: true });
    seedInstall("postgres");
  };

  /** Starts restore.sh, waits for `marker` to appear in the record folder, sends `signal` to the wrapper ONLY, and resolves with how it ended. */
  async function runAndSignal(marker: string, signal: NodeJS.Signals, env: Record<string, string>) {
    const child = spawn("bash", [path.join(app, "restore.sh"), NAME, "--yes", "--passphrase-file", passFile()], { cwd: app, env: baseEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const started = Date.now();
    while (!fs.existsSync(path.join(rec, marker)) && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 25));
    expect(fs.existsSync(path.join(rec, marker)), `exit=${child.exitCode} signal=${child.signalCode} calls=${JSON.stringify(calls())} stderr=${JSON.stringify(stderr)}`).toBe(true);
    const sentAt = Date.now();
    child.kill(signal);
    const code = await new Promise<number | null>((resolve) => child.on("exit", (c) => resolve(c)));
    return { code, stderr, ms: Date.now() - sentAt };
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitUntilDead = async (pid: number) => {
    const started = Date.now();
    while (alive(pid) && Date.now() - started < 60_000) await new Promise((r) => setTimeout(r, 25));
    return !alive(pid);
  };

  describe("the command sequence", () => {
    it("success (SQLite): verify → stop → snapshot → restore → start, in exactly that order; stdout is the restore program's one line", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe(`${OK_LINE}\n`);
      const s = steps();
      const stamp = stampOf();
      const snap = s[6].split(" ").at(-1)!;
      expect(s).toEqual([
        VERIFY,
        PS, // is the app running? (it is not: nobody to ask about the lock)
        "compose stop blackvault",
        // scripts/db-snapshot.sh (SQLite stops the app itself too, then copies the file; then the uploads, in a container)
        "compose stop blackvault",
        "compose config --images blackvault",
        "image inspect blackvault-blackvault",
        `compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${app}/backups:/bv-backups -v ${app}/scripts/uploads-snapshot.sh:/bv-uploads-snapshot.sh:ro blackvault /bv-uploads-snapshot.sh /app/uploads /bv-backups ${snap}`,
        // The one-off restore container has a NAME (so an interrupted wrapper can stop it), and still no --user / --no-deps.
        `compose run --rm -T --name blackvault-restore-${stamp} blackvault node dist/scripts/full-restore.mjs --stamp ${stamp} ${NAME}`,
        "compose up -d",
      ]);
      expect(s[0]).not.toMatch(/--user|--no-deps/);
      expect(s[7]).not.toMatch(/--user|--no-deps/);
      // The snapshot exists, the marker file of db-snapshot.sh is gone, the recovery file was removed, and the output names both snapshots.
      expect(backupsDir()).toEqual([expect.stringMatching(/^blackvault-\d{8}-\d{6}\.db$/), snap]);
      expect(r.stderr).toContain(`.pre-restore-${stamp}/`);
      expect(r.stderr).toContain(`backups/${dbSnapName()} and backups/${snap}`);
    });

    it("the passphrase file's bytes reach BOTH programs on stdin unchanged, and the passphrase is in no argv, environment or process list", () => {
      const bytes = Buffer.from(`${PASS}\r\n\n`, "utf8");
      const r = run([NAME, "--yes", "--passphrase-file", passFile(bytes)]);
      expect(r.code, r.stderr).toBe(0);
      expect(fs.readFileSync(path.join(rec, "stdin-verify")).equals(bytes)).toBe(true);
      expect(fs.readFileSync(path.join(rec, "stdin-restore")).equals(bytes)).toBe(true);
      expectPassphraseOnlyOnStdin();
    });
  });

  describe("R24: the database is rolled back only when the restore had reached it (its marker exists)", () => {
    it("SQLite, killed after the marker: uploads FIRST (staging goes, space is freed), then the database, then the marker, then start; byte-identical to before", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash" } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      const stamp = stampOf();
      expect(afterRestore()).toEqual([
        `${ROLLBACK()} state /app/uploads ${stamp}`, // how far it got is asked inside a container first (I1)
        `${ROLLBACK()} uploads /app/uploads ${stamp} /bv-backups/${upSnapName()}`,
        `${ROLLBACK()} sqlite /bv-backups/${dbSnapName()} /app/data/vault.db /app/uploads ${stamp}`,
        `${ROLLBACK()} clear-marker /app/uploads ${stamp}`,
        "compose up -d",
      ]);
      // Byte-identical: the database file, every upload (the .tmp work file included), no journal, no .restore-/.pre-restore- folder, no marker.
      expect(install()).toEqual(before);
      expect(r.stderr).toContain("Moved the previous images folder back into place.");
      expect(r.stderr).toContain("copied back from the snapshot: documents/doc1.pdf");
      expect(lines(r.stderr).at(-1)).toBe(
        `ERROR: the restore failed (the reason is above). The database and the uploads were put back from the snapshot taken before it (backups/${dbSnapName()}), so nothing is changed. BlackVault was started again.`,
      );
      expect(recoveryFiles()).toEqual([]);
    });

    it("SQLite, failed BEFORE the marker (refused while staging): NO database-rollback command is issued; the database file is not touched; staging is removed", () => {
      const before = install();
      const dbPath = path.join(app, "data/db/vault.db");
      const dbBefore = { sha: sha(fs.readFileSync(dbPath)), mtime: fs.statSync(dbPath).mtimeMs, ino: fs.statSync(dbPath).ino };
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "refuse" } });
      expect(r.code).toBe(1);
      expect(afterRestore()).toEqual([`${ROLLBACK()} state /app/uploads ${stampOf()}`, `${ROLLBACK()} uploads /app/uploads ${stampOf()} /bv-backups/${upSnapName()}`, "compose up -d"]);
      expect(read("calls")).not.toMatch(/bv-snapshot-restore\.sh (sqlite|clear-marker)|psql/);
      expect({ sha: sha(fs.readFileSync(dbPath)), mtime: fs.statSync(dbPath).mtimeMs, ino: fs.statSync(dbPath).ino }).toEqual(dbBefore); // not even rewritten
      expect(install()).toEqual(before);
      expect(lines(r.stderr).at(-1)).toBe(
        "ERROR: the restore failed (the reason is above). It had not reached the database, which was not touched; the uploads were checked against the snapshot. Nothing is changed. BlackVault was started again.",
      );
      expect(recoveryFiles()).toEqual([]);
    });

    it("the database step had started and failed without changing anything: the marker is there, so the database IS put back", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "dbfail" } });
      expect(r.code).toBe(1);
      expect(afterRestore().map((c) => c.split("/bv-snapshot-restore.sh ")[1]?.split(" ")[0] ?? c)).toEqual(["state", "uploads", "sqlite", "clear-marker", "compose up -d"]);
      expect(install()).toEqual(before);
    });

    it("PostgreSQL, failed BEFORE the marker: not one psql command; the database is never dropped", () => {
      pgInstall();
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "refuse" } });
      expect(r.code).toBe(1);
      expect(afterRestore()).toEqual([`${ROLLBACK()} state /app/uploads ${stampOf()}`, `${ROLLBACK()} uploads /app/uploads ${stampOf()} /bv-backups/${upSnapName()}`, "compose up -d"]);
      expect(read("calls")).not.toMatch(/psql|DROP DATABASE|clear-marker/);
      expect(install()).toEqual(before);
    });

    it("PostgreSQL, after the marker: the uploads, then the dump is loaded into a NEW database in one transaction and swapped in, then the marker, then start", () => {
      pgInstall();
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash" } });
      expect(r.code).toBe(1);
      const stamp = stampOf();
      expect(steps().slice(0, steps().findIndex((c) => RESTORE.test(c)))).toEqual(expect.arrayContaining(["compose up -d --wait db", "compose exec -T db pg_dump -U blackvault -d blackvault"]));
      expect(afterRestore()).toEqual([
        `${ROLLBACK()} state /app/uploads ${stamp}`,
        `${ROLLBACK()} uploads /app/uploads ${stamp} /bv-backups/${upSnapName()}`,
        "compose up -d --wait db",
        `${PSQL} -d postgres -c DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE) -c CREATE DATABASE blackvault_rollback OWNER blackvault`,
        `${PSQL} -d blackvault_rollback --single-transaction -f -`,
        `${PSQL} -d postgres -c DROP DATABASE IF EXISTS blackvault WITH (FORCE) -c ALTER DATABASE blackvault_rollback RENAME TO blackvault`,
        `${ROLLBACK()} clear-marker /app/uploads ${stamp}`,
        "compose up -d",
      ]);
      expect(read("psql-stdin")).toBe("-- stub pg_dump of blackvault\n"); // the dump, on the loading psql's stdin
      expect(install()).toEqual(before);
    });

    it("PostgreSQL: if the dump does not load, the live database is never dropped; BlackVault is not started; the recovery file stays", () => {
      pgInstall();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_FAIL_ON: "--single-transaction" } });
      expect(r.code).toBe(1);
      expect(read("calls")).not.toContain("DROP DATABASE IF EXISTS blackvault WITH");
      expect(read("calls")).not.toContain("clear-marker");
      expect(steps()).not.toContain("compose up -d");
      expect(r.stderr).toContain("ERROR: the restore failed AND the automatic rollback failed");
      expect(recoveryFiles()).toHaveLength(1);
      expect(r.stderr).toMatch(/docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault -d blackvault_rollback --single-transaction -f - < backups\/blackvault-\d{8}-\d{6}\.sql/);
      expect(fs.existsSync(path.join(app, `data/uploads/.restore-${stampOf()}.db-started`))).toBe(true); // still says: the database must be put back
    });

    it("the uploads folder cannot be looked into from the host: the state is asked INSIDE a container, and acted on (untouched → no database rollback; started → rollback)", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "refuse", BV_STUB_HIDE_UPLOADS: "1" } });
      expect(r.code).toBe(1);
      expect(afterRestore().map((c) => c.split("/bv-snapshot-restore.sh ")[1]?.split(" ")[0] ?? c)).toEqual(["state", "uploads", "compose up -d"]);

      fs.rmSync(path.join(rec, "calls"));
      fs.rmSync(path.join(app, "backups"), { recursive: true });
      const s2 = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_HIDE_UPLOADS: "1" } });
      expect(s2.code).toBe(1);
      expect(afterRestore().map((c) => c.split("/bv-snapshot-restore.sh ")[1]?.split(" ")[0] ?? c)).toEqual(["state", "uploads", "sqlite", "clear-marker", "compose up -d"]);
    });

    it("…and if it cannot be asked either: NOTHING is rolled back blindly, BlackVault is not started, the recovery file stays and is shown", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_HIDE_UPLOADS: "1", BV_STUB_ROLLBACK_FAIL: "state" } });
      fs.chmodSync(path.join(app, "data/uploads"), 0o755);
      expect(r.code).toBe(1);
      expect(afterRestore().map((c) => c.split("/bv-snapshot-restore.sh ")[1]?.split(" ")[0] ?? c)).toEqual(["state"]);
      expect(r.stderr).toContain("how far it got could not be found out");
      expect(r.stderr).toContain("BlackVault was NOT started.");
      expect(recoveryFiles()).toHaveLength(1);
    });

    describe("I1: on native Linux the host user cannot enter .pre-restore-<time> (0700, uid 1001): the container is asked FIRST", () => {
      const modes = () => afterRestore().map((c) => c.split("/bv-snapshot-restore.sh ")[1]?.split(" ")[0] ?? c);
      const unhide = () => {
        for (const n of fs.readdirSync(path.join(app, "data/uploads"))) if (n.startsWith(".pre-restore-")) fs.chmodSync(path.join(app, "data/uploads", n), 0o755);
      };

      it("the container answers complete: exit 0 with the WARNING, nothing rolled back, the RECOVERY file removed, BlackVault started", () => {
        const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "complete", BV_STUB_HIDE_PRE: "1" } });
        unhide();
        expect(r.code, r.stderr).toBe(0);
        expect(afterRestore()).toEqual([`${ROLLBACK()} state /app/uploads ${stampOf()}`, "compose up -d"]);
        expect(r.stderr).toMatch(/WARNING: the restore program ended with exit 137, but it had FINISHED: .* Nothing is rolled back\./);
        expect(r.stderr).not.toContain("the restore failed");
        expect(lines(r.stderr)).toContain("Restore complete.");
        expect(recoveryFiles()).toEqual([]);
        // The restored state is still there: nothing was moved back.
        expect(fs.readFileSync(path.join(app, "data/uploads/images/from-backup.jpg"), "utf8")).toBe("restored");
        expect(fs.readFileSync(path.join(app, "data/db/vault.db"), "utf8")).toBe("THE RESTORED RECORDS");
        expect(fs.existsSync(path.join(app, `data/uploads/.pre-restore-${stampOf()}/images/firearms/photo1.jpg`))).toBe(true);
      });

      it("the container answers started: the full rollback (uploads, database, marker), then start; byte-identical to before", () => {
        const before = install();
        const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_HIDE_PRE: "1" } });
        expect(r.code).toBe(1);
        expect(modes()).toEqual(["state", "uploads", "sqlite", "clear-marker", "compose up -d"]);
        expect(install()).toEqual(before);
        expect(recoveryFiles()).toEqual([]);
      });

      it("the container cannot answer and the host cannot look into .pre-restore-<time>: unknown — nothing rolled back, BlackVault not started, the RECOVERY file kept and shown", () => {
        const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "complete", BV_STUB_HIDE_PRE: "1", BV_STUB_ROLLBACK_FAIL: "state" } });
        unhide();
        expect(r.code).toBe(1);
        expect(modes()).toEqual(["state"]);
        expect(r.stderr).toContain("how far it got could not be found out");
        expect(r.stderr).toContain("Nothing is rolled back blindly.");
        expect(r.stderr).toContain("BlackVault was NOT started.");
        expect(r.stderr).not.toContain("Nothing is changed");
        expect(steps()).not.toContain("compose up -d");
        expect(recoveryFiles()).toHaveLength(1);
        expect(fs.readFileSync(path.join(app, "data/db/vault.db"), "utf8")).toBe("THE RESTORED RECORDS");
      });

      it("the container cannot answer but the host CAN look: the host's answer is used (complete → exit 0; untouched → uploads checked; started → rollback attempted)", () => {
        const done = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "complete", BV_STUB_ROLLBACK_FAIL: "state" } });
        expect(done.code, done.stderr).toBe(0);
        expect(modes()).toEqual(["state", "compose up -d"]);
        expect(recoveryFiles()).toEqual([]);

        for (const [stub, expected] of [
          ["refuse", ["state", "uploads", "compose up -d"]],
          ["crash", ["state", "uploads", "sqlite", "clear-marker", "compose up -d"]],
        ] as Array<[string, string[]]>) {
          fs.rmSync(path.join(rec, "calls"));
          fs.rmSync(path.join(app, "backups"), { recursive: true });
          fs.rmSync(path.join(app, "data"), { recursive: true });
          seedInstall();
          const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: stub, BV_STUB_ROLLBACK_FAIL: "state" } });
          expect(r.code).toBe(1);
          expect(modes(), stub).toEqual(expected);
          expect(recoveryFiles()).toEqual([]);
        }
      });
    });

    it("the program had FINISHED but its exit status was lost (no marker, .pre-restore-<time> in place): nothing is rolled back; BlackVault is started; exit 0 with a WARNING", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "complete" } });
      expect(r.code, r.stderr).toBe(0);
      expect(afterRestore()).toEqual([`${ROLLBACK()} state /app/uploads ${stampOf()}`, "compose up -d"]);
      expect(r.stderr).toMatch(/WARNING: the restore program ended with exit 137, but it had FINISHED: .* Nothing is rolled back\. Its BLACKVAULT_FULL_RESTORE_OK line and the RESTORE entry in the audit log may be missing\./);
      expect(fs.readFileSync(path.join(app, "data/uploads/images/from-backup.jpg"), "utf8")).toBe("restored");
      expect(recoveryFiles()).toEqual([]);
    });
  });

  describe("R25: the recovery file", () => {
    it("exists WHILE the restore runs, names the snapshot, and is gone after a success", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      const during = read("recovery-during");
      const stamp = stampOf();
      expect(during).toContain(`BlackVault restore ${stamp}: RECOVERY`);
      expect(during).toContain(`  database: backups/${dbSnapName()}`);
      expect(during).toContain(`  uploads:  backups/${upSnapName()}`);
      expect(during).toContain(`  docker stop blackvault-restore-${stamp}`);
      expect(during).toContain(`  docker ps -a --filter name=blackvault-restore-${stamp}`);
      expect(during).toContain(`  docker ${ROLLBACK()} uploads /app/uploads ${stamp} /bv-backups/${upSnapName()}`);
      expect(during).toContain(`  docker ${ROLLBACK()} state /app/uploads ${stamp}`);
      expect(during).toContain(`  docker ${ROLLBACK()} sqlite /bv-backups/${dbSnapName()} /app/data/vault.db /app/uploads ${stamp}`);
      expect(during).toContain(`  docker ${ROLLBACK()} clear-marker /app/uploads ${stamp}`);
      expect(during).toContain(`  rm backups/restore-${stamp}-RECOVERY.txt`);
      // It was also PRINTED before the restore started.
      expect(r.stderr).toContain(during);
      expect(r.stderr.indexOf(during)).toBeLessThan(r.stderr.indexOf("Restoring "));
      expect(recoveryFiles()).toEqual([]);
    });

    it("the rollback itself fails: BlackVault is NOT started; the file stays, is printed, and BLOCKS a second restore until it is dealt with", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_ROLLBACK_FAIL: "sqlite" } });
      expect(r.code).toBe(1);
      expect(steps()).not.toContain("compose up -d");
      expect(read("calls")).not.toContain("clear-marker");
      const stamp = stampOf();
      const file = `restore-${stamp}-RECOVERY.txt`;
      expect(recoveryFiles()).toEqual([file]);
      expect(r.stderr).toContain(`ERROR: the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started. What to do is in ${app}/backups/${file}:`);
      expect(r.stderr.split("What to do is in")[1]).toContain(fs.readFileSync(path.join(app, "backups", file), "utf8"));
      if (process.platform !== "win32") expect(fs.statSync(path.join(app, "backups", file)).mode & 0o777).toBe(0o600);
      // The snapshot itself is intact.
      expect(fs.readFileSync(path.join(app, "backups", dbSnapName()), "utf8")).toBe("the database as it was before the restore");

      fs.rmSync(path.join(rec, "calls"));
      const again = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(again.code).toBe(1);
      expect(lines(again.stderr)).toEqual([
        `ERROR: an earlier restore did not finish cleanly: ${app}/backups/${file} is still there. Read it: it says how to put the install back as it was. If BlackVault is running and you have checked it, delete that file instead. Then run the restore again. Nothing was done.`,
      ]);
      expect(steps()).toEqual([]); // not even the check
    });

    it("its commands really work: run by hand after a failed rollback — in a checkout whose path has a SPACE — they return the install to before, marker and file included", () => {
      const spaced = path.join(path.dirname(app), "my vault");
      fs.renameSync(app, spaced);
      app = spaced;
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_ROLLBACK_FAIL: "uploads" } });
      expect(r.code).toBe(1);
      expect(install()).not.toEqual(before);
      const file = path.join(app, "backups", recoveryFiles()[0]);
      const text = fs.readFileSync(file, "utf8");
      expect(text).toContain(`Run these from '${app}', in this order.`);
      const commands = printedCommands(text);
      expect(commands.map(modesOf)).toEqual(["state", "uploads && sqlite && clear-marker", "rm"]);
      expect(commands[0]).toContain(`-v '${app}/backups:/bv-backups:ro'`);
      for (const command of commands) {
        const done = spawnSync("bash", ["-c", command], { cwd: app, env: baseEnv(), encoding: "utf8", timeout: SPAWN_LIMIT_MS });
        expect(done.status, `${command}\n${done.stderr}`).toBe(0);
      }
      expect(install()).toEqual(before);
      expect(recoveryFiles()).toEqual([]);
    });

    it("PostgreSQL: the file holds the psql commands, with the dump path quoted", () => {
      pgInstall();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      const during = read("recovery-during");
      expect(during).toContain("  docker compose up -d --wait db");
      expect(during).toContain(`  docker ${PSQL} -d postgres -c 'DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)' -c 'CREATE DATABASE blackvault_rollback OWNER blackvault'`);
      expect(during).toMatch(/ {2}docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault -d blackvault_rollback --single-transaction -f - < backups\/blackvault-\d{8}-\d{6}\.sql &&\n/);
      // One && chain from the state test to clear-marker (nothing runs unless the state is started; the marker is cleared only if every line above worked)…
      const chain = printedCommands(during).find((c) => c.includes("psql"))!;
      expect(chain.split(" &&\n").map((l) => (l.includes("/bv-snapshot-restore.sh ") ? modesOf(l) : l.includes("psql") ? "psql" : l))).toEqual(["state", "uploads", "docker compose up -d --wait db", "psql", "psql", "psql", "clear-marker"]);
      // The first link is step 2's own command inside a test: the rest runs only when it prints `started`.
      expect(chain.split(" &&\n")[0]).toBe(`[ "$(${printedCommands(during)[0]})" = started ]`);
      // …and, for the two other states, the uploads line by itself.
      expect(printedCommands(during).map((c) => (c.includes("psql") ? "chain" : modesOf(c)))).toEqual(["state", "chain", "uploads", "rm"]);
      expect(during).toContain(`  docker ${PSQL} -d postgres -c 'DROP DATABASE IF EXISTS blackvault WITH (FORCE)' -c 'ALTER DATABASE blackvault_rollback RENAME TO blackvault'`);
    });

    it("is flushed to disk (the file and its folder) after it is written and BEFORE the restore program starts", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      // One `sync`, with no arguments (the form every system has), with the file already there and the restore not yet started.
      expect(lines(read("sync"))).toEqual(["sync ", `backups/restore-${stampOf()}-RECOVERY.txt`, "restore-started=0"]);
      expect(r.stderr).not.toContain("WARNING: 'sync' failed");
      // On the script: the flush follows the write directly, before the text is shown and before the restore's trap and program.
      const sh = lines(fs.readFileSync(path.join(ROOT, "restore.sh"), "utf8")).filter((l) => !l.trimStart().startsWith("#"));
      const write = sh.indexOf('if ! (umask 077 && recovery_text > "$RECOVERY_FILE"); then');
      const flush = sh.findIndex((l) => l.startsWith("sync || "));
      expect(write).toBeGreaterThan(0);
      expect(sh.slice(write, flush)).toEqual([
        'if ! (umask 077 && recovery_text > "$RECOVERY_FILE"); then',
        "  trap - INT TERM HUP",
        '  PASSPHRASE=""',
        '  rm -f "$RECOVERY_FILE"',
        '  start_app || echo "WARNING: BlackVault did not start again; start it by hand: $COMPOSE up -d" >&2',
        '  die "could not write the recovery file $RECOVERY_FILE, so the restore did not start. Nothing was changed."',
        "fi",
      ]);
      expect(flush).toBeLessThan(sh.indexOf("trap interrupted INT TERM HUP"));
      expect(flush).toBeLessThan(sh.findIndex((l) => l.includes("dist/scripts/full-restore.mjs")));
      expect(sh.filter((l) => /^\s*sync\b/.test(l))).toHaveLength(1);
    });

    it("the flush fails: one WARNING, and the restore goes on (the file was written; only its durability is in doubt)", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_SYNC_FAIL: "1" } });
      expect(r.code, r.stderr).toBe(0);
      expect(lines(r.stderr).filter((l) => l.includes("'sync' failed"))).toEqual([
        `WARNING: 'sync' failed, so backups/restore-${stampOf()}-RECOVERY.txt may not be on the disk yet. After a power cut during the restore it could be missing: the snapshot it names would still be in backups/.`,
      ]);
      expect(steps().some((c) => RESTORE.test(c))).toBe(true);
    });

    it("the recovery file cannot be written: the restore does not start; BlackVault is started again; nothing changed", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_LOCK_BACKUPS: "1" } });
      fs.chmodSync(path.join(app, "backups"), 0o700);
      expect(r.code).toBe(1);
      expect(steps().some((c) => RESTORE.test(c))).toBe(false);
      expect(steps().at(-1)).toBe("compose up -d");
      expect(lines(r.stderr).at(-1)).toMatch(/^ERROR: could not write the recovery file backups\/restore-\d{8}-\d{6}-RECOVERY\.txt, so the restore did not start\. Nothing was changed\.$/);
      expect(install()).toEqual(before);
    });
  });

  describe("interrupted (R25)", () => {
    it.each(["SIGTERM", "SIGHUP", "SIGINT"] as NodeJS.Signals[])("%s while the restore runs: the restore container is stopped BY NAME and seen to be gone, then the recovery text is shown; the file stays; BlackVault is not started", async (signal) => {
      const r = await runAndSignal("restore.pid", signal, { BV_STUB_RESTORE: "hang" });
      expect(r.code).toBe(1);
      // At once, not when the "container" ends by itself: the stub would run for 120 s. (60 s only guards against that; a stalled machine does not fail it.)
      expect(r.ms).toBeLessThan(60_000);
      const stamp = stampOf();
      expect(afterRestore()).toEqual([`stop blackvault-restore-${stamp}`, `ps -aq --filter name=^blackvault-restore-${stamp}$`]);
      const tail = r.stderr.slice(r.stderr.indexOf("ERROR: the restore was interrupted."));
      expect(tail).toContain("ERROR: the restore was interrupted. BlackVault is stopped and the install may be half restored.");
      expect(tail).toContain("The restore container is gone.");
      expect(tail).toContain(`To put the install back as it was, follow ${app}/backups/restore-${stamp}-RECOVERY.txt:`);
      expect(tail).toContain(fs.readFileSync(path.join(app, "backups", `restore-${stamp}-RECOVERY.txt`), "utf8"));
      expect(steps()).not.toContain("compose up -d");
    }, TEST_LIMIT_MS);

    it("the container cannot be seen to be gone: the text says NOT to run the rollback commands yet", async () => {
      const r = await runAndSignal("restore.pid", "SIGTERM", { BV_STUB_RESTORE: "hang", BV_STUB_CONTAINER_STUCK: "1" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(`WARNING: could not confirm that the restore container blackvault-restore-${stampOf()} has stopped. Do NOT run the commands of steps 2 to 4 until step 1's 'docker ps' lists nothing.`);
      expect(r.stderr).not.toContain("The restore container is gone.");
    }, TEST_LIMIT_MS);

    it("interrupted while BlackVault is being stopped (before the restore started): BlackVault is started again and the message says nothing was changed; no recovery file", async () => {
      const before = install();
      const r = await runAndSignal("stopping", "SIGTERM", { BV_STUB_STOP_SLEEP: "3" });
      expect(r.code).toBe(1);
      // bash runs the trap when the command in progress ends. Wherever the signal landed (a stalled machine may deliver it late),
      // the restore program never ran and the last thing done was starting BlackVault.
      expect(steps().slice(0, 3)).toEqual([VERIFY, PS, "compose stop blackvault"]);
      expect(steps().at(-1)).toBe("compose up -d");
      expect(steps().some((c) => RESTORE.test(c))).toBe(false);
      expect(lines(r.stderr).at(-1)).toBe("ERROR: interrupted before the restore started. Nothing was changed; BlackVault was started again.");
      expect(install()).toEqual(before);
      expect(recoveryFiles()).toEqual([]);
    }, TEST_LIMIT_MS);

    it("…and if it cannot be started again, the message says plainly that it is STOPPED", async () => {
      const r = await runAndSignal("stopping", "SIGTERM", { BV_STUB_STOP_SLEEP: "3", BV_STUB_FAIL_ON: "up" });
      expect(r.code).toBe(1);
      expect(lines(r.stderr).at(-1)).toBe("ERROR: interrupted before the restore started. Nothing was changed, but BlackVault is STOPPED: start it with: docker compose up -d");
    }, TEST_LIMIT_MS);

    // Re-review minor 2: `docker stop` finds nothing when the container was never created; the `compose run` CLIENT must not live on and create it.
    it("the container does not exist yet: the docker client the wrapper started is killed, so it cannot create the container after the trap has reported it gone", async () => {
      const r = await runAndSignal("restore.pid", "SIGTERM", { BV_STUB_RESTORE: "hang", BV_STUB_NO_CONTAINER: "1" });
      expect(r.code).toBe(1);
      const client = Number(read("restore.pid"));
      expect(await waitUntilDead(client)).toBe(true); // the wrapper killed it; `docker stop` (a no-op here) did not
      expect(alive(client)).toBe(false);
      expect(r.stderr).toContain("The restore container is gone.");
      expect(afterRestore()).toEqual([`stop blackvault-restore-${stampOf()}`, `ps -aq --filter name=^blackvault-restore-${stampOf()}$`]);
    }, TEST_LIMIT_MS);

    // Re-review minor 6.
    it("interrupted during the snapshot: db-snapshot.sh's uploads marker is not left behind, there is no recovery file, and BlackVault is started again", async () => {
      const before = install();
      const r = await runAndSignal("snapshotting", "SIGTERM", { BV_STUB_SNAPSHOT_SLEEP: "3" });
      expect(r.code).toBe(1);
      expect(lines(r.stderr).at(-1)).toBe("ERROR: interrupted before the restore started. Nothing was changed; BlackVault was started again.");
      expect(steps().at(-1)).toBe("compose up -d");
      expect(steps().some((c) => RESTORE.test(c))).toBe(false);
      expect(backupsDir().filter((n) => n === ".uploads-snapshot-marker" || n.endsWith("-RECOVERY.txt"))).toEqual([]);
      expect(install()).toEqual(before);
      // A second restore is not blocked.
      expect(run([NAME, "--yes", "--passphrase-file", passFile()]).code).toBe(0);
    }, TEST_LIMIT_MS);

    it("the early handler also removes a recovery file already written (the window between writing it and starting the restore)", () => {
      // That window holds only `echo`/`cat`; no test can land a signal in it. Pinned on the script instead.
      const sh = fs.readFileSync(path.join(ROOT, "restore.sh"), "utf8");
      const body = sh.slice(sh.indexOf("interrupted_early() {"), sh.indexOf("trap interrupted_early INT TERM HUP"));
      expect(body).toContain('rm -f "$RECOVERY_FILE" backups/.uploads-snapshot-marker');
      // …and it stays the handler until the restore's own trap replaces it, with nothing that changes the install in between.
      const between = sh.slice(sh.indexOf('if ! (umask 077 && recovery_text > "$RECOVERY_FILE"); then'), sh.indexOf("trap interrupted INT TERM HUP"));
      expect(between).not.toMatch(/\$COMPOSE (run|exec|stop)|bv_run_with_passphrase/);
    });
  });

  // Re-review minor 3.
  describe("a time stamp that is already taken", () => {
    it.each([".pre-restore-20270101-000000", ".restore-20270101-000000.db-started"])("%s already exists: refused before BlackVault is stopped — never reported as a completed restore", (leftover) => {
      const before = install();
      fs.mkdirSync(path.join(app, "data/uploads", leftover));
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_DATE: "20270101-000000" } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(steps()).toEqual([VERIFY]);
      expect(lines(r.stderr).at(-1)).toBe(
        `ERROR: ./data/uploads/${leftover} already exists (left by an earlier restore with the same time stamp). Wait a second and run the restore again. Nothing was changed; BlackVault was not stopped.`,
      );
      fs.rmdirSync(path.join(app, "data/uploads", leftover));
      expect(install()).toEqual(before);
    });

    // I1: the same blind spot before the run. The host cannot enter the uploads folder, so the container is asked.
    it.each([
      [".pre-restore-20270101-000000/images", "complete"],
      [".restore-20270101-000000.db-started", "started"],
    ])("the uploads folder cannot be entered from the host and %s is there: the container is asked, and the restore is refused before BlackVault is stopped", (leftover) => {
      fs.mkdirSync(path.join(app, "data/uploads", leftover), { recursive: true });
      fs.chmodSync(path.join(app, "data/uploads"), 0o000);
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_DATE: "20270101-000000" } });
      fs.chmodSync(path.join(app, "data/uploads"), 0o755);
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(steps()).toEqual([VERIFY, `${ROLLBACK()} state /app/uploads 20270101-000000`]);
      expect(lines(r.stderr).at(-1)).toBe(
        "ERROR: an earlier restore with the same time stamp (20270101-000000) left its .pre-restore folder or its marker in the uploads folder. Wait a second and run the restore again. Nothing was changed; BlackVault was not stopped.",
      );
    });

    it("the uploads folder cannot be entered from the host and the container cannot be asked: refused before BlackVault is stopped", () => {
      fs.chmodSync(path.join(app, "data/uploads"), 0o000);
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_DATE: "20270101-000000", BV_STUB_ROLLBACK_FAIL: "state" } });
      fs.chmodSync(path.join(app, "data/uploads"), 0o755);
      expect(r.code).toBe(1);
      expect(steps()).toEqual([VERIFY, `${ROLLBACK()} state /app/uploads 20270101-000000`]);
      expect(lines(r.stderr).at(-1)).toMatch(/^ERROR: could not check the uploads folder .* Nothing was changed; BlackVault was not stopped\.$/);
    });
  });

  /**
   * Ruling R28. The wrapper is DEAD (kill -9: a closed window, a crashed
   * host) while the restore container runs on and ends in one of the three
   * states. All that is left is the recovery file. Its commands are then run
   * EXACTLY AS PRINTED, every one of them, in order.
   */
  describe("R28: the recovery file's commands, run exactly as printed, are right in each of the three states", () => {
    async function wrapperDies(mode: string) {
      const r = await runAndSignal("restore.pid", "SIGKILL", { BV_STUB_RESTORE: mode, BV_STUB_THEN_HANG: "1" });
      expect(r.code).toBeNull(); // killed: no trap ran
      const container = Number(read("restore.pid"));
      process.kill(container);
      expect(await waitUntilDead(container)).toBe(true);
      expect(recoveryFiles()).toHaveLength(1);
      return fs.readFileSync(path.join(app, "backups", recoveryFiles()[0]), "utf8");
    }
    function runPrinted(text: string) {
      const commands = printedCommands(text);
      expect(commands.map(modesOf)).toEqual(["state", "uploads && sqlite && clear-marker", "rm"]);
      let out = "";
      for (const command of commands) {
        const done = spawnSync("bash", ["-c", command], { cwd: app, env: baseEnv(), encoding: "utf8", timeout: SPAWN_LIMIT_MS });
        expect(done.status, `${command}\n${done.stderr}`).toBe(0);
        out += done.stdout + done.stderr;
      }
      return out;
    }

    it("(a) FINISHED (no marker, .pre-restore-<time> in place): nothing is moved; the records and the files stay the restored ones", async () => {
      const text = await wrapperDies("complete");
      const restored = install();
      expect(fs.readFileSync(path.join(app, "data/db/vault.db"), "utf8")).toBe("THE RESTORED RECORDS");
      const out = runPrinted(text);
      expect(out.split("\n")[0]).toBe("complete");
      expect(out).toContain("had FINISHED");
      expect(out).not.toContain("Moved the previous");
      expect(out).not.toContain("copied back from the snapshot");
      expect(install()).toEqual(restored); // byte for byte: database, restored folders, .pre-restore-<time>
      expect(fs.readFileSync(path.join(app, "data/uploads/images/from-backup.jpg"), "utf8")).toBe("restored");
      expect(recoveryFiles()).toEqual([]);
    }, TEST_LIMIT_MS);

    it("(b) STARTED (marker present, killed mid-way): rolled back to exactly what was there before", async () => {
      const before = install();
      const text = await wrapperDies("crash");
      expect(install()).not.toEqual(before);
      const out = runPrinted(text);
      expect(out.split("\n")[0]).toBe("started");
      expect(out).toContain("Moved the previous images folder back into place.");
      expect(install()).toEqual(before);
      expect(recoveryFiles()).toEqual([]);
    }, TEST_LIMIT_MS);

    // Task 7 re-review, new breakage 1: run after a line that failed, clear-marker removed the only thing
    // that says "the database step was reached", and the half-rolled-back install then read as untouched.
    it("(b2) STARTED, and the database line FAILS: the chain stops there — the marker is still present and `state` still says started; run again, it finishes the job", async () => {
      const before = install();
      const text = await wrapperDies("crash");
      const [state, chain, rm] = printedCommands(text);
      expect(modesOf(chain)).toBe("uploads && sqlite && clear-marker");
      const sh = (command: string, env: Record<string, string> = {}) => spawnSync("bash", ["-c", command], { cwd: app, env: baseEnv(env), encoding: "utf8", timeout: SPAWN_LIMIT_MS });
      expect(sh(state).stdout.trim()).toBe("started");
      const stamp = /\/bv-snapshot-restore\.sh state \/app\/uploads (\d{8}-\d{6})/.exec(state)![1];
      const marker = path.join(app, "data/uploads", `.restore-${stamp}.db-started`);
      fs.rmSync(path.join(rec, "calls"));
      const failed = sh(chain, { BV_STUB_ROLLBACK_FAIL: "sqlite" });
      expect(failed.status).not.toBe(0);
      expect(failed.stderr).toContain("ERROR: could not restore from the snapshot: [stub] refused");
      // The uploads line ran, the database line failed, and clear-marker was NOT run.
      expect(steps().map((c) => c.split("/bv-snapshot-restore.sh ")[1].split(" ")[0])).toEqual(["uploads", "sqlite"]);
      expect(fs.existsSync(marker)).toBe(true);
      expect(sh(state).stdout.trim()).toBe("started");
      expect(install()).not.toEqual(before); // the database is still the failed restore's
      // The same line again, this time with nothing in the way: everything is back and the marker is gone.
      const again = sh(chain);
      expect(again.status, again.stderr).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
      expect(sh(rm).status).toBe(0);
      expect(install()).toEqual(before);
      expect(recoveryFiles()).toEqual([]);
    }, TEST_LIMIT_MS);

    it("the text says in words that the last line runs only if every line above it worked", () => {
      expect(run([NAME, "--yes", "--passphrase-file", passFile()]).code).toBe(0);
      const text = read("recovery-during");
      expect(text).toContain("3. Put it back. These lines are ONE command (each ends in &&): a line runs");
      expect(text).toContain("only if every line above it worked, so the marker is cleared (the last");
      expect(text).toContain("never run the last");
      expect(text).not.toContain("Run every line, in this order");
    });

    it("(c) UNTOUCHED (refused while staging, no marker): unchanged — the database file is not even rewritten", async () => {
      const before = install();
      const dbPath = path.join(app, "data/db/vault.db");
      const dbBefore = { mtime: fs.statSync(dbPath).mtimeMs, ino: fs.statSync(dbPath).ino };
      const text = await wrapperDies("refuse");
      const out = runPrinted(text);
      expect(out.split("\n")[0]).toBe("untouched");
      expect(install()).toEqual(before); // the staging folder is gone too
      expect({ mtime: fs.statSync(dbPath).mtimeMs, ino: fs.statSync(dbPath).ino }).toEqual(dbBefore);
      expect(recoveryFiles()).toEqual([]);
    }, TEST_LIMIT_MS);

    /**
     * PostgreSQL. The database commands are psql, which no script guards: the chain's FIRST link asks
     * for the state, and nothing after it runs unless the answer is `started`. Pasted after a finished
     * restore (or one that never reached the database) the chain must not send one psql command.
     */
    describe("PostgreSQL: the chain asks for the state itself, so pasting it changes nothing unless the restore is half done", () => {
      const sh = (command: string) => spawnSync("bash", ["-c", command], { cwd: app, env: baseEnv(), encoding: "utf8", timeout: SPAWN_LIMIT_MS });
      const label = (c: string) => (c.includes("/bv-snapshot-restore.sh ") ? c.split("/bv-snapshot-restore.sh ")[1].split(" ")[0] : c.includes("psql") ? "psql" : c);
      /** The four printed commands: step 2, the chain, the uploads line for the other two states, and the rm. */
      function printed(text: string) {
        const commands = printedCommands(text);
        expect(commands.map((c) => (c.includes("psql") ? "chain" : modesOf(c)))).toEqual(["state", "chain", "uploads", "rm"]);
        const [state, chain, uploads, rm] = commands;
        return { state, chain, uploads, rm };
      }

      it.each([
        ["complete", "FINISHED"],
        ["refuse", "never reached the database"],
      ])("%s (%s): the chain, exactly as printed, runs the state test and NOTHING else — no psql, no uploads rollback, no clear-marker", async (mode) => {
        pgInstall();
        const before = install();
        const text = await wrapperDies(mode);
        const left = install();
        const { state, chain, uploads, rm } = printed(text);
        expect(sh(state).stdout.trim()).toBe(mode === "complete" ? "complete" : "untouched");
        fs.rmSync(path.join(rec, "calls"));
        const pasted = sh(chain);
        expect(pasted.status).not.toBe(0); // it stopped at its first link
        expect(steps().map(label)).toEqual(["state"]);
        expect(read("calls")).not.toMatch(/psql|DROP DATABASE|clear-marker|up -d/);
        expect(fs.existsSync(path.join(rec, "psql-stdin"))).toBe(false);
        expect(install()).toEqual(left); // not a byte moved
        // The rest of the file, as printed: the uploads line for this state, then the rm.
        expect(sh(uploads).status).toBe(0);
        expect(sh(rm).status).toBe(0);
        if (mode === "complete") {
          expect(install()).toEqual(left); // the restored install stays the restored install
          expect(fs.readFileSync(path.join(app, "data/uploads/images/from-backup.jpg"), "utf8")).toBe("restored");
        } else expect(install()).toEqual(before); // only the staging folder went
        expect(read("calls")).not.toMatch(/psql|DROP DATABASE/);
        expect(recoveryFiles()).toEqual([]);
      }, TEST_LIMIT_MS);

      it("started: the chain, exactly as printed, puts the uploads back, loads the dump into a new database, swaps it in and clears the marker — in that order", async () => {
        pgInstall();
        const before = install();
        const text = await wrapperDies("crash");
        expect(install()).not.toEqual(before);
        const { state, chain, uploads, rm } = printed(text);
        expect(sh(state).stdout.trim()).toBe("started");
        fs.rmSync(path.join(rec, "calls"));
        const pasted = sh(chain);
        expect(pasted.status, pasted.stderr).toBe(0);
        expect(steps().map(label)).toEqual(["state", "uploads", "compose up -d --wait db", "psql", "psql", "psql", "clear-marker"]);
        expect(steps().filter((c) => c.includes("psql"))).toEqual([
          `${PSQL} -d postgres -c DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE) -c CREATE DATABASE blackvault_rollback OWNER blackvault`,
          `${PSQL} -d blackvault_rollback --single-transaction -f -`,
          `${PSQL} -d postgres -c DROP DATABASE IF EXISTS blackvault WITH (FORCE) -c ALTER DATABASE blackvault_rollback RENAME TO blackvault`,
        ]);
        expect(read("psql-stdin")).toBe("-- stub pg_dump of blackvault\n"); // the dump, on the loading psql's stdin
        expect(install()).toEqual(before);
        // Pasted a second time, it now does nothing: the marker is gone.
        expect(sh(state).stdout.trim()).toBe("untouched");
        fs.rmSync(path.join(rec, "calls"));
        expect(sh(chain).status).not.toBe(0);
        expect(steps().map(label)).toEqual(["state"]);
        expect(sh(uploads).status).toBe(0);
        expect(sh(rm).status).toBe(0);
        expect(install()).toEqual(before);
        expect(recoveryFiles()).toEqual([]);
      }, TEST_LIMIT_MS);

      it("started, and the dump does not load: the chain stops there; the live database is not dropped and the marker stays, so the state is still started", async () => {
        pgInstall();
        const text = await wrapperDies("crash");
        const { state, chain } = printed(text);
        fs.rmSync(path.join(rec, "calls"));
        const failed = spawnSync("bash", ["-c", chain], { cwd: app, env: baseEnv({ BV_STUB_FAIL_ON: "--single-transaction" }), encoding: "utf8", timeout: SPAWN_LIMIT_MS });
        expect(failed.status).not.toBe(0);
        expect(read("calls")).not.toContain("DROP DATABASE IF EXISTS blackvault WITH");
        expect(read("calls")).not.toContain("clear-marker");
        expect(sh(state).stdout.trim()).toBe("started");
      }, TEST_LIMIT_MS);
    });

    it("the text describes the three states, and on PostgreSQL says the psql lines are for 'started' only", () => {
      pgInstall();
      expect(run([NAME, "--yes", "--passphrase-file", passFile()]).code).toBe(0);
      const during = read("recovery-during");
      for (const word of ["   complete ", "   started ", "   untouched "]) expect(during).toContain(word);
      expect(during).toContain("ONLY if step 2 printed: started");
      expect(during).toContain("the first line asks for the state again");
      expect(during).not.toContain("the database was never touched: skip to step 4"); // the sentence that was false after a finished restore
      expect(during.indexOf("/bv-snapshot-restore.sh state /app/uploads")).toBeLessThan(during.indexOf("/bv-snapshot-restore.sh uploads /app/uploads"));
    });
  });

  describe("a full backup that is running is not killed: the lock is asked for in the running app BEFORE it is stopped", () => {
    const RUNNING = { BV_STUB_APP_RUNNING: "1" };

    it("the lock is held: exit 1 with the holder shown; BlackVault is never stopped, nothing is snapshotted or changed", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { ...RUNNING, BV_STUB_LOCK: "held" } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(steps()).toEqual([VERIFY, PS, LOCK_STATUS]);
      expect(lines(r.stderr).slice(-2)).toEqual([
        "BLACKVAULT_FULL_BACKUP_LOCK state=held pid=57 hostname=0123456789ab started=2026-10-03T03:15:00.000Z",
        "ERROR: a full backup is running (the line above names it), so the restore did not start. Nothing was changed; BlackVault was not stopped. Run the restore again when the backup has finished.",
      ]);
      expect(install()).toEqual(before);
      expect(fs.existsSync(path.join(app, "backups"))).toBe(false);
    });

    it("the lock is free: the restore goes on — check, ask, stop, in that order; the question gets nothing on stdin and adds nothing to stdout", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: RUNNING });
      expect(r.code, r.stderr).toBe(0);
      expect(steps().slice(0, 4)).toEqual([VERIFY, PS, LOCK_STATUS, "compose stop blackvault"]);
      expect(steps().filter((c) => c === LOCK_STATUS)).toHaveLength(1);
      expect(fs.readFileSync(path.join(rec, "stdin-lock-status"))).toHaveLength(0);
      expect(r.stdout).toBe(`${OK_LINE}\n`);
      expect(r.stderr).not.toContain("BLACKVAULT_FULL_BACKUP_LOCK");
      expect(r.stderr).not.toContain("WARNING: could not check");
      expectPassphraseOnlyOnStdin();
    });

    it.each([
      ["old-image", 1, "full-backup: unknown argument."],
      ["killed", 137, ""],
    ])("the question itself fails (%s, exit %i): ONE warning and the restore goes on — an image from before the option must not make a restore impossible", (mode, code, shown) => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { ...RUNNING, BV_STUB_LOCK: mode } });
      expect(r.code, r.stderr).toBe(0);
      expect(steps().slice(0, 4)).toEqual([VERIFY, PS, LOCK_STATUS, "compose stop blackvault"]);
      expect(lines(r.stderr).filter((l) => l.startsWith("WARNING: could not check"))).toEqual([
        `WARNING: could not check whether a full backup is running (exit ${code}; an image from before this check answers like that). If one is running, stopping BlackVault ends it. Going on with the restore.`,
      ]);
      if (shown) expect(r.stderr).toContain(shown);
      expect(r.stdout).toBe(`${OK_LINE}\n`);
    });

    it("BlackVault is not running: nobody is asked (the restore program takes the lock itself)", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      expect(steps().slice(0, 3)).toEqual([VERIFY, PS, "compose stop blackvault"]);
      expect(steps()).not.toContain(LOCK_STATUS);
    });

    it.skipIf(!hasPython)("it is asked only after RESTORE was typed: an unconfirmed restore never reaches it", () => {
      const refused = runOnTty([NAME, "--passphrase-file", passFile()], ["no"], { ...RUNNING, BV_STUB_LOCK: "held" });
      expect(refused.code, refused.out).toBe(1);
      expect(steps()).toEqual([VERIFY]);
      fs.rmSync(path.join(rec, "calls"));
      const held = runOnTty([NAME, "--passphrase-file", passFile()], ["RESTORE"], { ...RUNNING, BV_STUB_LOCK: "held" });
      expect(held.code, held.out).toBe(1);
      expect(steps()).toEqual([VERIFY, PS, LOCK_STATUS]);
      expect(held.out).toContain("ERROR: a full backup is running");
    });
  });

  describe("scripts/db-snapshot.sh: how to delete the uploads snapshot", () => {
    const savedLine = (stderr: string) => lines(stderr).find((l) => l.startsWith("Uploads snapshot saved: "));

    it("on Linux the snapshot belongs to uid 1001 and the host user cannot delete it: the line says to use sudo", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_UNAME: "Linux" } });
      expect(r.code, r.stderr).toBe(0);
      expect(savedLine(r.stderr)).toBe(`Uploads snapshot saved: backups/${upSnapName()} (owned by the app user, uid 1001; delete it with sudo)`);
    });

    it.each(["Darwin", "FreeBSD"])("on %s (Docker Desktop, OrbStack: the files show as the host user's own) the same line does not mention sudo", (system) => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_UNAME: system } });
      expect(r.code, r.stderr).toBe(0);
      expect(savedLine(r.stderr)).toBe(`Uploads snapshot saved: backups/${upSnapName()} (owned by the app user, uid 1001; delete it once BlackVault is confirmed working)`);
      expect(r.stderr).not.toMatch(/Uploads snapshot saved: .*sudo/);
    });
  });

  describe("refused with nothing changed", () => {
    it("the backup does not verify (wrong passphrase, truncated or tampered archive — the check program exits 1): exit 1, BlackVault is never stopped, nothing is snapshotted", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_VERIFY_EXIT: "1" } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(steps()).toEqual([VERIFY]);
      expect(lines(r.stderr).at(-1)).toBe(`ERROR: the backup ${NAME} did not pass the check (the reason is on the line above). Nothing was changed; BlackVault was not stopped.`);
      expect(r.stderr).toContain("full-backup: Wrong passphrase, or the backup is damaged.");
      expect(install()).toEqual(before);
      expect(fs.existsSync(path.join(app, "backups"))).toBe(false);
    });

    it("R21: no terminal and no --yes → exit 1 before anything is checked, stopped or changed; docker is never called", () => {
      for (const devNull of [true, false]) {
        const r = run([NAME, "--passphrase-file", passFile()], { devNull });
        expect(r.code).toBe(1);
        expect(lines(r.stderr)).toEqual(["ERROR: a restore replaces all data and must be confirmed, but standard input is not a terminal. Add --yes to confirm. Nothing was done."]);
      }
      expect(calls()).toEqual([]);
    });

    it("no terminal and no --passphrase-file → exit 1 at once (with or without --yes); docker is never called", () => {
      for (const args of [[NAME, "--yes"], [NAME]]) {
        const r = run(args, { devNull: true });
        expect(r.signal).toBeNull();
        expect(r.code).toBe(1);
        expect(r.stderr).toMatch(/^ERROR: no passphrase: standard input is not a terminal.*--passphrase-file.*\n$/);
      }
      expect(calls()).toEqual([]);
    });

    it("no file, two files, an unknown option (never echoed), a missing passphrase file", () => {
      const cases: Array<[string[], RegExp]> = [
        [["--yes", "--passphrase-file", passFile()], /^ERROR: no backup file was given\. Usage: /],
        [[NAME, "second-file", "--yes"], /^ERROR: unknown argument\. Usage: /],
        [[NAME, "--passphrase", "typed-by-mistake", "--yes"], /^ERROR: unknown argument\. Usage: /],
        [[NAME, "--yes", "--passphrase-file", path.join(tmp, "nope.txt")], /^ERROR: cannot read the passphrase file /],
      ];
      for (const [args, message] of cases) {
        const r = run(args);
        expect(r.code, args.join(" ")).toBe(1);
        expect(r.stderr).toMatch(message);
        expect(r.stderr).not.toContain("typed-by-mistake");
        expect(r.stderr).not.toContain("second-file");
      }
      expect(calls()).toEqual([]);
    });

    it("the snapshot fails: the restore never starts, BlackVault is started again, exit 1", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_FAIL_ON: "inspect" } });
      expect(r.code).toBe(1);
      expect(steps().some((c) => c.includes("full-restore.mjs"))).toBe(false);
      expect(steps().at(-1)).toBe("compose up -d");
      expect(lines(r.stderr).at(-1)).toBe("ERROR: the snapshot before the restore failed (see above), so the restore did not start. Nothing was changed.");
      expect(install()).toEqual(before);
      expect(fs.existsSync(path.join(app, "backups/.uploads-snapshot-marker"))).toBe(false);
    });

    it("no database yet (BlackVault never started): there is nothing a failed restore could be undone from, so it stops; BlackVault is started", () => {
      fs.rmSync(path.join(app, "data/db/vault.db"));
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code).toBe(1);
      expect(steps().some((c) => c.includes("full-restore.mjs"))).toBe(false);
      expect(steps().at(-1)).toBe("compose up -d");
      expect(lines(r.stderr).at(-1)).toMatch(/^ERROR: there is no database to snapshot yet.*Nothing was changed\.$/);
    });

    it("BlackVault cannot be stopped: exit 1, nothing snapshotted or restored", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_FAIL_ON: "stop" } });
      expect(r.code).toBe(1);
      expect(steps()).toEqual([VERIFY, PS, "compose stop blackvault"]);
      expect(lines(r.stderr).at(-1)).toBe("ERROR: could not stop BlackVault. Nothing was changed.");
    });

    it("Docker Compose missing or too old: exit 1, nothing run", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_COMPOSE_VERSION: "2.19.0" } });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^ERROR: BlackVault needs Docker Compose v2\.20 or newer/);
      expect(calls()).toEqual(["compose version --short"]);
    });
  });

  describe("the file argument", () => {
    it("a host path inside the backup folder maps to the file name; relative paths are relative to where the user ran the script", () => {
      const dir = path.join(app, "data/backups");
      const abs = run([path.join(dir, NAME), "--yes", "--passphrase-file", passFile()]);
      expect(abs.code, abs.stderr).toBe(0);
      const rel = run([`./${NAME}`, "--yes", "--passphrase-file", passFile()], { cwd: dir });
      expect(rel.code, rel.stderr).toBe(0);
      expect(steps().filter((c) => c.includes("--verify"))).toEqual([VERIFY, VERIFY]);
      expect(steps().filter((c) => RESTORE.test(c))).toHaveLength(2);
    });

    it("follows BLACKVAULT_BACKUP_DIR from .env", () => {
      const nas = path.join(tmp, "nas");
      fs.mkdirSync(nas);
      fs.appendFileSync(path.join(app, ".env"), `BLACKVAULT_BACKUP_DIR=${nas}\n`);
      expect(run([path.join(nas, NAME), "--yes", "--passphrase-file", passFile()]).code).toBe(0);
      const old = run([path.join(app, "data/backups", NAME), "--yes", "--passphrase-file", passFile()]);
      expect(old.code).toBe(1);
      expect(old.stderr).toMatch(/^ERROR: restore: .* is not in the backup folder/);
    });

    it("a path OUTSIDE the backup folder, or something that is not a file name: exit 1, one line, docker never asked to do anything", () => {
      for (const file of [path.join(tmp, NAME), path.join(app, "data", NAME), `../${NAME}`, "/etc/passwd", "a\\b.bvb", `${path.join(app, "data/backups")}/..`]) {
        const r = run([file, "--yes", "--passphrase-file", passFile()]);
        expect(r.code, file).toBe(1);
        expect(lines(r.stderr)).toHaveLength(1);
        expect(r.stderr).toMatch(/^ERROR: restore: /);
      }
      expect(steps()).toEqual([]);
    });
  });

  describe("the environment", () => {
    it("BLACKVAULT_* keys exported in the shell do not reach docker compose; an exported DATA_DIR reaches it unchanged", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], {
        env: { BLACKVAULT_BACKUP_DIR: "/somewhere/else", BLACKVAULT_DATABASE_URL: "file:./dev.db", BLACKVAULT_UPLOADS_SNAPSHOT: "backups/uploads-x", BLACKVAULT_DB_PROVIDER: "postgres" },
      });
      expect(r.code, r.stderr).toBe(0);
      const afterSetup = read("env").split("PATH=").slice(2).join("PATH="); // every call after the version probe
      expect(afterSetup).not.toMatch(/BLACKVAULT_BACKUP_DIR|BLACKVAULT_DATABASE_URL|BLACKVAULT_UPLOADS_SNAPSHOT|BLACKVAULT_DB_PROVIDER/);
    });
  });

  describe.skipIf(!hasPython)("on a terminal", () => {
    it("asks for the passphrase ONCE without echo, shows what will be replaced, and goes on only after RESTORE is typed", () => {
      const r = runOnTty([NAME], [PASS, "RESTORE"]);
      expect(r.code, r.out).toBe(0);
      expect(r.out.match(/Backup passphrase: /g)).toHaveLength(1);
      expect(r.out).not.toContain("Repeat the passphrase");
      expect(r.out).not.toContain("restore tëst"); // never echoed
      expect(r.out).toContain("This will REPLACE what is in this BlackVault install");
      expect(r.out).toContain("Type RESTORE to continue: ");
      expect(read("stdin-verify")).toBe(PASS);
      expect(read("stdin-restore")).toBe(PASS);
      expectPassphraseOnlyOnStdin();
      // The confirmation comes after the check and before the stop.
      expect(steps().slice(0, 3)).toEqual([VERIFY, PS, "compose stop blackvault"]);
    });

    it("anything other than RESTORE: exit 1, BlackVault is never stopped, nothing changed", () => {
      const before = install();
      for (const answer of ["yes", "restore", ""]) {
        fs.rmSync(path.join(rec, "calls"), { force: true });
        const r = runOnTty([NAME, "--passphrase-file", passFile()], [answer]);
        expect(r.code, r.out).toBe(1);
        expect(r.out).toContain("ERROR: not confirmed. Nothing was changed; BlackVault was not stopped.");
        expect(steps()).toEqual([VERIFY]);
      }
      expect(install()).toEqual(before);
    });

    it("--yes on a terminal skips the question", () => {
      const r = runOnTty([NAME, "--yes"], [PASS]);
      expect(r.code, r.out).toBe(0);
      expect(r.out).not.toContain("Type RESTORE");
    });
  });
});

/**
 * restore.bat cannot be RUN here (no cmd.exe); the Windows CI job runs it
 * (scripts/ci/windows/Test-WindowsInstallers.ps1, scenarios RS1–RS19). These
 * are the properties that can be read off the file on any platform. The
 * first of them is the one that matters most: batch cannot include another
 * file, so what restore.bat shares with backup.bat is a COPY, and it must be
 * the same copy — a fix to backup.bat's docker launch has to land in both.
 */
describe("restore.bat (static checks; executed only by the Windows CI job)", () => {
  const raw = fs.readFileSync(path.join(ROOT, "restore.bat"));
  const text = raw.toString("utf8");
  const code = text.split("\r\n").filter((l) => !l.startsWith("::"));
  const backup = fs.readFileSync(path.join(ROOT, "backup.bat"), "utf8");
  const backupCode = backup.split("\r\n").filter((l) => !l.startsWith("::"));
  const powershellStep = (lines: string[]) => lines.filter((l) => l.startsWith('powershell -NoProfile -Command "'));
  const sharedTail = (t: string) => t.slice(t.indexOf(":: :env_value KEY - the value of KEY"));

  it("is pure ASCII with CRLF line endings throughout (.gitattributes: *.bat eol=crlf)", () => {
    expect(raw.every((b) => b < 0x80)).toBe(true);
    expect(text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("starts docker through backup.bat's PowerShell step, character for character, and :env_value / :require_compose are backup.bat's too", () => {
    expect(powershellStep(code)).toHaveLength(1);
    expect(powershellStep(backupCode)).toHaveLength(1);
    expect(powershellStep(code)[0]).toBe(powershellStep(backupCode)[0]);
    // It is the ONLY way restore.bat hands anything to a program on stdin, and it runs with backup.bat's "ask once" mode.
    // Ruling R27: ONE call, so one PowerShell process and one passphrase prompt for both programs.
    expect(code.filter((l) => l.includes("call :run_with_passphrase"))).toEqual(["call :run_with_passphrase"]);
    const at = code.indexOf(":run_with_passphrase");
    expect(code.slice(at, at + 4)).toEqual([":run_with_passphrase", powershellStep(backupCode)[0], 'set "BV_RC=!errorlevel!"', "goto :eof"]);
    expect(code).toContain('set "BV_MODE=verify"');
    expect(code.filter((l) => /^set "BV_MODE=/.test(l))).toEqual(['set "BV_MODE=verify"']);
    expect(code).toContain('set "BV_LIMIT="');
    expect(sharedTail(text).length).toBeGreaterThan(1500);
    expect(sharedTail(text)).toBe(sharedTail(backup));
  });

  it("never reads the passphrase into a cmd variable: `set /p` only reads the typed RESTORE and the snapshot marker", () => {
    expect(code.filter((l) => /set\s+\/p/i.test(l))).toEqual([
      'set /p "BV_CONFIRM=Type RESTORE to continue: "',
      'if exist "backups\\.uploads-snapshot-marker" set /p BV_UPLOADS_SNAPSHOT=<"backups\\.uploads-snapshot-marker"',
    ]);
    const uses = code.filter((l) => l.includes("BV_PASSFILE") && !l.trimStart().startsWith(">&2 echo") && !l.startsWith("powershell "));
    for (const l of uses) expect(l).toMatch(/^(set "BV_PASSFILE=(%~f2)?"|if (not )?(defined BV_PASSFILE|exist "!BV_PASSFILE!\\?") goto :\w+|for %%F in \("!BV_PASSFILE!"\) do if %%~zF EQU 0 goto :passfile_empty)$/);
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });

  it("the steps are in the spec's order, and the two program calls match restore.sh's (no --user, no --no-deps; the restore container is named)", () => {
    // Ruling R27: the check and the restore are the first and second call of ONE PowerShell step, with
    // :prepare_phase (confirm, stop, snapshot, recovery file) run by that step in between, in a child cmd.exe.
    const order = [
      'if not exist "backups\\restore-*-RECOVERY.txt" goto :no_recovery_pending',
      'set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify !BV_FILE_NAME!"',
      'set "BV_DOCKER_ARGS_2=compose run --rm -T --name !BV_CONTAINER! blackvault node dist/scripts/full-restore.mjs --stamp !BV_STAMP! !BV_FILE_NAME!"',
      'set "BV_BETWEEN=!BV_SELF!"',
      'set "BV_RESTORE_PHASE=prepare"',
      "call :run_with_passphrase",
      "goto :programs_returned",
      ":prepare_phase",
      'set /p "BV_CONFIRM=Type RESTORE to continue: "',
      'if exist "!BV_HOST_UPLOADS!\\.pre-restore-!BV_STAMP!" goto :stamp_taken', // a taken time stamp is refused before the stop
      "%COMPOSE% stop blackvault 1>&2",
      'call scripts\\db-snapshot.bat > "!BV_SNAP_LOG!" 2>&1',
      "call :write_recovery",
      '>>"!BV_HANDOFF!" echo ready=1',
      "exit /b 0",
      ":programs_returned",
      ":rollback",
    ].map((l) => code.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // BV_SELF must be this script: arguments are shifted with `shift /1` only, and %~f0 is read BEFORE the
    // first `cd /d` (after it, cmd.exe re-resolves a quoted relative %0 against the new folder) and nowhere else.
    expect(code.filter((l) => /^\s*shift\b/i.test(l))).toEqual(Array(4).fill("shift /1"));
    const firstCd = code.indexOf('cd /d "%~dp0"');
    expect(code[firstCd - 1]).toBe('set "BV_SELF=%~f0"');
    expect(code.filter((l) => l.includes("%~f0"))).toEqual(['set "BV_SELF=%~f0"']);
    expect(code.indexOf('set "BV_BETWEEN=!BV_SELF!"')).toBeGreaterThan(firstCd);
    // backup.bat and reencrypt-files.bat read the script's path once, for their own `cd /d`, and never after it.
    for (const file of ["backup.bat", "reencrypt-files.bat"]) {
      const other = fs.readFileSync(path.join(ROOT, file), "utf8").split("\r\n").filter((l) => !l.startsWith("::"));
      expect(other.filter((l) => /%~[a-z]*0/i.test(l)), file).toEqual(['cd /d "%~dp0"']);
    }
    // The child is entered only through BV_RESTORE_PHASE, checked before anything else runs.
    expect(code.filter((l) => l !== "")[1]).toBe("if defined BV_RESTORE_PHASE goto :prepare_phase");
    // The PowerShell step: the second call only after the first and the step in between both exited 0;
    // the check's standard output goes to standard error, so standard output holds the restore's line only.
    const ps = powershellStep(code)[0];
    expect(ps).toContain("for ($i = 0; $i -lt $calls.Count; $i++) { if ($i -eq 1) { $between = New-Object Diagnostics.ProcessStartInfo; $between.FileName = $env:ComSpec;");
    expect(ps).toContain("$b.WaitForExit(); if ($b.ExitCode -ne 0) { exit 1 } };");
    expect(ps).toContain("if ($p.ExitCode -ne 0) { exit $p.ExitCode } }; exit 0 }");
    expect(ps).toContain("$toErr = ($calls.Count -gt 1) -and ($i -eq 0); if ($toErr) { $psi.RedirectStandardOutput = $true }");
    // How far it got comes back in the handoff file: no file = the check failed; no `ready` = the step in between stopped.
    const back = code.indexOf(":programs_returned");
    expect(code.slice(back + 5, back + 13)).toEqual([
      'if exist "!BV_HANDOFF!" for /f "usebackq tokens=1,* delims==" %%A in ("!BV_HANDOFF!") do set "BV_H_%%A=%%B"',
      'del /f /q "!BV_HANDOFF!" >nul 2>&1',
      "if defined BV_H_ready goto :restore_ran",
      "if defined BV_H_phase exit /b 1",
      ">&2 echo ERROR: the backup !BV_FILE_NAME! did not pass the check (the reason is on the line above). Nothing was changed; BlackVault was not stopped.",
      "exit /b 1",
      ":restore_ran",
      'set "BV_DB_SNAPSHOT=!BV_H_db!"',
    ]);
    // Nothing secret is written there: the three handoff lines are the phase, two snapshot paths and `ready`.
    expect(code.filter((l) => l.includes('"!BV_HANDOFF!" echo'))).toEqual(['>"!BV_HANDOFF!" echo phase=prepare', '>>"!BV_HANDOFF!" echo db=!BV_DB_SNAPSHOT!', '>>"!BV_HANDOFF!" echo uploads=!BV_UPLOADS_SNAPSHOT!', '>>"!BV_HANDOFF!" echo ready=1']);
    expect(code).toContain('set "BV_CONTAINER=blackvault-restore-!BV_STAMP!"');
    const sh = fs.readFileSync(path.join(ROOT, "restore.sh"), "utf8");
    expect(sh).toContain('CMD=($COMPOSE run --rm -T blackvault node dist/scripts/full-backup.mjs --verify "$NAME")');
    expect(sh).toContain('CMD=($COMPOSE run --rm -T --name "$CONTAINER" blackvault node dist/scripts/full-restore.mjs --stamp "$STAMP" "$NAME")');
    expect(sh).toContain('CONTAINER="blackvault-restore-$STAMP"');
  });

  it("a running full backup is not killed: the running app is asked for the lock after the confirmation and before the stop, as restore.sh does", () => {
    const at = code.indexOf('set "BV_RUNNING="');
    expect(code.slice(at, at + 13)).toEqual([
      'set "BV_RUNNING="',
      'for /f "usebackq delims=" %%I in (`%COMPOSE% ps --status running -q blackvault 2^>nul`) do set "BV_RUNNING=1"',
      "if not defined BV_RUNNING goto :lock_checked",
      // Its standard output goes to standard error (standard output is the restore program's line only); it is given no standard input.
      "%COMPOSE% exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs --lock-status 1>&2 <nul",
      'set "BV_LOCK_RC=!errorlevel!"',
      'if "!BV_LOCK_RC!"=="0" goto :lock_checked',
      'if "!BV_LOCK_RC!"=="2" goto :lock_held',
      ">&2 echo WARNING: could not check whether a full backup is running (exit !BV_LOCK_RC!; an image from before this check answers like that). If one is running, stopping BlackVault ends it. Going on with the restore.",
      "goto :lock_checked",
      ":lock_held",
      ">&2 echo ERROR: a full backup is running (the line above names it), so the restore did not start. Nothing was changed; BlackVault was not stopped. Run the restore again when the backup has finished.",
      "exit /b 1",
      ":lock_checked",
    ]);
    // In the child phase: after RESTORE was typed and the time stamp was found free, before the stop.
    const order = [":prepare_phase", 'set /p "BV_CONFIRM=Type RESTORE to continue: "', ":stamp_free", 'set "BV_RUNNING="', ":lock_checked", "%COMPOSE% stop blackvault 1>&2"].map((l) => code.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The same call and the same two messages as restore.sh.
    const sh = fs.readFileSync(path.join(ROOT, "restore.sh"), "utf8");
    expect(sh).toContain("$($COMPOSE exec -T -u 1001:1001 blackvault node dist/scripts/full-backup.mjs --lock-status < /dev/null 2>&1)");
    for (const l of code.slice(at, at + 13).filter((x) => x.startsWith(">&2 echo "))) {
      expect(sh).toContain(l.slice(">&2 echo ".length).replace(/^(ERROR|WARNING): /, "").replace("!BV_LOCK_RC!", "$LOCK_RC").replace(/^could not/, "WARNING: could not"));
    }
  });

  it("the handoff's `ready` line is looked for in the file before the child phase says 'go on': if the write failed, the restore never runs", () => {
    // The script the user started takes `ready` to mean "the restore program ran". If the append failed and the child
    // still exited 0, the restore would run and its result would be thrown away: no start, no rollback, no message.
    const at = code.indexOf('>>"!BV_HANDOFF!" echo ready=1');
    expect(code.slice(at, at + 11)).toEqual([
      '>>"!BV_HANDOFF!" echo ready=1',
      'findstr /x /c:"ready=1" "!BV_HANDOFF!" >nul 2>&1',
      "if errorlevel 1 goto :handoff_failed",
      ">&2 echo Restoring !BV_FILE_NAME!. A large backup can take a while...",
      "exit /b 0",
      // Nothing was changed yet: the recovery file must not stay (it would block the next restore), and BlackVault is started again.
      ":handoff_failed",
      'del /f /q "!BV_RECOVERY!" >nul 2>&1',
      'if exist "!BV_RECOVERY!" >&2 echo WARNING: could not delete !BV_RECOVERY!; delete it by hand, or the next restore will refuse to start.',
      "call :start_app_or_warn",
      ">&2 echo ERROR: could not write to !BV_HANDOFF! (its ready line is missing), so the restore did not start. Nothing was changed.",
      "exit /b 1",
    ]);
    // It is the child phase's ONLY way to say "go on".
    const phase = code.slice(code.indexOf(":prepare_phase"), code.indexOf(":programs_returned"));
    expect(phase.filter((l) => /^exit \/b 0$/.test(l.trim()))).toHaveLength(1);
    expect(phase.filter((l) => /exit \/b 0/.test(l))).toEqual(["exit /b 0"]);
    // …and PowerShell starts the restore only when the child exited 0.
    expect(powershellStep(code)[0]).toContain("$b.WaitForExit(); if ($b.ExitCode -ne 0) { exit 1 } };");
  });

  it("R24: the database is put back only when the marker exists; an uploads folder that is not there to look into rolls NOTHING back; the uploads go first; the marker is cleared last", () => {
    // The gate, in the order it is evaluated: complete < started < unknown (a missing uploads folder; Task 7 re-review item 3).
    const at = code.indexOf('set "BV_STATE=untouched"');
    expect(code.slice(at, at + 8)).toEqual([
      'set "BV_STATE=untouched"',
      'if exist "!BV_HOST_UPLOADS!\\.pre-restore-!BV_STAMP!\\images\\" set "BV_STATE=complete"',
      'if exist "!BV_HOST_UPLOADS!\\.pre-restore-!BV_STAMP!\\documents\\" set "BV_STATE=complete"',
      'if exist "!BV_MARKER!\\" set "BV_STATE=started"',
      'if not exist "!BV_HOST_UPLOADS!\\" set "BV_STATE=unknown"',
      'if "!BV_STATE!"=="unknown" goto :state_unknown',
      'if not "!BV_STATE!"=="complete" goto :rollback',
      ">&2 echo WARNING: the restore program ended with exit !BV_RC!, but it had FINISHED: its marker is gone and the previous folders are in .pre-restore-!BV_STAMP!. Nothing is rolled back. Its BLACKVAULT_FULL_RESTORE_OK line and the RESTORE entry in the audit log may be missing.",
    ]);
    expect(code).toContain('set "BV_MARKER=!BV_HOST_UPLOADS!\\.restore-!BV_STAMP!.db-started"');
    // unknown: one line that says so, then straight to the "not started, here is the recovery file" ending - no rollback command, no `up -d`.
    const unknown = code.indexOf(":state_unknown");
    expect(code.slice(unknown, unknown + 6).filter((l) => l !== "")).toEqual([
      ":state_unknown",
      ">&2 echo.",
      ">&2 echo The restore failed (exit !BV_RC!; the reason is above), and how far it got could not be found out: the uploads folder !BV_HOST_UPLOADS! is not there to look into. Nothing is rolled back blindly.",
      ":rollback_failed",
      ">&2 echo ERROR: the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started. What to do is in !CD!\\!BV_RECOVERY!:",
    ]);
    const container = '%COMPOSE% run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\\backups:/bv-backups:ro" -v "!CD!\\scripts\\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh';
    const psql = "%COMPOSE% exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault";
    const expected = [
      `${container} uploads /app/uploads !BV_STAMP! !BV_UPLOADS_ARG! 1>&2`,
      'if not "!BV_STATE!"=="started" goto :rollback_checked',
      `${psql} -d postgres -c "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault" 1>&2`,
      `${psql} -d blackvault_rollback --single-transaction -f - < "!BV_DB_SNAPSHOT!" >nul`,
      `${psql} -d postgres -c "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault" 1>&2`,
      `${container} sqlite /bv-backups/!BV_DB_SNAPSHOT_NAME! /app/data/vault.db /app/uploads !BV_STAMP! 1>&2`, // the script refuses unless the marker exists (R28)
      ":rolled_back",
      'if not "!BV_STATE!"=="started" goto :marker_cleared',
      `${container} clear-marker /app/uploads !BV_STAMP! 1>&2`,
    ].map((l) => code.indexOf(l));
    expect(expected.every((i) => i > code.indexOf(":rollback"))).toBe(true);
    expect([...expected].sort((a, b) => a - b)).toEqual(expected);
    // After a failed rollback the app is not started: no `up -d` between :rollback and :rolled_back except PostgreSQL's `up -d --wait db`.
    const ups = code.map((l, i) => (l === "%COMPOSE% up -d 1>&2" ? i : -1)).filter((i) => i >= 0);
    expect(ups.filter((i) => i > code.indexOf(":rollback") && i < code.indexOf(":rolled_back"))).toEqual([]);
    expect(ups.some((i) => i > code.indexOf(":rolled_back") && i < code.indexOf(":start_app_or_warn"))).toBe(true);
    // The script the container runs must reach Windows checkouts with LF endings.
    expect(fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8")).toContain("scripts/snapshot-restore.sh text eol=lf");
  });

  it("R25: the recovery file is written before the restore, deleted on success and after a good rollback, kept and shown after a failed one; it holds restore.sh's steps", () => {
    const write = code.slice(code.indexOf(":write_recovery"), code.indexOf(":run_with_passphrase"));
    const text = write.filter((l) => l.startsWith('>>"!BV_RECOVERY!" echo')).map((l) => l.slice('>>"!BV_RECOVERY!" echo'.length).replace(/^[. ]/, ""));
    expect(text).toContain("  docker stop !BV_CONTAINER!");
    expect(text).toContain("  docker ps -a --filter name=!BV_CONTAINER!");
    // Task 7 re-review, new breakage 1: step 3 is ONE command line joined with && (written ^&^& for echo),
    // so clear-marker runs only if every part before it worked - and the text says so in words.
    const up = "!BV_RB! uploads /app/uploads !BV_STAMP! !BV_UPLOADS_ARG!";
    const clear = "!BV_RB! clear-marker /app/uploads !BV_STAMP!";
    const pg = "!BV_PSQL! -d postgres -c";
    expect(text).toContain(`  ${up} ^&^& !BV_RB! sqlite /bv-backups/!BV_DB_SNAPSHOT_NAME! /app/data/vault.db /app/uploads !BV_STAMP! ^&^& ${clear}`);
    // PostgreSQL: psql is guarded by no script, so the line's FIRST link asks for the state (step 2's own command, in
    // a `for /f`) and everything else is the body of `if "%S"=="started"`: in any other state nothing runs. Written
    // %%S here because this is a batch file; the recovery file, and so the Command Prompt, gets %S.
    const ifStarted = `for /f %%S in ('!BV_RB! state /app/uploads !BV_STAMP!') do if "%%S"=="started" `;
    expect(text).toContain(
      `  ${ifStarted}${up} ^&^& docker compose up -d --wait db ^&^& ${pg} "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault" ^&^& !BV_PSQL! -d blackvault_rollback --single-transaction -f - ^< "!BV_DB_SNAPSHOT!" ^&^& ${pg} "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault" ^&^& ${clear}`,
    );
    expect(text).toContain(`  ${up}`); // PostgreSQL, untouched or complete: the uploads line by itself
    // clear-marker is never a line of its own, and never follows anything but "&& ".
    for (const l of text.filter((x) => x.includes("clear-marker"))) expect(l.endsWith(` ^&^& ${clear}`)).toBe(true);
    expect(text.filter((x) => x.includes("clear-marker"))).toHaveLength(2);
    expect(text.filter((x) => x.includes("only if every part before it worked, so the marker is cleared"))).toHaveLength(2);
    expect(text.filter((x) => x.includes("never run its last part by"))).toHaveLength(2);
    expect(text.join("\n")).not.toContain("Run every line, in this order");
    // R28: the three states, looked up first; the sentence that was false after a finished restore is gone.
    expect(text.indexOf("  !BV_RB! state /app/uploads !BV_STAMP!")).toBeGreaterThan(0);
    expect(text.indexOf("  !BV_RB! state /app/uploads !BV_STAMP!")).toBeLessThan(text.indexOf("  !BV_RB! uploads /app/uploads !BV_STAMP! !BV_UPLOADS_ARG!"));
    for (const word of ["   complete   ", "   started    ", "   untouched  "]) expect(text.some((l) => l.startsWith(word))).toBe(true);
    expect(text).toContain("   PostgreSQL: the next line ONLY if step 2 printed: started");
    expect(text).toContain("   The line asks for the state again first, and does nothing unless the");
    // The state test is on the PostgreSQL chain only (the SQLite chain's parts check the state themselves), and nothing but that line uses a for variable.
    expect(text.filter((x) => x.includes("%%"))).toHaveLength(1);
    expect(text.filter((x) => x.includes("%%"))[0].startsWith(`  ${ifStarted}!BV_RB! uploads `)).toBe(true);
    expect(text.join("\n")).not.toContain("the database was never touched: skip to step 4");
    // …and its wording is restore.sh's, line for line, for the state block.
    const sh = fs.readFileSync(path.join(ROOT, "restore.sh"), "utf8");
    for (const l of text.filter((x) => /^ {3}(complete|started|untouched) |^ {14}\S/.test(x))) expect(sh, l).toContain(`echo "${l}"`);
    expect(text.some((l) => l.includes(' -f - ^< "!BV_DB_SNAPSHOT!" ^&^& '))).toBe(true); // the dump path is quoted, the < escaped for echo
    expect(text.join("\n")).toContain("A batch file cannot catch Ctrl-C or a closed");
    // Paths in the commands are quoted (a checkout path with spaces).
    expect(write).toContain('set "BV_RB=docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\\backups:/bv-backups:ro" -v "!CD!\\scripts\\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh"');
    // No exclamation mark in the text itself: with delayed expansion on it would be eaten.
    for (const l of text) expect(l.replace(/!BV_[A-Z_]+!|!CD!/g, "")).not.toContain("!");
    // Every & in the text is escaped for echo (an unescaped one would end the echo and run the rest), and none sits inside a quoted string.
    for (const l of text) {
      expect(l.replace(/\^&/g, "")).not.toContain("&");
      for (const quoted of l.match(/"[^"]*"/g) ?? []) expect(quoted).not.toContain("&");
    }
    // Deleted in exactly two places (success / completed, and after a good rollback); never between :rollback and :rolled_back.
    const dels = code.map((l, i) => (l === 'del /f /q "!BV_RECOVERY!" >nul 2>&1' ? i : -1)).filter((i) => i >= 0);
    expect(dels).toHaveLength(4); // + the one that clears a stale file before writing, + the one after a handoff that could not be written (nothing was changed yet)
    expect(dels.filter((i) => i > code.indexOf(":rollback") && i < code.indexOf(":rolled_back"))).toEqual([]);
    expect(code.indexOf('type "!BV_RECOVERY!" 1>&2')).toBeGreaterThan(0);
    expect(code.filter((l) => l === 'type "!BV_RECOVERY!" 1>&2')).toHaveLength(2); // before the restore, and after a failed rollback
  });

  it("every for /f character check on a user value is guarded against a ';' anywhere in it, and it never pauses", () => {
    const at = code.findIndex((l) => l.startsWith('for /f "delims=') && l.includes('("!BV_FILE_NAME!")'));
    expect(at).toBeGreaterThan(0);
    expect(code[at].endsWith("do goto :file_bad_name")).toBe(true);
    expect(code[at - 1]).toBe('if not "!BV_FILE_NAME:;=!"=="!BV_FILE_NAME!" goto :file_bad_name');
    expect(code.filter((l) => /^for \/f "delims=[^"]+" %%X in \("!BV_/.test(l))).toHaveLength(1);
    expect(code.filter((l) => /^\s*pause\b/i.test(l))).toEqual([]);
  });

  it("the Windows harness runs it (RS1–RS19) and prints the script's output and the docker calls whenever a check fails", () => {
    const harness = fs.readFileSync(path.join(ROOT, "scripts/ci/windows/Test-WindowsInstallers.ps1"), "utf8");
    for (let i = 1; i <= 19; i++) expect(harness).toContain(`scenario RS${i}\r\n`);
    const section = harness.slice(harness.indexOf("# restore.bat (full restore, Task 7)"), harness.indexOf("# reencrypt-files.bat (Task 8)"));
    const runs = section.match(/^\s*\$r = Invoke-Restore /gm) ?? [];
    const evidence = section.match(/^\s*Show-EvidenceIfFailed \$r/gm) ?? [];
    expect(runs.length).toBeGreaterThanOrEqual(22);
    expect(evidence.length).toBe(runs.length);
    const stub = fs.readFileSync(path.join(ROOT, "scripts/ci/windows/docker-stub.cs"), "utf8");
    expect(stub).toContain('"dist/scripts/full-restore.mjs"');
    expect(stub).toContain('"/bv-snapshot-restore.sh"');
    expect(stub).toContain('"--lock-status"');
    // RS18 runs the recovery file's PostgreSQL line as printed, at a command prompt, in each of the three states.
    expect(section).toContain("function Invoke-CmdLine(");
    expect(section).toContain('foreach ($state in @("complete", "untouched")) {');
    expect(section).toContain('$c = Invoke-CmdLine $d $chain "started"');
    expect(stub).toContain('"BV_STUB_STATE_ANSWER"');
    // RS19 makes the handoff append fail (the stub marks the file read-only while the child phase runs).
    expect(stub).toContain('"BV_STUB_HANDOFF_READONLY"');
    expect(section).toContain('"BV_STUB_HANDOFF_READONLY" = "1"');
  });
});
