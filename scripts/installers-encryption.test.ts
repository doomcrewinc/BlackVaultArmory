/**
 * install.sh / update.sh / scripts/db-snapshot.sh and field encryption
 * (Task 7): the key file, the pre-upgrade snapshot, and the first upgrade
 * INTO this version, which runs the OLD update.sh (it git-pulls itself; see
 * the memory note "old script runs on upgrade").
 *
 * Docker is a stub (as in setup-token.test.ts): every call is appended to
 * docker.calls, and `compose up -d` (the app start) also records what was on
 * disk at that moment, so "the snapshot happened BEFORE the new image
 * started" is checked on the real script, not inferred from its text.
 * The Windows twins are covered by scripts/ci/windows/Test-WindowsInstallers.ps1.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const BOX_LINE = "BACK THIS FILE UP. Without it your serial numbers and NFA records cannot be recovered.";
const KEY_FILE = "secrets/blackvault_encryption_key";

/** The tree an install has: the scripts, their libraries, the compose file and secrets/.gitignore. */
const TREE = [
  "install.sh",
  "update.sh",
  "docker-compose.yml",
  "secrets/.gitignore",
  "scripts/compose-provider.sh",
  "scripts/public-url-prompts.sh",
  "scripts/setup-token.sh",
  "scripts/encryption-key.sh",
  "scripts/db-snapshot.sh",
];

let tmp: string;
let bin: string;
let calls: string;

function copyTree(dest: string, files = TREE) {
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dest, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  }
}

/**
 * The docker stub. `compose version --short` → 2.30.1; `compose ps` →
 * healthy; `compose exec -T db pg_dump` → a fake dump; BV_STUB_FAIL_ON=<word>
 * fails any call containing that word. `compose up -d` with no service (the
 * app start) also logs which backups and key file existed at that moment.
 */
function writeStub() {
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
echo "$*" >> "${calls}"
if [ -n "$BV_STUB_FAIL_ON" ]; then
  case " $* " in *" $BV_STUB_FAIL_ON "*) echo "[stub] failing on purpose: $*" >&2; exit 1 ;; esac
fi
case "$*" in
  "compose version --short") echo 2.30.1 ;;
  "compose ps"*) echo "Up 3 seconds (healthy)" ;;
  "compose exec -T db pg_dump"*) echo "-- stub pg_dump of blackvault" ;;
  "compose up -d")
    echo "AT-APP-START backups=[$(ls backups 2>/dev/null | tr '\\n' ' ')] key=$([ -f secrets/blackvault_encryption_key ] && echo yes || echo no)" >> "${calls}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
}

function run(dir: string, script: string, input: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [script], {
    cwd: dir,
    input,
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: tmp,
      GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
      ...env,
    } as unknown as NodeJS.ProcessEnv,
    timeout: 60_000,
  });
  return {
    code: r.status,
    out: `${r.stdout}${r.stderr}`,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "",
  };
}

/** A configured SQLite install with a database file, as install.sh leaves it. */
function sqliteInstall(dir: string) {
  fs.mkdirSync(path.join(dir, "data/db"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data/uploads"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data/db/vault.db"), "SQLite format 3\0 pretend database SN-PLAIN-1");
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      `DATA_DIR=${dir}/data`, "PORT=3000", "BLACKVAULT_DB_PROVIDER=sqlite",
      "BLACKVAULT_PUBLIC_URL=https://vault.example.com", "BLACKVAULT_TRUSTED_PROXIES=", "BLACKVAULT_DIRECT_ACCESS_INITIAL=on", "",
    ].join("\n"),
  );
}

