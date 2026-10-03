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
 * (scenarios RS1–RS8) and by the static checks at the end of this file.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const isWindows = process.platform === "win32";
const has = (cmd: string) => !isWindows && spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
const hasPython = has("python3");

const PASS = " restore tëst 'pass' \"phrase\" $HOME `id` \\n * ";
const NAME = "blackvault-full-20261002-180405.bvb";
const OK_LINE = `BLACKVAULT_FULL_RESTORE_OK file=${NAME} files=2 bytes=10 pre_restore=.pre-restore-20261003-000000`;
const VERIFY = `compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify ${NAME}`;
const RESTORE = /^compose run --rm -T blackvault node dist\/scripts\/full-restore\.mjs --stamp (\d{8}-\d{6}) blackvault-full-20261002-180405\.bvb$/;
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
  case " $* " in *" $BV_STUB_FAIL_ON "*) echo "[stub] failing on purpose: $*" >&2; exit 1 ;; esac
fi
dd=$(sed -n 's/^DATA_DIR=//p' .env | tail -n 1); dd=\${dd:-./data}
# Container paths → the scratch install.
map() { case "$1" in /bv-backups/*) echo "backups/\${1#/bv-backups/}" ;; /app/data/*) echo "$dd/db/\${1#/app/data/}" ;; /app/uploads) echo "$dd/uploads" ;; *) echo "$1" ;; esac; }
case "$*" in
  "compose version --short") echo "\${BV_STUB_COMPOSE_VERSION-2.30.1}" ;;
  "compose config --images blackvault") echo "blackvault-blackvault" ;;
  *"/bv-uploads-snapshot.sh /app/uploads /bv-backups "*)
    for a in "$@"; do name=$a; done
    sh scripts/uploads-snapshot.sh "$dd/uploads" backups "$name"; exit $? ;;
  *"/bv-snapshot-restore.sh "*)
    [ "\${BV_STUB_ROLLBACK:-}" = fail ] && { echo "ERROR: could not restore from the snapshot: [stub] refused" >&2; exit 1; }
    args=(); seen=0
    for a in "$@"; do
      if [ "$seen" = 1 ]; then args+=("$(map "$a")"); fi
      [ "$a" = "/bv-snapshot-restore.sh" ] && seen=1
    done
    sh scripts/snapshot-restore.sh "\${args[@]}"; exit $? ;;
  *"dist/scripts/full-backup.mjs --verify"*)
    cat > "${rec}/stdin-verify"
    [ "\${BV_STUB_VERIFY_EXIT:-0}" = 0 ] && echo "BLACKVAULT_FULL_BACKUP_VERIFIED file=${NAME} files=2 bytes=10 archive_bytes=99"
    [ "\${BV_STUB_VERIFY_EXIT:-0}" != 0 ] && echo "full-backup: Wrong passphrase, or the backup is damaged." >&2
    exit "\${BV_STUB_VERIFY_EXIT:-0}" ;;
  *"dist/scripts/full-restore.mjs"*)
    cat > "${rec}/stdin-restore"
    stamp=""; prev=""; for a in "$@"; do [ "$prev" = "--stamp" ] && stamp=$a; prev=$a; done
    case "\${BV_STUB_RESTORE:-ok}" in
      ok) echo "${OK_LINE}"; exit 0 ;;
      refuse) echo "full-restore: [stub] refused. Nothing was changed." >&2; exit 1 ;;
      crash)
        # What a restore killed mid-way leaves behind.
        printf 'REPLACED BY THE FAILED RESTORE' > "$dd/db/vault.db"
        printf 'hot journal' > "$dd/db/vault.db-journal"
        mkdir -p "$dd/uploads/.restore-$stamp/documents" "$dd/uploads/.pre-restore-$stamp"
        printf 'staged' > "$dd/uploads/.restore-$stamp/documents/from-backup.pdf"
        mv "$dd/uploads/images" "$dd/uploads/.pre-restore-$stamp/images"
        mkdir -p "$dd/uploads/images"
        printf 'restored' > "$dd/uploads/images/from-backup.jpg"
        printf 'damaged' > "$dd/uploads/documents/doc1.pdf"
        echo "full-restore: [stub] killed." >&2; exit 137 ;;
    esac ;;
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
/** Calls without the Compose version probe (restore.sh and db-snapshot.sh each make one). */
const steps = () => calls().filter((c) => c !== "compose version --short");

function run(args: string[], opts: RunOpts = {}) {
  const r = spawnSync("bash", [path.join(app, "restore.sh"), ...args], {
    cwd: opts.cwd ?? app,
    env: baseEnv(opts.env),
    encoding: "utf8",
    timeout: 60_000,
    ...(opts.devNull ? { stdio: ["ignore", "pipe", "pipe"] as const } : { input: "" }),
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function runOnTty(args: string[], answers: string[], env: Record<string, string> = {}) {
  const helper = path.join(tmp, "pty-helper.py");
  fs.writeFileSync(helper, PTY_HELPER);
  const answersFile = path.join(tmp, "answers");
  fs.writeFileSync(answersFile, answers.join("\n"));
  const r = spawnSync("python3", [helper, answersFile, "bash", path.join(app, "restore.sh"), ...args], { cwd: app, env: baseEnv(env), encoding: "utf8", timeout: 60_000 });
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
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(isWindows)("restore.sh", () => {
  describe("the command sequence", () => {
    it("success (SQLite): verify → stop → snapshot → restore → start, in exactly that order; stdout is the restore program's one line", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe(`${OK_LINE}\n`);
      const s = steps();
      const stamp = RESTORE.exec(s[6])?.[1];
      expect(stamp, s.join("\n")).toBeDefined();
      const snap = s[5].split(" ").at(-1)!;
      expect(s).toEqual([
        VERIFY,
        "compose stop blackvault",
        // scripts/db-snapshot.sh (SQLite stops the app itself too, then copies the file; then the uploads, in a container)
        "compose stop blackvault",
        "compose config --images blackvault",
        "image inspect blackvault-blackvault",
        `compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${app}/backups:/bv-backups -v ${app}/scripts/uploads-snapshot.sh:/bv-uploads-snapshot.sh:ro blackvault /bv-uploads-snapshot.sh /app/uploads /bv-backups ${snap}`,
        `compose run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp ${stamp} ${NAME}`,
        "compose up -d",
      ]);
      // No --user / --no-deps on the two program calls: the entrypoint places the key as root; PostgreSQL must be up.
      expect(s[0]).not.toMatch(/--user|--no-deps/);
      expect(s[6]).not.toMatch(/--user|--no-deps/);
      // The snapshot exists, the marker is gone, and the output names both.
      const backups = fs.readdirSync(path.join(app, "backups")).sort();
      expect(backups).toEqual([expect.stringMatching(/^blackvault-\d{8}-\d{6}\.db$/), snap]);
      expect(r.stderr).toContain(`.pre-restore-${stamp}/`);
      expect(r.stderr).toContain(`backups/${backups[0]} and backups/${snap}`);
    });

    it("the passphrase file's bytes reach BOTH programs on stdin unchanged, and the passphrase is in no argv, environment or process list", () => {
      const bytes = Buffer.from(`${PASS}\r\n\n`, "utf8");
      const r = run([NAME, "--yes", "--passphrase-file", passFile(bytes)]);
      expect(r.code, r.stderr).toBe(0);
      expect(fs.readFileSync(path.join(rec, "stdin-verify")).equals(bytes)).toBe(true);
      expect(fs.readFileSync(path.join(rec, "stdin-restore")).equals(bytes)).toBe(true);
      expectPassphraseOnlyOnStdin();
    });

    it("a FAILING restore (SQLite): … → restore → rollback database → rollback uploads → start; exit 1; the install is byte-identical to before", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash" } });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      const s = steps();
      const stamp = RESTORE.exec(s[6])?.[1];
      const dbSnap = fs.readdirSync(path.join(app, "backups")).find((n) => n.endsWith(".db"))!;
      const upSnap = fs.readdirSync(path.join(app, "backups")).find((n) => n.startsWith("uploads-"))!;
      const rollback = `compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${app}/backups:/bv-backups:ro -v ${app}/scripts/snapshot-restore.sh:/bv-snapshot-restore.sh:ro blackvault /bv-snapshot-restore.sh`;
      expect(s.slice(6)).toEqual([
        `compose run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp ${stamp} ${NAME}`,
        `${rollback} sqlite /bv-backups/${dbSnap} /app/data/vault.db`,
        `${rollback} uploads /app/uploads ${stamp} /bv-backups/${upSnap}`,
        "compose up -d",
      ]);
      // Byte-identical: the database file, every upload (the .tmp work file included), no journal, no .restore-/.pre-restore- folder.
      expect(install()).toEqual(before);
      expect(r.stderr).toContain("Moved the previous images folder back into place.");
      expect(r.stderr).toContain("copied back from the snapshot: documents/doc1.pdf");
      expect(lines(r.stderr).at(-1)).toBe(
        `ERROR: the restore failed (the reason is above). The database and the uploads were put back from the snapshot taken before it (backups/${dbSnap}), so nothing is changed. BlackVault was started again.`,
      );
    });

    it("a restore the program refuses cleanly (exit 1): the snapshot is still put back, and the app started", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "refuse" } });
      expect(r.code).toBe(1);
      expect(steps().filter((c) => c.includes("/bv-snapshot-restore.sh")).map((c) => c.split("/bv-snapshot-restore.sh ")[1].split(" ")[0])).toEqual(["sqlite", "uploads"]);
      expect(steps().at(-1)).toBe("compose up -d");
      expect(install()).toEqual(before);
    });

    it("the rollback itself fails: BlackVault is NOT started, and the output says where the snapshot is and exactly what to run", () => {
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_ROLLBACK: "fail" } });
      expect(r.code).toBe(1);
      expect(steps()).not.toContain("compose up -d");
      const dbSnap = fs.readdirSync(path.join(app, "backups")).find((n) => n.endsWith(".db"))!;
      const upSnap = fs.readdirSync(path.join(app, "backups")).find((n) => n.startsWith("uploads-"))!;
      const stamp = RESTORE.exec(steps()[6])![1];
      expect(r.stderr).toContain("ERROR: the restore failed AND the automatic rollback failed (see above). The install may be half restored. BlackVault was NOT started.");
      expect(r.stderr).toContain(`database: backups/${dbSnap}`);
      expect(r.stderr).toContain(`uploads:  backups/${upSnap}`);
      const rollback = `docker compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${app}/backups:/bv-backups:ro -v ${app}/scripts/snapshot-restore.sh:/bv-snapshot-restore.sh:ro blackvault /bv-snapshot-restore.sh`;
      expect(r.stderr).toContain(`${rollback} sqlite /bv-backups/${dbSnap} /app/data/vault.db`);
      expect(r.stderr).toContain(`${rollback} uploads /app/uploads ${stamp} /bv-backups/${upSnap}`);
      expect(r.stderr).toContain("docker compose up -d");
      // The snapshot itself is intact.
      expect(fs.readFileSync(path.join(app, "backups", dbSnap), "utf8")).toBe("the database as it was before the restore");
    });

    it("the printed manual commands really work: run by hand after a failed rollback, they return the install to before", () => {
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "crash", BV_STUB_ROLLBACK: "fail" } });
      expect(r.code).toBe(1);
      expect(install()).not.toEqual(before);
      const commands = lines(r.stderr).map((l) => l.trim()).filter((l) => l.startsWith("docker compose run") && l.includes("/bv-snapshot-restore.sh"));
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        const done = spawnSync("bash", ["-c", command], { cwd: app, env: baseEnv(), encoding: "utf8", timeout: 60_000 });
        expect(done.status, done.stderr).toBe(0);
      }
      expect(install()).toEqual(before);
    });

    it("PostgreSQL: the snapshot is a pg_dump; a failing restore loads it into a NEW database in one transaction, then swaps it in", () => {
      fs.rmSync(path.join(app, "data"), { recursive: true });
      seedInstall("postgres");
      const before = install();
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "refuse" } });
      expect(r.code).toBe(1);
      const s = steps();
      const at = s.findIndex((c) => RESTORE.test(c));
      const stamp = RESTORE.exec(s[at])![1];
      const upSnap = fs.readdirSync(path.join(app, "backups")).find((n) => n.startsWith("uploads-"))!;
      const psql = "compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault";
      expect(s.slice(0, at)).toEqual(expect.arrayContaining(["compose up -d --wait db", "compose exec -T db pg_dump -U blackvault -d blackvault"]));
      expect(s.slice(at + 1)).toEqual([
        "compose up -d --wait db",
        `${psql} -d postgres -c DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE) -c CREATE DATABASE blackvault_rollback OWNER blackvault`,
        `${psql} -d blackvault_rollback --single-transaction -f -`,
        `${psql} -d postgres -c DROP DATABASE IF EXISTS blackvault WITH (FORCE) -c ALTER DATABASE blackvault_rollback RENAME TO blackvault`,
        `compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${app}/backups:/bv-backups:ro -v ${app}/scripts/snapshot-restore.sh:/bv-snapshot-restore.sh:ro blackvault /bv-snapshot-restore.sh uploads /app/uploads ${stamp} /bv-backups/${upSnap}`,
        "compose up -d",
      ]);
      expect(read("psql-stdin")).toBe("-- stub pg_dump of blackvault\n"); // the dump, on the loading psql's stdin
      expect(install()).toEqual(before);
    });

    it("PostgreSQL: if the dump does not load, the live database is never dropped; BlackVault is not started and the manual commands are printed", () => {
      fs.rmSync(path.join(app, "data"), { recursive: true });
      seedInstall("postgres");
      const r = run([NAME, "--yes", "--passphrase-file", passFile()], { env: { BV_STUB_RESTORE: "refuse", BV_STUB_FAIL_ON: "--single-transaction" } });
      expect(r.code).toBe(1);
      expect(read("calls")).not.toContain("DROP DATABASE IF EXISTS blackvault WITH");
      expect(steps()).not.toContain("compose up -d");
      expect(r.stderr).toContain("ERROR: the restore failed AND the automatic rollback failed");
      expect(r.stderr).toMatch(/docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault -d blackvault_rollback --single-transaction -f - < backups\/blackvault-\d{8}-\d{6}\.sql/);
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
      expect(steps()).toEqual([VERIFY, "compose stop blackvault"]);
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
      expect(steps().slice(0, 2)).toEqual([VERIFY, "compose stop blackvault"]);
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
 * (scripts/ci/windows/Test-WindowsInstallers.ps1, scenarios RS1–RS8). These
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

  it("the steps are in the spec's order, and the two program calls match restore.sh's (no --user, no --no-deps)", () => {
    const order = [
      'set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/full-backup.mjs --verify !BV_FILE_NAME!"',
      'set /p "BV_CONFIRM=Type RESTORE to continue: "',
      "%COMPOSE% stop blackvault 1>&2",
      'call scripts\\db-snapshot.bat > "!BV_SNAP_LOG!" 2>&1',
      'set "BV_DOCKER_ARGS=compose run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp !BV_STAMP! !BV_FILE_NAME!"',
      ":rollback",
    ].map((l) => code.indexOf(l));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const sh = fs.readFileSync(path.join(ROOT, "restore.sh"), "utf8");
    expect(sh).toContain('CMD=($COMPOSE run --rm -T blackvault node dist/scripts/full-backup.mjs --verify "$NAME")');
    expect(sh).toContain('CMD=($COMPOSE run --rm -T blackvault node dist/scripts/full-restore.mjs --stamp "$STAMP" "$NAME")');
  });

  it("the rollback uses the same commands as restore.sh: snapshot-restore.sh as root with backups read-only, and psql into a new database before the swap", () => {
    const container = '%COMPOSE% run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v "!CD!\\backups:/bv-backups:ro" -v "!CD!\\scripts\\snapshot-restore.sh:/bv-snapshot-restore.sh:ro" blackvault /bv-snapshot-restore.sh';
    const psql = "%COMPOSE% exec -T db psql -q -v ON_ERROR_STOP=1 -U blackvault";
    const expected = [
      `${psql} -d postgres -c "DROP DATABASE IF EXISTS blackvault_rollback WITH (FORCE)" -c "CREATE DATABASE blackvault_rollback OWNER blackvault" 1>&2`,
      `${psql} -d blackvault_rollback --single-transaction -f - < "!BV_DB_SNAPSHOT!" >nul`,
      `${psql} -d postgres -c "DROP DATABASE IF EXISTS blackvault WITH (FORCE)" -c "ALTER DATABASE blackvault_rollback RENAME TO blackvault" 1>&2`,
      `${container} sqlite /bv-backups/!BV_DB_SNAPSHOT_NAME! /app/data/vault.db 1>&2`,
      `${container} uploads /app/uploads !BV_STAMP! !BV_UPLOADS_ARG! 1>&2`,
    ].map((l) => code.indexOf(l));
    expect(expected.every((i) => i > code.indexOf(":rollback"))).toBe(true);
    expect([...expected].sort((a, b) => a - b)).toEqual(expected);
    // After a failed rollback the app is not started: the only `up -d` calls are before :rollback, and after :rolled_back.
    const ups = code.map((l, i) => (l === "%COMPOSE% up -d 1>&2" ? i : -1)).filter((i) => i >= 0);
    expect(ups.filter((i) => i > code.indexOf(":rollback") && i < code.indexOf(":rolled_back"))).toEqual([]);
    expect(ups.some((i) => i > code.indexOf(":rolled_back"))).toBe(true);
    // The script the container runs must reach Windows checkouts with LF endings.
    expect(fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8")).toContain("scripts/snapshot-restore.sh text eol=lf");
  });

  it("every for /f character check on a user value is guarded against a leading ';', and it never pauses", () => {
    const at = code.findIndex((l) => l.startsWith('for /f "delims=') && l.includes('("!BV_FILE_NAME!")'));
    expect(at).toBeGreaterThan(0);
    expect(code[at].endsWith("do goto :file_bad_name")).toBe(true);
    expect(code[at - 1]).toBe('if "!BV_FILE_NAME:~0,1!"==";" goto :file_bad_name');
    expect(code.filter((l) => /^for \/f "delims=[^"]+" %%X in \("!BV_/.test(l))).toHaveLength(1);
    expect(code.filter((l) => /^\s*pause\b/i.test(l))).toEqual([]);
  });

  it("the Windows harness runs it (RS1–RS8) and prints the script's output and the docker calls whenever a check fails", () => {
    const harness = fs.readFileSync(path.join(ROOT, "scripts/ci/windows/Test-WindowsInstallers.ps1"), "utf8");
    for (let i = 1; i <= 8; i++) expect(harness).toContain(`scenario RS${i}\r\n`);
    const section = harness.slice(harness.indexOf("# restore.bat (full restore, Task 7)"), harness.indexOf("# --------------------------------------------------------------------- report"));
    const runs = section.match(/^\s*\$r = Invoke-Restore /gm) ?? [];
    const evidence = section.match(/^\s*Show-EvidenceIfFailed \$r/gm) ?? [];
    expect(runs.length).toBeGreaterThanOrEqual(14);
    expect(evidence.length).toBe(runs.length);
    const stub = fs.readFileSync(path.join(ROOT, "scripts/ci/windows/docker-stub.cs"), "utf8");
    expect(stub).toContain('"dist/scripts/full-restore.mjs"');
    expect(stub).toContain('"/bv-snapshot-restore.sh"');
  });
});