function postgresInstall(dir: string) {
  fs.mkdirSync(path.join(dir, "data/postgres"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".env"),
    [
      `DATA_DIR=${dir}/data`, "PORT=3000", "COMPOSE_PROFILES=postgres", "BLACKVAULT_DB_PROVIDER=postgres",
      `BLACKVAULT_POSTGRES_PASSWORD=${"ab".repeat(24)}`, `BLACKVAULT_DATABASE_URL=postgresql://blackvault:${"ab".repeat(24)}@db:5432/blackvault`,
      "BLACKVAULT_PUBLIC_URL=https://vault.example.com", "BLACKVAULT_TRUSTED_PROXIES=", "BLACKVAULT_DIRECT_ACCESS_INITIAL=on", "",
    ].join("\n"),
  );
}

const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
const backups = (dir: string) => (fs.existsSync(path.join(dir, "backups")) ? fs.readdirSync(path.join(dir, "backups")).sort() : []);
const callLines = (c: string) => c.split("\n").filter(Boolean);
const indexOfCall = (c: string, prefix: string) => callLines(c).findIndex((l) => l.startsWith(prefix));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-inst-enc-"));
  bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  calls = path.join(bin, "docker.calls");
  writeStub();
  fs.writeFileSync(path.join(tmp, "gitconfig"), "[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n");
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Answers for a fresh install.sh: data dir, port, public URL, trusted
// proxies, direct access, database (2 = SQLite).
const INSTALL_ANSWERS = "\n\nhttps://vault.example.com\n\n\n2\n";

describe("install.sh", () => {
  it("creates a 64-hex key file, mode 600 in a mode-700 folder, prints the boxed back-up message, before building", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    const r = run(dir, "install.sh", INSTALL_ANSWERS);
    expect(r.code, r.out).toBe(0);
    const key = fs.readFileSync(path.join(dir, KEY_FILE), "utf8");
    expect(key).toMatch(/^[0-9a-f]{64}\n$/);
    expect(modeOf(path.join(dir, KEY_FILE))).toBe(0o600);
    expect(modeOf(path.join(dir, "secrets"))).toBe(0o700);
    expect(r.out).toContain(BOX_LINE);
    expect(r.out).toMatch(/={20,}\n {2}Encryption key created: .*secrets\/blackvault_encryption_key\n/);
    expect(r.out).not.toContain(key.trim()); // never echoed
    expect(r.calls).toContain("AT-APP-START backups=[] key=yes");
    expect(fs.readdirSync(path.join(dir, "secrets")).sort()).toEqual([".gitignore", "blackvault_encryption_key"]);
  });

  it("never overwrites an existing key file (fresh install path)", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    fs.writeFileSync(path.join(dir, KEY_FILE), "cd".repeat(32), { mode: 0o600 });
    const r = run(dir, "install.sh", INSTALL_ANSWERS);
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe("cd".repeat(32));
    expect(r.out).toContain("existing, unchanged");
    expect(r.out).not.toContain(BOX_LINE);
  });

  it("re-run over a configured install: creates the key if missing, keeps it if present", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const first = run(dir, "install.sh", "");
    expect(first.code, first.out).toBe(0);
    const key = fs.readFileSync(path.join(dir, KEY_FILE), "utf8");
    expect(first.out).toContain(BOX_LINE);
    expect(first.calls).toContain("key=yes");
    const second = run(dir, "install.sh", "");
    expect(second.code, second.out).toBe(0);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe(key);
    expect(second.out).not.toContain(BOX_LINE);
  });
});

describe("update.sh (no git checkout)", () => {
  it("creates the key only when missing, snapshots SQLite BEFORE starting the new image, prints the plaintext warning", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(BOX_LINE);
    const snaps = backups(dir);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatch(/^blackvault-\d{8}-\d{6}\.db$/);
    const snap = path.join(dir, "backups", snaps[0]);
    expect(fs.readFileSync(snap, "utf8")).toBe(fs.readFileSync(path.join(dir, "data/db/vault.db"), "utf8"));
    expect(modeOf(snap)).toBe(0o600);
    expect(modeOf(path.join(dir, "backups"))).toBe(0o700);
    expect(r.out).toContain(`Database snapshot saved: backups/${snaps[0]}`);
    expect(r.out).toContain("this snapshot is NOT encrypted");
    // Order: rebuild, stop the app, (copy), start the new image.
    const build = indexOfCall(r.calls, "compose build --pull");
    const stop = indexOfCall(r.calls, "compose stop blackvault");
    const up = indexOfCall(r.calls, "compose up -d");
    expect(build).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(build);
    expect(up).toBeGreaterThan(stop);
    expect(r.calls).toContain(`AT-APP-START backups=[${snaps[0]} ] key=yes`);

    // Second update: the key is kept byte for byte, a new snapshot is taken.
    const key = fs.readFileSync(path.join(dir, KEY_FILE), "utf8");
    fs.rmSync(calls);
    const again = run(dir, "update.sh", "\n");
    expect(again.code, again.out).toBe(0);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe(key);
    expect(again.out).not.toContain(BOX_LINE);
    expect(again.out).toContain("existing, unchanged");
  });

  it.skipIf(process.getuid?.() === 0)("a failing snapshot aborts non-zero and never starts the new image", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.chmodSync(path.join(dir, "data/db/vault.db"), 0o000); // cp fails
    try {
      const r = run(dir, "update.sh", "\n");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("ERROR: database snapshot failed");
      expect(r.out).toContain("the update stopped here");
      expect(r.calls).not.toContain("AT-APP-START");
      expect(callLines(r.calls)).not.toContain("compose up -d");
      // The old container is started again.
      expect(callLines(r.calls).at(-1)).toBe("compose start blackvault");
      expect(backups(dir)).toEqual([]);
    } finally {
      fs.chmodSync(path.join(dir, "data/db/vault.db"), 0o644);
    }
  });

  it("PostgreSQL: pg_dump through the db container into backups/blackvault-<ts>.sql, before the new image starts", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    postgresInstall(dir);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    const snaps = backups(dir);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatch(/^blackvault-\d{8}-\d{6}\.sql$/);
    expect(fs.readFileSync(path.join(dir, "backups", snaps[0]), "utf8")).toBe("-- stub pg_dump of blackvault\n");
    expect(modeOf(path.join(dir, "backups", snaps[0]))).toBe(0o600);
    expect(r.calls).toContain("compose up -d --wait db");
    expect(r.calls).toContain("compose exec -T db pg_dump -U blackvault -d blackvault");
    expect(r.calls).not.toContain("compose stop blackvault"); // pg_dump needs no downtime
    expect(indexOfCall(r.calls, "compose exec -T db pg_dump")).toBeLessThan(indexOfCall(r.calls, "AT-APP-START"));
    expect(r.out).toContain("this snapshot is NOT encrypted");
  });

  it("PostgreSQL: a failing pg_dump aborts non-zero, leaves no partial file, never starts the new image", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    postgresInstall(dir);
    const r = run(dir, "update.sh", "\n", { BV_STUB_FAIL_ON: "pg_dump" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ERROR: database snapshot failed: pg_dump failed.");
    expect(r.calls).not.toContain("AT-APP-START");
    expect(backups(dir)).toEqual([]);
  });
});

describe("scripts/db-snapshot.sh on its own (the rotate-key.sh contract, R4)", () => {
  it("exits non-zero when the app cannot be stopped, and writes nothing", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const r = run(dir, "scripts/db-snapshot.sh", "", { BV_STUB_FAIL_ON: "stop" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR: database snapshot failed: could not stop BlackVault.");
    expect(backups(dir)).toEqual([]);
  });

  it("works when called from another directory, and copies a leftover rollback journal beside the snapshot", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.writeFileSync(path.join(dir, "data/db/vault.db-journal"), "hot journal");
    const r = run(tmp, path.join(dir, "scripts/db-snapshot.sh"), "");
    expect(r.code, r.out).toBe(0);
    const snaps = backups(dir);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]).toBe(`${snaps[0]}-journal`);
    expect(r.calls).not.toContain("compose start"); // the caller decides when to start again
  });

  it("no database yet: nothing to copy, exit 0", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.rmSync(path.join(dir, "data/db/vault.db"));
    const r = run(dir, "scripts/db-snapshot.sh", "");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("nothing to snapshot");
    expect(backups(dir)).toEqual([]);
  });
});

// ─── git-pull paths: the self-updating script ────────────────────────────

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** An origin repo whose first commit is `firstTree` (a function filling the dir); returns its path. */
function newOrigin(fill: (dir: string) => void): string {
  const origin = path.join(tmp, "origin");
  fs.mkdirSync(origin);
  git(origin, "init", "-q");
  fill(origin);
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "v1");
  return origin;
}

function commitAll(origin: string, fill: (dir: string) => void, msg: string) {
  fill(origin);
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", msg);
}

describe("update.sh after git pull", () => {
  it("re-executes the NEW update.sh once the pull brought changes (so future upgrades run the new steps)", () => {
    const origin = newOrigin((d) => copyTree(d));
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    commitAll(origin, (d) => {
      const p = path.join(d, "update.sh");
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('cd "$(dirname "$0")"\n', 'cd "$(dirname "$0")"\necho "NEW-UPDATE-SH-RUNNING"\n'));
    }, "v2");
    const r = run(work, "update.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Restarting the update with the new update.sh...");
    expect(r.out.match(/NEW-UPDATE-SH-RUNNING/g)).toHaveLength(1);
    expect(r.out).toContain("Running the updated update.sh.");
    expect(r.calls.match(/AT-APP-START/g)).toHaveLength(1); // one start, from the new script
  });

  it("does not re-execute when nothing was pulled", () => {
    const origin = newOrigin((d) => copyTree(d));
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    const r = run(work, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("Restarting the update");
  });

  it("first hop: the OLD update.sh (develop 663523c) pulling THIS tree still finishes; secrets/ exists for the mount; the next run creates the key and snapshots before starting", () => {
    const OLD_TREE = TREE.filter((f) => !["scripts/encryption-key.sh", "scripts/db-snapshot.sh", "secrets/.gitignore"].includes(f));
    const origin = newOrigin((d) => {
      copyTree(d, OLD_TREE);
      fs.copyFileSync(path.join(ROOT, "scripts/fixtures/update.sh.develop-663523c"), path.join(d, "update.sh"));
      fs.writeFileSync(path.join(d, "docker-compose.yml"), "# develop's compose (content irrelevant to the stub)\n");
    });
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    commitAll(origin, (d) => copyTree(d), "this release");

    // The old script runs to the end: the pull brings the new tree, but bash
    // keeps executing the old copy — no key, no snapshot from it.
    const old = run(work, "update.sh", "\n");
    expect(old.code, old.out).toBe(0);
    expect(old.out).not.toContain("Restarting the update");
    expect(old.calls).toContain("compose build --pull");
    expect(old.calls).toContain("compose up -d");
    expect(fs.existsSync(path.join(work, KEY_FILE))).toBe(false);
    expect(backups(work)).toEqual([]);
    // What makes the new image say KEY_MISSING (with the host hint) instead
    // of Compose refusing to create the container: the mounted folder exists.
    expect(fs.statSync(path.join(work, "secrets")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(work, "update.sh"), "utf8")).toBe(fs.readFileSync(path.join(ROOT, "update.sh"), "utf8"));

    // The fix the KEY_MISSING message names: run ./update.sh again.
    fs.rmSync(calls);
    const next = run(work, "update.sh", "\n");
    expect(next.code, next.out).toBe(0);
    expect(next.out).toContain(BOX_LINE);
    const snaps = backups(work);
    expect(snaps).toHaveLength(1);
    expect(next.calls).toContain(`AT-APP-START backups=[${snaps[0]} ] key=yes`);
  });
});
