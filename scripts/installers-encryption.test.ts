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
import { spawn, spawnSync } from "node:child_process";
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
  "rotate-key.sh",
  "docker-compose.yml",
  "secrets/.gitignore",
  "scripts/compose-provider.sh",
  "scripts/backup-common.sh",
  "scripts/snapshot-restore.sh",
  "scripts/public-url-prompts.sh",
  "scripts/setup-token.sh",
  "scripts/encryption-key.sh",
  "scripts/db-snapshot.sh",
  "scripts/uploads-snapshot.sh",
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
 * BV_STUB_PS_STATUS (default: healthy); `compose exec -T db pg_dump` → a fake dump; the rotation CLI
 * (rotate-key.sh) exits BV_STUB_ROTATE_EXIT (default 0) and its --probe
 * prints BV_STUB_PROBE (default OLD); BV_STUB_FAIL_ON=<word>
 * fails any call containing that word. `compose up -d` with no service (the
 * app start) also logs which backups and key file existed at that moment.
 */
function writeStub() {
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/bash
echo "$*" >> "${calls}"
[ -n "\${BLACKVAULT_UPLOADS_SNAPSHOT:-}" ] && echo "SAW-UPLOADS-SNAPSHOT=[\${BLACKVAULT_UPLOADS_SNAPSHOT}] at: $*" >> "${calls}"
if [ -n "$BV_STUB_FAIL_ON" ]; then
  case " $* " in *" $BV_STUB_FAIL_ON "*) echo "[stub] failing on purpose: $*" >&2; exit 1 ;; esac
fi
case "$*" in
  "compose config --images blackvault") echo "\${BV_STUB_IMAGE-blackvault-blackvault}" ;;
  *"/bv-uploads-snapshot.sh /app/uploads /bv-backups "*)
    # The one-off uploads-snapshot container, emulated on the host: the real
    # scripts/uploads-snapshot.sh against DATA_DIR/uploads (not root, so no su-exec).
    dd=$(sed -n 's/^DATA_DIR=//p' .env | tail -n 1); for a in "$@"; do name=$a; done
    sh scripts/uploads-snapshot.sh "\${dd:-./data}/uploads" backups "$name"; exit $? ;;
  *"rotate-encryption-key.mjs --probe"*) echo "\${BV_STUB_PROBE:-OLD}" ;;
  *"rotate-encryption-key.mjs"*) [ -n "$BV_STUB_ROTATE_STDERR" ] && echo "$BV_STUB_ROTATE_STDERR" >&2; exit "\${BV_STUB_ROTATE_EXIT:-0}" ;;
  "compose version --short") echo 2.30.1 ;;
  "compose ps"*) echo "\${BV_STUB_PS_STATUS-Up 3 seconds (healthy)}" ;;
  "compose exec -T db pg_dump"*) echo "-- stub pg_dump of blackvault" ;;
  "compose up -d")
    echo "AT-APP-START backups=[$(ls backups 2>/dev/null | tr '\\n' ' ')] key=$([ -f secrets/blackvault_encryption_key ] && echo yes || echo no) uploads_marker=[\${BLACKVAULT_UPLOADS_SNAPSHOT:-}]" >> "${calls}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
}

/**
 * Starts `script` in the background and sends it `signal` as soon as
 * `.git/info/attributes` holds the temporary override (i.e. during the 1 s
 * sleep in clear_bat_eol_only_changes). Resolves with the exit status.
 */
async function runAndInterrupt(dir: string, script: string, input: string, signal: NodeJS.Signals) {
  const child = spawn("bash", [script], {
    cwd: dir,
    env: {
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: tmp,
      GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
    } as unknown as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const attrs = path.join(dir, ".git/info/attributes");
  const deadline = Date.now() + 20_000;
  let sawOverride = false;
  while (Date.now() < deadline && child.exitCode === null) {
    if (fs.existsSync(attrs) && fs.readFileSync(attrs, "utf8").includes("-text blackvault-update")) {
      sawOverride = true;
      child.kill(signal);
      break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const code = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else child.on("exit", (c) => resolve(c));
  });
  return { code, out, sawOverride };
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

/**
 * Seeds data/uploads with two regular files (one nested, matching the real
 * documents/ subfolder) and, unless skipLink, a symlink to one of them —
 * which Task 4's uploads snapshot must never follow and never copy.
 */
function seedUploads(dir: string, { skipLink = false }: { skipLink?: boolean } = {}) {
  const uploads = path.join(dir, "data/uploads");
  fs.mkdirSync(path.join(uploads, "documents"), { recursive: true });
  fs.writeFileSync(path.join(uploads, "photo1.jpg"), "fake jpeg bytes");
  fs.writeFileSync(path.join(uploads, "documents", "doc1.pdf"), "fake pdf bytes");
  if (!skipLink) fs.symlinkSync(path.join(uploads, "photo1.jpg"), path.join(uploads, "photo1-link.jpg"));
}

/** Every regular file under dir (relative paths, "/"-joined, sorted); never descends into a symlinked directory. */
function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const abs = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

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

/**
 * The health wait reads the Status column of `docker compose ps`:
 * "Up 2 minutes (healthy)", "(unhealthy)" or "(health: starting)". `sleep` is
 * stubbed so the full 60-poll wait runs in no time.
 */
describe("health wait: only the status word healthy is success", () => {
  const stubSleep = () => fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const polls = (c: string) => callLines(c).filter((l) => l.startsWith("compose ps")).length;

  it.each([
    ["install.sh", INSTALL_ANSWERS],
    ["update.sh", "\n"],
  ])("%s: unhealthy is not reported as running, the output says unhealthy, and the exit status is 1", (script, answers) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    if (script === "update.sh") sqliteInstall(dir);
    stubSleep();
    const r = run(dir, script, answers, { BV_STUB_PS_STATUS: "Up 2 minutes (unhealthy)" });
    // A cron job or a calling script must see the failure; the summary and
    // the log hint are still printed first.
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("NOT healthy");
    expect(r.out).toMatch(/logs/);
    expect(polls(r.calls)).toBe(60);
    expect(r.out).toMatch(/unhealthy/i);
    expect(r.out).not.toContain("BlackVault is running.");
    expect(r.out).not.toContain("BlackVault is ready!");
    expect(r.out).not.toMatch(/Status:\s+running/);
    expect(r.out).not.toContain("Update complete.");
  });

  it.each([
    ["install.sh", INSTALL_ANSWERS],
    ["update.sh", "\n"],
  ])("%s: still starting when the wait runs out: says it did not become healthy, and still exits 0 (a slow first start is not a failure)", (script, answers) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    if (script === "update.sh") sqliteInstall(dir);
    stubSleep();
    const r = run(dir, script, answers, { BV_STUB_PS_STATUS: "Up 2 minutes (health: starting)" });
    expect(r.code, r.out).toBe(0);
    expect(polls(r.calls)).toBe(60);
    expect(r.out).toContain("did not become healthy");
    expect(r.out).not.toMatch(/unhealthy/i);
    expect(r.out).not.toContain("BlackVault is running.");
    expect(r.out).not.toContain("BlackVault is ready!");
    expect(r.out).not.toMatch(/Status:\s+running/);
    expect(r.out).not.toContain("Update complete.");
  });

  // The app's own start refusals (a restore marker, two keys, no public URL)
  // leave the container restarting over and over: neither unhealthy nor
  // starting. That is a failed start, seen after a few polls, not a slow one.
  it.each([
    ["install.sh", "Restarting (1) 2 seconds ago", INSTALL_ANSWERS, "keeps restarting"],
    ["update.sh", "Restarting (1) 2 seconds ago", "\n", "keeps restarting"],
    ["install.sh", "Exited (1) 5 seconds ago", INSTALL_ANSWERS, "has exited"],
    ["update.sh", "Exited (1) 5 seconds ago", "\n", "has exited"],
    ["install.sh", "", INSTALL_ANSWERS, "no running BlackVault container"],
    ["update.sh", "", "\n", "no running BlackVault container"],
  ])("%s: status %j is a failed start: the wait ends after three sightings, the output says so and names the log command, exit 1", (script, status, answers, words) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    if (script === "update.sh") sqliteInstall(dir);
    stubSleep();
    const r = run(dir, script, answers, { BV_STUB_PS_STATUS: status });
    expect(r.code, r.out).toBe(1);
    expect(polls(r.calls)).toBe(3);
    expect(r.out).toContain(words);
    expect(r.out).toContain("docker compose logs blackvault");
    expect(r.out).toContain("NOT healthy");
    expect(r.out).not.toContain("BlackVault is running.");
    expect(r.out).not.toContain("BlackVault is ready!");
    expect(r.out).not.toMatch(/Status:\s+running/);
    expect(r.out).not.toContain("Update complete.");
    expect(r.out).not.toContain("did not become healthy");
  });

  it("a status with no health word at all (an image without a health check) is still the old outcome: the full wait, a warning, exit 0", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    stubSleep();
    const r = run(dir, "update.sh", "\n", { BV_STUB_PS_STATUS: "Up 2 minutes" });
    expect(r.code, r.out).toBe(0);
    expect(polls(r.calls)).toBe(60);
    expect(r.out).toContain("did not become healthy");
  });

  it("install.sh: healthy on the first poll is success", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    const r = run(dir, "install.sh", INSTALL_ANSWERS);
    expect(r.code, r.out).toBe(0);
    expect(polls(r.calls)).toBe(1);
    expect(r.out).toContain("BlackVault is running.");
    expect(r.out).toContain("BlackVault is ready!");
    expect(r.out).not.toContain("WARNING");
  });

  it("update.sh: healthy on the first poll is success", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(polls(r.calls)).toBe(1);
    expect(r.out).toMatch(/Status:\s+running/);
    expect(r.out).toContain("Update complete.");
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
    expect(r.out).toContain("this snapshot is a plain, unencrypted copy");
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

  // ── final review N1: the documented env-var key ──
  it("N1: BLACKVAULT_ENCRYPTION_KEY in .env → no key file is created (a second key would be KEY_CONFLICT), and the update completes", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.appendFileSync(path.join(dir, ".env"), `BLACKVAULT_ENCRYPTION_KEY=${"cd".repeat(32)}\n`);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Encryption key: BLACKVAULT_ENCRYPTION_KEY (from .env) - no key file created");
    expect(r.out).not.toContain(BOX_LINE);
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
    expect(fs.statSync(path.join(dir, "secrets")).isDirectory()).toBe(true); // the compose mount needs the folder
    expect(callLines(r.calls)).toContain("compose up -d");
    expect(r.calls).toContain("key=no");
  });

  // Every form Docker Compose itself accepts for the line: a missed key here
  // would create a second, different key (KEY_CONFLICT at the next start).
  it.each([
    ["export", (k: string) => `export BLACKVAULT_ENCRYPTION_KEY=${k}`],
    ["export, quotes and a comment", (k: string) => `export BLACKVAULT_ENCRYPTION_KEY="${k}" # the field-encryption key`],
    ["spaces around = and single quotes", (k: string) => `BLACKVAULT_ENCRYPTION_KEY = '${k}'`],
    ["CRLF", (k: string) => `BLACKVAULT_ENCRYPTION_KEY=${k}\r`],
    ["a commented-out empty line above it", (k: string) => `#BLACKVAULT_ENCRYPTION_KEY=\nexport BLACKVAULT_ENCRYPTION_KEY=${k}`],
    // The app trims the value, so spaces inside the quotes are still that key.
    ["spaces inside the quotes", (k: string) => `BLACKVAULT_ENCRYPTION_KEY="  ${k}\t "`],
    ["upper-case hex", (k: string) => `BLACKVAULT_ENCRYPTION_KEY=${k.toUpperCase()}`],
  ])("BLACKVAULT_ENCRYPTION_KEY written in .env as: %s → install.sh and update.sh create no key file", (_name, line) => {
    for (const script of ["install.sh", "update.sh"]) {
      const dir = path.join(tmp, `app-${script}`);
      copyTree(dir);
      sqliteInstall(dir);
      fs.appendFileSync(path.join(dir, ".env"), `${line("cd".repeat(32))}\n`);
      const r = run(dir, script, "\n");
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("Encryption key: BLACKVAULT_ENCRYPTION_KEY (from .env) - no key file created");
      expect(r.out).not.toContain(BOX_LINE);
      expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
      expect(callLines(r.calls)).toContain("compose up -d");
    }
  });

  it("a commented-out BLACKVAULT_ENCRYPTION_KEY line does not count: the key file is created", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.appendFileSync(path.join(dir, ".env"), `# export BLACKVAULT_ENCRYPTION_KEY=${"cd".repeat(32)}\n`);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it("the public URL, direct access and trusted proxies written with export, quotes and comments: nothing is asked again, .env is untouched", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const env = [
      `export DATA_DIR="${dir}/data" # where the data lives`,
      "PORT=3000",
      "export BLACKVAULT_DB_PROVIDER = sqlite",
      "#BLACKVAULT_PUBLIC_URL=https://old.example.com",
      "export BLACKVAULT_PUBLIC_URL='https://vault.example.com' # behind the proxy",
      "export BLACKVAULT_TRUSTED_PROXIES=",
      "  export BLACKVAULT_DIRECT_ACCESS_INITIAL=on",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, ".env"), env);
    // Only "Is this still current?" (Enter = yes) may be asked. Any further
    // prompt would read end of input: the URL prompt aborts on it.
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Public URL is: https://vault.example.com\n");
    expect(r.out).toContain(`Database verified at: ${dir}/data/db/vault.db`);
    expect(r.out).not.toContain("Public URL: the address people open");
    expect(r.out).not.toContain("Keep allowing direct access");
    expect(r.out).not.toContain("Trusted proxies:");
    expect(r.out).toMatch(/URL:\s+https:\/\/vault\.example\.com\n/);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
    expect(callLines(r.calls)).toContain("compose up -d");
  });

  it("install.sh over a configured install whose DATA_DIR line uses export and quotes: starts it, does not run the wizard", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const env = `export DATA_DIR = "${dir}/data"\nBLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://vault.example.com\n`;
    fs.writeFileSync(path.join(dir, ".env"), env);
    const r = run(dir, "install.sh", "");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`Your data is at: ${dir}/data (sqlite)`);
    expect(r.out).toContain("Starting with existing configuration...");
    expect(r.out).not.toContain("Where should BlackVault store its data?");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
  });

  it("the database is in a legacy folder and DATA_DIR is written with export: the new DATA_DIR is what .env now says", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir); // the database is in <dir>/data, a location update.sh knows
    fs.writeFileSync(
      path.join(dir, ".env"),
      `export DATA_DIR=${dir}/moved-away\nBLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://vault.example.com\nBLACKVAULT_TRUSTED_PROXIES=\nBLACKVAULT_DIRECT_ACCESS_INITIAL=on\n`,
    );
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Auto-updating DATA_DIR in .env");
    const sourced = spawnSync("bash", ["-c", ". scripts/compose-provider.sh; env_value DATA_DIR"], { cwd: dir, encoding: "utf8" });
    expect(sourced.stdout.trim()).toBe(`${fs.realpathSync(dir)}/data`); // update.sh builds it from $(pwd)
    expect(fs.existsSync(path.join(dir, ".env.bak"))).toBe(true);
  });

  // Docker Compose substitutes $VAR and unescapes \x inside double quotes;
  // the reader does neither, so such a DATA_DIR is unreadable. Using the text
  // as written would name a folder that does not exist, and the check below
  // it would then repoint .env at whatever database sits in a legacy folder.
  it.each([
    ["$HOME in an export line", (d: string) => `export DATA_DIR=$HOME/${path.basename(d)}/real`],
    ["${VAR} in double quotes", (_d: string) => 'DATA_DIR = "${BV_DATA}/real"'],
    ["DATA_DIR: value", (d: string) => `DATA_DIR: ${d}/real`],
    ["a double-quoted path with \\r and \\n in it", (_d: string) => 'DATA_DIR="C:\\Users\\rob\\new data"'],
    ["a single-quoted path with an apostrophe", (d: string) => `DATA_DIR='${d}/Rob's Vault'`],
    ["a single-quoted path ending in a backslash", (_d: string) => "DATA_DIR='C:\\BV\\'"],
    // Compose puts the home folder in place of a leading ~; the reader does not.
    ["a leading ~", (_d: string) => "DATA_DIR=~/real"],
    ["a leading ~ in double quotes", (_d: string) => 'export DATA_DIR="~/real"'],
  ])("update.sh: an unreadable DATA_DIR (%s) stops the update at the preflight: nothing pulled, built or relocated, .env untouched", (_name, line) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir); // a database in <dir>/data: a legacy location update.sh knows
    const env = `${line(dir)}\nBLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://vault.example.com\nBLACKVAULT_TRUSTED_PROXIES=\nBLACKVAULT_DIRECT_ACCESS_INITIAL=on\n`;
    fs.writeFileSync(path.join(dir, ".env"), env);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR: DATA_DIR in .env could not be read");
    expect(r.out).toContain("Nothing was rebuilt or restarted.");
    expect(r.out).not.toContain("Nothing was pulled");
    expect(r.out).not.toContain("Auto-updating DATA_DIR");
    expect(r.out).not.toContain("Database verified at");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
    expect(fs.existsSync(path.join(dir, ".env.bak"))).toBe(false);
    // Stopped before the prompts, the key file, the build and the snapshot.
    expect(r.out).not.toContain("Public URL is:");
    expect(r.out).not.toContain("Rebuilding BlackVault image");
    expect(r.out).not.toContain("Snapshotting the database");
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
    expect(callLines(r.calls).filter((l) => !l.startsWith("compose version"))).toEqual([]);
    expect(backups(dir)).toEqual([]);
  });

  it("update.sh: a double-quoted Windows-style path with no escape letter in it is read as written (Compose reads it literally)", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const real = path.join(dir, "Data\\Vault"); // a folder name holding a backslash: \V is no escape
    fs.mkdirSync(path.join(real, "db"), { recursive: true });
    fs.mkdirSync(path.join(real, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(real, "db/vault.db"), "SQLite format 3\0 the real database");
    const env = `DATA_DIR="${real}"\nBLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://vault.example.com\nBLACKVAULT_TRUSTED_PROXIES=\nBLACKVAULT_DIRECT_ACCESS_INITIAL=on\n`;
    fs.writeFileSync(path.join(dir, ".env"), env);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`Database verified at: ${real}/db/vault.db`);
    expect(r.out).not.toContain("Auto-updating DATA_DIR");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
  });

  it("install.sh: an existing .env whose DATA_DIR is unreadable stops the installer; the wizard never overwrites .env", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const env = "export DATA_DIR=$HOME/blackvault\nBLACKVAULT_DB_PROVIDER=sqlite\n";
    fs.writeFileSync(path.join(dir, ".env"), env);
    const r = run(dir, "install.sh", INSTALL_ANSWERS);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR: DATA_DIR in .env could not be read");
    expect(r.out).toContain("Write it as DATA_DIR=value");
    expect(r.out).not.toContain("Where should BlackVault store its data?");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
    expect(r.calls).not.toContain("compose up");
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
  });

  /** What the reader gives back for DATA_DIR in dir's .env: [value, unreadable?]. */
  function dataDirReadBack(dir: string): [string, boolean] {
    const r = spawnSync("bash", ["-c", '. scripts/compose-provider.sh; env_value DATA_DIR; if env_unreadable DATA_DIR; then echo UNREADABLE; fi'], { cwd: dir, encoding: "utf8" });
    const lines = r.stdout.split("\n");
    return [lines[0], lines[1] === "UNREADABLE"];
  }

  // THE INVARIANT: whatever install.sh writes for DATA_DIR is a line its own
  // reader reads back as the folder the installer created. A typed answer the
  // reader would refuse, or read as something else, is asked for again.
  it.each([
    ["an absolute path", (t: string) => `${t}/bv data`, (t: string) => `${t}/bv data`, false],
    ["~/x", () => "~/bv-data", (t: string) => `${t}/bv-data`, false],
    ["$HOME/x", () => "$HOME/bv-data", (t: string) => `${t}/bv-data`, false],
    ["$HOME alone", () => "$HOME", (t: string) => t, false],
    ["~name/x, then a good path", (t: string) => `~rob/bv-data\n${t}/second`, (t: string) => `${t}/second`, true],
    ["a $VAR in the middle, then a good path", (t: string) => `${t}/$USER/data\n${t}/second`, (t: string) => `${t}/second`, true],
    ["${HOME}/x, then a good path", (t: string) => "${HOME}/bv\n" + `${t}/second`, (t: string) => `${t}/second`, true],
    ["a path holding ' #' (the reader would cut it there), then a good path", (t: string) => `${t}/vault #2\n${t}/second`, (t: string) => `${t}/second`, true],
    ["a path starting with a quote, then a good path", (t: string) => `"${t}/quoted"\n${t}/second`, (t: string) => `${t}/second`, true],
    ["three refused answers, then the default", () => "~a/x\n$B/x\n~c/x\n", (_t: string, dir: string) => `${dir}/data`, true],
  ] as [string, (t: string) => string, (t: string, dir: string) => string, boolean][])("install.sh writes a DATA_DIR line its own reader reads back as the folder it made: %s", (_name, typed, expected, refusedFirst) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    const r = run(dir, "install.sh", `${typed(tmp)}${INSTALL_ANSWERS}`);
    expect(r.code, r.out).toBe(0);
    const want = expected(tmp, fs.realpathSync(dir));
    expect(dataDirReadBack(dir)).toEqual([want, false]);
    expect(fs.statSync(path.join(want, "db")).isDirectory()).toBe(true);
    expect(r.out).toContain(`Data stored: ${want}\n`);
    expect(r.out.includes("That folder cannot be used as typed")).toBe(refusedFirst);
    // Nothing literally named after what was typed is left in the checkout.
    expect(fs.readdirSync(dir).filter((n) => /[~$"]/.test(n))).toEqual([]);
  });

  it("install.sh: the data-folder question at the end of input stops the installer; nothing is written", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    const r = run(dir, "install.sh", "~rob/bv-data\n");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("That folder cannot be used as typed");
    expect(r.out).toContain("ERROR: no data directory was given. Nothing was changed.");
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
    expect(r.calls).not.toContain("compose up");
  });

  it.each(["install.sh", "update.sh"])("%s: an unreadable BLACKVAULT_DB_PROVIDER stops before anything is started (SQLite is not assumed)", (script) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.appendFileSync(path.join(dir, ".env"), "BLACKVAULT_DB_PROVIDER=$DB\n");
    const before = fs.readFileSync(path.join(dir, ".env"), "utf8");
    const r = run(dir, script, "\n");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR: BLACKVAULT_DB_PROVIDER in .env could not be read");
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(before);
    expect(r.calls).not.toContain("compose build");
    expect(r.calls).not.toContain("compose up");
  });

  it.each([
    ["a $ in the value", "BLACKVAULT_ENCRYPTION_KEY=$BV_KEY", "could not be read"],
    ["KEY: value", `BLACKVAULT_ENCRYPTION_KEY: ${"cd".repeat(32)}`, "could not be read"],
    // Compose passes "# note" to the app, which refuses it: not "no key".
    ["only a comment after the =", "BLACKVAULT_ENCRYPTION_KEY= # note", "is not 64 hex characters"],
    ["too short", "BLACKVAULT_ENCRYPTION_KEY=abc123", "is not 64 hex characters"],
    ["a non-hex character", `BLACKVAULT_ENCRYPTION_KEY="${"cd".repeat(31)}cg"`, "is not 64 hex characters"],
  ])("BLACKVAULT_ENCRYPTION_KEY in .env with %s: install.sh and update.sh stop, and create NO second key", (_name, line, message) => {
    for (const script of ["install.sh", "update.sh"]) {
      const dir = path.join(tmp, `app-${script}`);
      copyTree(dir);
      sqliteInstall(dir);
      fs.appendFileSync(path.join(dir, ".env"), `${line}\n`);
      const r = run(dir, script, "\n");
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain("BLACKVAULT_ENCRYPTION_KEY");
      expect(r.out).toContain(message);
      expect(r.out).not.toContain(BOX_LINE);
      expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
      expect(r.calls).not.toContain("compose build");
      expect(r.calls).not.toContain("compose up");
    }
  });

  it("a UTF-8 BOM before a BLACKVAULT_ENCRYPTION_KEY line on line 1: the key is found, no key file is created", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const rest = fs.readFileSync(path.join(dir, ".env"), "utf8");
    fs.writeFileSync(path.join(dir, ".env"), `\uFEFFBLACKVAULT_ENCRYPTION_KEY=${"cd".repeat(32)}\n${rest}`);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Encryption key: BLACKVAULT_ENCRYPTION_KEY (from .env) - no key file created");
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
  });

  it("update.sh: an unreadable BLACKVAULT_PUBLIC_URL is asked for again and written as a plain line that wins", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.writeFileSync(
      path.join(dir, ".env"),
      `DATA_DIR=${dir}/data\nBLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://$HOST\nBLACKVAULT_TRUSTED_PROXIES=\nBLACKVAULT_DIRECT_ACCESS_INITIAL=on\n`,
    );
    const r = run(dir, "update.sh", "https://vault.example.com\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("BLACKVAULT_PUBLIC_URL in .env could not be read");
    expect(r.out).not.toContain("Public URL is: ");
    const sourced = spawnSync("bash", ["-c", ". scripts/compose-provider.sh; env_value BLACKVAULT_PUBLIC_URL"], { cwd: dir, encoding: "utf8" });
    expect(sourced.stdout.trim()).toBe("https://vault.example.com");
  });

  it("scripts/db-snapshot.sh on its own: an unreadable DATA_DIR or provider is refused, ./data is not assumed", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.writeFileSync(path.join(dir, ".env"), 'DATA_DIR="${HOME}/blackvault"\nBLACKVAULT_DB_PROVIDER=sqlite\n');
    const r = run(dir, "scripts/db-snapshot.sh", "");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR: database snapshot failed: DATA_DIR in .env could not be read");
    expect(r.calls).not.toContain("compose stop");
    expect(backups(dir)).toEqual([]);
    fs.writeFileSync(path.join(dir, ".env"), `DATA_DIR=${dir}/data\nBLACKVAULT_DB_PROVIDER: sqlite\n`);
    const p = run(dir, "scripts/db-snapshot.sh", "");
    expect(p.code, p.out).toBe(1);
    expect(p.out).toContain("ERROR: database snapshot failed: BLACKVAULT_DB_PROVIDER in .env could not be read");
    expect(p.calls).not.toContain("compose stop");
  });

  it("N1: BLACKVAULT_ENCRYPTION_KEY exported in the shell → no key file either", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const r = run(dir, "update.sh", "\n", { BLACKVAULT_ENCRYPTION_KEY: "cd".repeat(32) });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Encryption key: BLACKVAULT_ENCRYPTION_KEY (from the shell environment) - no key file created");
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
  });

  it("N1: an EMPTY BLACKVAULT_ENCRYPTION_KEY= line in .env does not count: the key file is created", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.appendFileSync(path.join(dir, ".env"), "BLACKVAULT_ENCRYPTION_KEY=\n");
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(BOX_LINE);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
  });

  // The new image refuses to start while a restore marker is in the uploads
  // folder. Found before the rebuild, the version that is running stays up.
  it.each([
    ["a folder, as the restore program leaves it", (up: string) => fs.mkdirSync(path.join(up, ".restore-20261001-101010.db-started"))],
    ["a file with a hand-made stamp", (up: string) => fs.writeFileSync(path.join(up, ".restore-old one.db-started"), "")],
  ])("update.sh: a restore marker in the uploads folder (%s) stops the update BEFORE the rebuild, with the command that removes it", (_name, plant) => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const uploads = path.join(dir, "data/uploads");
    plant(uploads);
    const stamp = fs.readdirSync(uploads)[0].slice(".restore-".length, -".db-started".length);
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`ERROR: the uploads folder holds a marker left by a restore: ${uploads}/.restore-${stamp}.db-started.`);
    expect(r.out).toContain("refuses to start while a marker exists");
    expect(r.out).toContain("/bv-snapshot-restore.sh clear-marker /app/uploads ");
    expect(r.out).toContain(stamp.includes(" ") ? `clear-marker /app/uploads '${stamp}'` : `clear-marker /app/uploads ${stamp}`);
    expect(r.out).toContain("Nothing was rebuilt or restarted.");
    expect(r.out).not.toContain("Rebuilding BlackVault image");
    expect(r.out).not.toContain("Public URL is:");
    expect(callLines(r.calls).filter((l) => !l.startsWith("compose version"))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toBe(env);
    expect(fs.existsSync(path.join(dir, KEY_FILE))).toBe(false);
    expect(backups(dir)).toEqual([]);
    expect(fs.readdirSync(uploads)).toHaveLength(1); // the marker is never removed by the update
  });

  it("update.sh: names that are not markers (.restore-<stamp> staging, .pre-restore-<stamp>, an empty stamp) do not stop the update", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    for (const name of [".restore-20261001-101010", ".pre-restore-20261001-101010", ".restore-.db-started"]) fs.mkdirSync(path.join(dir, "data/uploads", name));
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("marker left by a restore");
    expect(callLines(r.calls)).toContain("compose up -d");
  });

  it("scripts/db-snapshot.sh: DATA_DIR exported in the shell and different from .env is refused before the app is stopped", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const r = run(dir, "scripts/db-snapshot.sh", "", { DATA_DIR: path.join(dir, "elsewhere") });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR: database snapshot failed: DATA_DIR is set in this shell and is not the DATA_DIR in .env");
    expect(r.out).toContain("unset DATA_DIR");
    expect(r.calls).not.toContain("compose stop");
    expect(backups(dir)).toEqual([]);
    // The same folder, exported: nothing to refuse.
    const same = run(dir, "scripts/db-snapshot.sh", "", { DATA_DIR: path.join(dir, "data") });
    expect(same.code, same.out).toBe(0);
    expect(backups(dir)).toHaveLength(1);
  });

  it("update.sh: DATA_DIR exported in the shell and different from .env: the snapshot refuses, the new image is not started", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const r = run(dir, "update.sh", "\n", { DATA_DIR: path.join(dir, "elsewhere") });
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("DATA_DIR is set in this shell and is not the DATA_DIR in .env");
    expect(r.out).toContain("The new version was NOT started.");
    expect(callLines(r.calls)).not.toContain("compose up -d");
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
    expect(r.out).toContain("this snapshot is a plain, unencrypted copy");
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

// ─── Task 4: the update scripts snapshot the uploads folder too ─────────

describe("update.sh — uploads snapshot (Task 4)", () => {
  it("copies a seeded uploads tree byte-for-byte, dirs 700 / files 600, skips the symlink, and the marker reaches the container environment via the next `up`", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    seedUploads(dir);
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    const ups = fs.readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("uploads-"));
    expect(ups).toHaveLength(1);
    const snapDir = path.join(dir, "backups", ups[0]);
    expect(modeOf(snapDir)).toBe(0o700);
    expect(modeOf(path.join(snapDir, "documents"))).toBe(0o700);
    expect(modeOf(path.join(snapDir, "photo1.jpg"))).toBe(0o600);
    expect(modeOf(path.join(snapDir, "documents/doc1.pdf"))).toBe(0o600);
    expect(fs.readFileSync(path.join(snapDir, "photo1.jpg"), "utf8")).toBe("fake jpeg bytes");
    expect(fs.readFileSync(path.join(snapDir, "documents/doc1.pdf"), "utf8")).toBe("fake pdf bytes");
    // The symlink was never followed and never copied as a link or a file.
    expect(listFilesRecursive(snapDir)).toEqual(["documents/doc1.pdf", "photo1.jpg"]);
    expect(r.out).toContain("skipped the symbolic link");
    expect(r.out).toContain(`Uploads snapshot saved: backups/${ups[0]}`);
    // The marker reached the container's environment at the `up` that
    // starts the new image, and was not left lying around afterwards.
    expect(r.calls).toContain(`uploads_marker=[backups/${ups[0]}]`);
    expect(fs.existsSync(path.join(dir, "backups/.uploads-snapshot-marker"))).toBe(false);
  });

  it("copies inside a one-off app container as root-then-1001, with backups/ and the copy script mounted; never builds or pulls", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    seedUploads(dir, { skipLink: true });
    const r = run(dir, "scripts/db-snapshot.sh", "");
    expect(r.code, r.out).toBe(0);
    const runLine = callLines(r.calls).find((l) => l.includes("/bv-uploads-snapshot.sh"));
    const real = fs.realpathSync(dir); // $PWD in the script (macOS: /private/var/...)
    expect(runLine).toBe(
      `compose run --rm -T --no-deps --user 0:0 --entrypoint /bin/sh -v ${real}/backups:/bv-backups ` +
        `-v ${real}/scripts/uploads-snapshot.sh:/bv-uploads-snapshot.sh:ro blackvault /bv-uploads-snapshot.sh /app/uploads /bv-backups ` +
        runLine!.split(" ").at(-1),
    );
    expect(runLine!.split(" ").at(-1)).toMatch(/^uploads-\d{8}-\d{6}(-\d+)?$/);
    expect(callLines(r.calls)).toContain("image inspect blackvault-blackvault");
    expect(r.calls).not.toMatch(/compose (build|pull)/);
  });

  it("skips the app's .pre-encryption-* folders and every *.tmp / *.rot file (M5)", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    seedUploads(dir, { skipLink: true });
    const up = path.join(dir, "data/uploads");
    fs.mkdirSync(path.join(up, ".pre-encryption-20261001-120000/documents"), { recursive: true });
    fs.writeFileSync(path.join(up, ".pre-encryption-20261001-120000/documents/old.pdf"), "plaintext");
    fs.mkdirSync(path.join(up, ".pre-encryption-20261001-130000.partial"), { recursive: true });
    fs.writeFileSync(path.join(up, ".pre-encryption-20261001-130000.partial/x.jpg"), "partial");
    fs.writeFileSync(path.join(up, "documents/doc1.pdf.0123abcd.tmp"), "half written");
    fs.writeFileSync(path.join(up, "photo1.jpg.rot"), "mid rotation");
    const r = run(dir, "scripts/db-snapshot.sh", "");
    expect(r.code, r.out).toBe(0);
    const ups = fs.readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("uploads-"));
    expect(ups).toHaveLength(1);
    expect(listFilesRecursive(path.join(dir, "backups", ups[0]))).toEqual(["documents/doc1.pdf", "photo1.jpg"]);
    expect(fs.readdirSync(path.join(dir, "backups", ups[0])).some((n) => n.startsWith(".pre-encryption-"))).toBe(false);
  });

  it("only *.tmp / *.rot / snapshot files: nothing to copy, exit 0, no snapshot, no marker", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    const up = path.join(dir, "data/uploads");
    fs.mkdirSync(path.join(up, ".pre-encryption-20261001-120000"), { recursive: true });
    fs.writeFileSync(path.join(up, ".pre-encryption-20261001-120000/a.jpg"), "plaintext");
    fs.writeFileSync(path.join(up, "a.jpg.rot"), "mid rotation");
    const r = run(dir, "scripts/db-snapshot.sh", "");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("skipping the uploads snapshot");
    expect(backups(dir).filter((n) => n.startsWith("uploads-") || n === ".uploads-snapshot-marker")).toEqual([]);
  });

  it("the app image is missing: exits non-zero with a real message, starts no container, writes no uploads snapshot", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    seedUploads(dir, { skipLink: true });
    const r = run(dir, "scripts/db-snapshot.sh", "", { BV_STUB_FAIL_ON: "inspect" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("ERROR: database snapshot failed: the BlackVault image blackvault-blackvault does not exist yet");
    expect(r.calls).not.toContain("/bv-uploads-snapshot.sh");
    expect(backups(dir).filter((n) => n.startsWith("uploads-"))).toEqual([]);
  });

  it("empty uploads folder: still succeeds, takes no uploads snapshot, sets no marker", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir); // data/uploads exists and is empty
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(fs.readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("uploads-"))).toEqual([]);
    expect(r.out).toContain("skipping the uploads snapshot");
    expect(r.calls).toContain("uploads_marker=[]");
  });

  // Final review FIX 5: a value inherited from the caller's shell never reaches compose.
  it("update.sh: an exported BLACKVAULT_UPLOADS_SNAPSHOT is cleared; with no uploads snapshot `up` gets an empty marker", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir); // data/uploads exists and is empty: no marker of its own
    const r = run(dir, "update.sh", "\n", { BLACKVAULT_UPLOADS_SNAPSHOT: "backups/uploads-stale" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain("uploads_marker=[]");
    // Only the compose-provider probe runs before the unset; no compose call
    // that runs or recreates a container sees the stale value.
    const saw = r.calls.split("\n").filter((l) => l.startsWith("SAW-UPLOADS-SNAPSHOT="));
    expect(saw.filter((l) => !l.endsWith("at: compose version --short"))).toEqual([]);
  });

  it("rotate-key.sh: an exported BLACKVAULT_UPLOADS_SNAPSHOT never reaches any compose call", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.chmodSync(path.join(dir, "secrets"), 0o700);
    fs.writeFileSync(path.join(dir, KEY_FILE), "ab".repeat(32), { mode: 0o600 });
    seedUploads(dir, { skipLink: true });
    const r = run(dir, "rotate-key.sh", "", { BLACKVAULT_UPLOADS_SNAPSHOT: "backups/uploads-stale" });
    expect(r.code, r.out).toBe(0);
    expect(r.calls).toContain("compose start blackvault");
    expect(r.calls).not.toContain("SAW-UPLOADS-SNAPSHOT");
  });

  it("missing uploads folder entirely: still succeeds, no uploads snapshot", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.rmSync(path.join(dir, "data/uploads"), { recursive: true, force: true });
    const r = run(dir, "update.sh", "\n");
    expect(r.code, r.out).toBe(0);
    expect(fs.readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("uploads-"))).toEqual([]);
    expect(r.calls).toContain("uploads_marker=[]");
    // No container is started (and so no bind mount creates the folder).
    expect(r.calls).not.toContain("/bv-uploads-snapshot.sh");
  });

  it.skipIf(process.getuid?.() === 0)("a failed uploads copy exits non-zero, the update stops, and no partial directory is left behind", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    seedUploads(dir, { skipLink: true });
    fs.chmodSync(path.join(dir, "data/uploads/photo1.jpg"), 0o000);
    try {
      const r = run(dir, "update.sh", "\n");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("ERROR: database snapshot failed");
      expect(r.out).toContain("ERROR: could not snapshot the uploads folder");
      expect(r.out).toContain("could not snapshot the uploads folder");
      // Final review FIX 6: the hint also names the PostgreSQL upload-during-copy case.
      expect(r.out).toContain("on PostgreSQL, a file uploaded during the copy also causes this: run the update again");
      expect(r.calls).not.toContain("AT-APP-START");
      expect(callLines(r.calls)).not.toContain("compose up -d");
      expect(callLines(r.calls).at(-1)).toBe("compose start blackvault");
      expect(fs.existsSync(path.join(dir, "backups/.uploads-snapshot-marker"))).toBe(false);
      expect(fs.readdirSync(path.join(dir, "backups")).some((n) => n.includes(".partial"))).toBe(false);
    } finally {
      fs.chmodSync(path.join(dir, "data/uploads/photo1.jpg"), 0o644);
    }
  });

  it("rotate-key.sh also snapshots uploads through the same db-snapshot.sh, but never leaves or needs the marker (compose start does not recreate the container)", () => {
    const dir = path.join(tmp, "app");
    copyTree(dir);
    sqliteInstall(dir);
    fs.chmodSync(path.join(dir, "secrets"), 0o700);
    fs.writeFileSync(path.join(dir, KEY_FILE), "ab".repeat(32), { mode: 0o600 });
    seedUploads(dir, { skipLink: true });
    const r = run(dir, "rotate-key.sh", "");
    expect(r.code, r.out).toBe(0);
    const ups = fs.readdirSync(path.join(dir, "backups")).filter((n) => n.startsWith("uploads-"));
    expect(ups).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, "backups/.uploads-snapshot-marker"))).toBe(false);
  });
});

// ─── rotate-key.sh (final review F5) ────────────────────────────────────

describe("rotate-key.sh, with the rotation CLI stubbed", () => {
  const OLD_KEY = "ab".repeat(32);

  function rotateInstall(dir: string) {
    copyTree(dir);
    sqliteInstall(dir);
    fs.chmodSync(path.join(dir, "secrets"), 0o700);
    fs.writeFileSync(path.join(dir, KEY_FILE), OLD_KEY, { mode: 0o600 });
  }
  const secrets = (dir: string) => fs.readdirSync(path.join(dir, "secrets")).filter((f) => f !== ".gitignore").sort();

  it("a restore marker in the uploads folder: the rotation refuses before BlackVault is stopped; no new key, nothing snapshotted", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const marker = path.join(dir, "data/uploads/.restore-20261001-101010.db-started");
    fs.mkdirSync(marker);
    const r = run(dir, "rotate-key.sh", "");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain(`ERROR: the uploads folder holds a marker left by a restore: ${marker}.`);
    expect(r.out).toContain("clear-marker /app/uploads 20261001-101010");
    expect(r.out).toContain("Nothing was changed; BlackVault was not stopped.");
    expect(callLines(r.calls).filter((l) => !l.startsWith("compose version"))).toEqual([]);
    expect(secrets(dir)).toEqual(["blackvault_encryption_key"]);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe(OLD_KEY);
    expect(backups(dir)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it("success: the key files are swapped (old kept as .old-<ts>) and the app restarts", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Key rotation complete.");
    const files = secrets(dir);
    expect(files).toHaveLength(2);
    expect(files[0]).toBe("blackvault_encryption_key");
    expect(files[1]).toMatch(/^blackvault_encryption_key\.old-\d{8}-\d{6}$/);
    expect(fs.readFileSync(path.join(dir, "secrets", files[1]), "utf8")).toBe(OLD_KEY);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(r.calls).toContain("compose start blackvault");
  });

  it("exit 3 (refused up front: the key file does not open this database): no probe, .new set aside, key untouched, NOT restarted", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "", {
      BV_STUB_ROTATE_EXIT: "3",
      BV_STUB_ROTATE_STDERR: "The old key does not match this database's encryption key check; refusing to rotate. Nothing was changed.",
    });
    expect(r.code).toBe(1);
    // Spec 3b: exit 3 also covers "an uploaded file is under neither key", so the headline is generic
    // and the wrong-key case is one of two named reasons.
    expect(r.out).toContain("ERROR: the rotation refused before changing anything; the reason is printed above.");
    expect(r.out).toContain("secrets/blackvault_encryption_key does not open this database (wrong or replaced key).");
    expect(r.out).toContain("If it names an uploaded file");
    expect(r.out).toContain("Nothing was changed. BlackVault was NOT restarted.");
    expect(r.out).toContain("BlackVault's startup log names its key id");
    expect(r.out).not.toContain("Checking which key the database");
    expect(r.calls).not.toContain("--probe");
    expect(r.calls).not.toContain("compose start");
    const files = secrets(dir);
    expect(files[0]).toBe("blackvault_encryption_key");
    expect(files[1]).toMatch(/^blackvault_encryption_key\.new\.unused-\d{8}-\d{6}$/);
    expect(files).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe(OLD_KEY);
  });

  it("exit 1 and the probe answers OLD: .new set aside, app restarted on the old key", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "", { BV_STUB_ROTATE_EXIT: "1", BV_STUB_PROBE: "OLD" });
    expect(r.code).toBe(1);
    expect(r.calls).toContain("--probe");
    expect(r.out).toContain("still encrypted with the OLD key");
    expect(r.calls).toContain("compose start blackvault");
    expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe(OLD_KEY);
  });

  it.each([
    ["in .env", { file: true, env: {} as Record<string, string> }, "from .env"],
    ["exported in the shell", { file: false, env: { BLACKVAULT_ENCRYPTION_KEY: "cd".repeat(32) } }, "from the shell environment"],
  ])("N1: a key held in BLACKVAULT_ENCRYPTION_KEY (%s) is refused up front: rotation works on the key file", (_l, how, source) => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    if (how.file) fs.appendFileSync(path.join(dir, ".env"), `BLACKVAULT_ENCRYPTION_KEY=${"cd".repeat(32)}\n`);
    const r = run(dir, "rotate-key.sh", "", how.env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ERROR: Key rotation works on secrets/blackvault_encryption_key. Your key is in");
    expect(r.out).toContain(`BLACKVAULT_ENCRYPTION_KEY (${source}): move it into that file`);
    expect(r.out).toContain("Nothing was changed; BlackVault was not stopped.");
    expect(r.calls).toBe(""); // docker never invoked
    expect(secrets(dir)).toEqual(["blackvault_encryption_key"]);
  });

  // A key line the .env reader cannot read (Compose would substitute or
  // unescape it) is still a key held in the environment: Compose passes its
  // value to the app, and after a rotation it would conflict with the new file.
  it.each([
    ["a $ in an unquoted value", "BLACKVAULT_ENCRYPTION_KEY=$MYKEY"],
    ["${VAR} in double quotes", 'export BLACKVAULT_ENCRYPTION_KEY="${MYKEY}"'],
    ["KEY: value", `BLACKVAULT_ENCRYPTION_KEY: ${"cd".repeat(32)}`],
    ["quotes, spaces and a comment", `BLACKVAULT_ENCRYPTION_KEY = "  ${"cd".repeat(32)}  " # the key`],
  ])("rotate-key.sh: a BLACKVAULT_ENCRYPTION_KEY line in .env written as %s is refused up front, like any env key", (_l, line) => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    fs.appendFileSync(path.join(dir, ".env"), `${line}\n`);
    const r = run(dir, "rotate-key.sh", "");
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("ERROR: Key rotation works on secrets/blackvault_encryption_key. Your key is in");
    expect(r.out).toContain("BLACKVAULT_ENCRYPTION_KEY (from .env): move it into that file");
    expect(r.out).toContain("Nothing was changed; BlackVault was not stopped.");
    expect(r.calls).toBe(""); // docker never invoked
    expect(secrets(dir)).toEqual(["blackvault_encryption_key"]);
  });

  it("rotate-key.sh: a BLACKVAULT_ENCRYPTION_KEY line holding only whitespace is no key (the app trims it): rotation is not refused for it", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    fs.appendFileSync(path.join(dir, ".env"), 'BLACKVAULT_ENCRYPTION_KEY="   "\n');
    const r = run(dir, "rotate-key.sh", "");
    expect(r.out).not.toContain("Key rotation works on");
  });

  // Spec 3b Task 5: the probe prints a SECOND line, `FILES old=<n> new=<n> rot=<n>`. The wrapper must
  // read only the first line as the answer (it used to strip ALL whitespace from the whole output, which
  // turned "NEW\nFILES ..." into "NEWFILES..." and the ambiguous branch).
  it("spec 3b: exit 1 and the two-line probe answers NEW: the first line decides, the swap completes, and the staged .rot files are reported as finished by the app's startup", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "", { BV_STUB_ROTATE_EXIT: "1", BV_STUB_PROBE: "NEW\nFILES old=3 new=0 rot=3" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Confirmed: the database is already encrypted with the NEW key.");
    expect(r.out).toContain("3 re-encrypted uploaded files are staged as .rot files; BlackVault puts them in place when it starts with the new key.");
    expect(r.out).toContain("Key rotation complete.");
    expect(r.calls).toContain("compose start blackvault");
    const files = secrets(dir);
    expect(files[0]).toBe("blackvault_encryption_key");
    expect(files[1]).toMatch(/^blackvault_encryption_key\.old-\d{8}-\d{6}$/);
  });

  it("spec 3b: exit 1 and the two-line probe answers NEW with no staged files: no .rot line", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "", { BV_STUB_ROTATE_EXIT: "1", BV_STUB_PROBE: "NEW\r\nFILES old=0 new=3 rot=0\r" });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Key rotation complete.");
    expect(r.out).not.toContain(".rot files");
  });

  it.each(["OLD", "NEITHER"])("spec 3b: exit 1 and the two-line probe answers %s: the first line alone picks the branch", (answer) => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "", { BV_STUB_ROTATE_EXIT: "1", BV_STUB_PROBE: `${answer}\nFILES old=3 new=0 rot=3` });
    expect(r.code).toBe(1);
    if (answer === "OLD") {
      expect(r.out).toContain("still encrypted with the OLD key");
      expect(fs.readFileSync(path.join(dir, KEY_FILE), "utf8")).toBe(OLD_KEY);
      expect(r.calls).toContain("compose start blackvault");
    } else {
      expect(r.out).toContain("probe answered 'NEITHER'");
      expect(r.calls).not.toContain("compose start");
    }
  });

  it("exit 1 and the probe answers NEITHER: nothing touched, not restarted, and the recovery text has the NEITHER step", () => {
    const dir = path.join(tmp, "app");
    rotateInstall(dir);
    const r = run(dir, "rotate-key.sh", "", { BV_STUB_ROTATE_EXIT: "1", BV_STUB_PROBE: "NEITHER" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("4. If it answers NEITHER: secrets/blackvault_encryption_key is not this database's key.");
    expect(r.out).toContain("Restore the right key file as secrets/blackvault_encryption_key, then run the probe again.");
    expect(r.calls).not.toContain("compose start");
    expect(secrets(dir)).toEqual(["blackvault_encryption_key", "blackvault_encryption_key.new"]);
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

/**
 * The fenced code block between `<!-- readme-recovery-<marker>:start/end -->`
 * in THIS checkout's real README.md (fix round 1, I2) — not a hand-copied
 * approximation, so a test executing it proves what a reader actually sees.
 */
function extractReadmeBlock(marker: string): string {
  const text = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const startTag = `<!-- readme-recovery-${marker}:start -->`;
  const endTag = `<!-- readme-recovery-${marker}:end -->`;
  const si = text.indexOf(startTag);
  const ei = text.indexOf(endTag);
  if (si === -1 || ei === -1 || ei < si) {
    throw new Error(`README.md markers for "${marker}" not found or out of order (si=${si} ei=${ei})`);
  }
  const block = text.slice(si + startTag.length, ei);
  const m = block.match(/```[a-z]*\n([\s\S]*?)```/);
  if (!m) throw new Error(`No fenced code block found between the "${marker}" markers`);
  return m[1];
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
    const OLD_TREE = TREE.filter((f) => !["scripts/encryption-key.sh", "scripts/db-snapshot.sh", "scripts/uploads-snapshot.sh", "secrets/.gitignore", "rotate-key.sh"].includes(f));
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


// ─── fix round 1, I4: the .bat files' line endings must not block the pull ──

describe("update.sh before git pull: install.bat / update.bat line endings (fix round 1, I4)", () => {
  const BAT_V1 = "@echo off\r\nrem v1\r\n";
  const BAT_V2 = "@echo off\r\nrem v2\r\n";

  /** Stages the two .bat files with CRLF IN THE INDEX, as releases before this one did. */
  function stageCrlfBats(dir: string, content: string) {
    for (const f of ["install.bat", "update.bat"]) {
      fs.writeFileSync(path.join(dir, f), content);
      const sha = git(dir, "hash-object", "-w", "--no-filters", f);
      git(dir, "update-index", "--add", "--cacheinfo", `100644,${sha},${f}`);
    }
  }

  function originWithBats(crlfIndex: boolean): string {
    const origin = newOrigin((d) => {
      copyTree(d);
      fs.writeFileSync(path.join(d, ".gitattributes"), "*.bat text eol=crlf\n");
      for (const f of ["install.bat", "update.bat"]) fs.writeFileSync(path.join(d, f), BAT_V1);
    });
    if (crlfIndex) {
      // `git add` normalised them to LF; re-stage the raw CRLF bytes.
      stageCrlfBats(origin, BAT_V1);
      git(origin, "commit", "-q", "--amend", "--no-edit");
      expect(git(origin, "ls-files", "--eol", "update.bat")).toMatch(/^i\/crlf/);
    }
    return origin;
  }

  /**
   * Any stat change (a backup tool, a copy, a racy clone) makes Git compare
   * the content, and then a CRLF index entry under `text eol=crlf` reads as
   * modified. Bumping the mtime gets there deterministically.
   */
  function touchBats(dir: string) {
    const later = new Date(Date.now() - 60_000); // in the past: a future mtime would stay "racy"
    for (const f of ["install.bat", "update.bat"]) fs.utimesSync(path.join(dir, f), later, later);
  }

  function pushBatChange(origin: string, crlfIndex: boolean) {
    if (crlfIndex) {
      stageCrlfBats(origin, BAT_V2);
      git(origin, "commit", "-q", "-m", "v2 changes both .bat files");
    } else {
      commitAll(origin, (d) => {
        for (const f of ["install.bat", "update.bat"]) fs.writeFileSync(path.join(d, f), BAT_V2);
      }, "v2 changes both .bat files");
    }
  }

  it("CRLF-in-index checkout (line endings only): the pull goes through, both files arrive, nothing local is lost", () => {
    const origin = originWithBats(true);
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    touchBats(work);
    // Premise: Git reports the two files modified although no byte changed.
    expect(git(work, "status", "--porcelain", "--", "install.bat", "update.bat")).toMatch(/M install\.bat[\s\S]*M update\.bat/);
    // And a plain pull of a release that changes them aborts.
    pushBatChange(origin, true);
    const plain = spawnSync("git", ["pull", "-q"], { cwd: work, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig") } });
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain("would be overwritten");

    const before = git(work, "rev-parse", "HEAD");
    const r = run(work, "update.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Clearing a line-ending-only difference in install.bat / update.bat before pulling...");
    expect(git(work, "rev-parse", "HEAD")).not.toBe(before);
    expect(fs.readFileSync(path.join(work, "install.bat"), "utf8")).toBe(BAT_V2);
    expect(fs.existsSync(path.join(work, ".git/info/attributes"))).toBe(false); // the temporary override is gone
  });

  it("an existing .git/info/attributes is restored byte for byte", () => {
    const origin = originWithBats(true);
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    fs.mkdirSync(path.join(work, ".git/info"), { recursive: true });
    fs.writeFileSync(path.join(work, ".git/info/attributes"), "*.png binary\n");
    touchBats(work);
    pushBatChange(origin, true);
    const r = run(work, "update.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Clearing a line-ending-only difference");
    expect(fs.readFileSync(path.join(work, ".git/info/attributes"), "utf8")).toBe("*.png binary\n");
  });

  it("SIGTERM or SIGINT during the override: the trap puts .git/info/attributes back exactly (fix round 2)", async () => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const origin = originWithBats(true);
      const work = path.join(tmp, `work-${signal}`);
      git(tmp, "clone", "-q", origin, work);
      sqliteInstall(work);
      fs.mkdirSync(path.join(work, ".git/info"), { recursive: true });
      fs.writeFileSync(path.join(work, ".git/info/attributes"), "*.png binary\n");
      touchBats(work);
      const r = await runAndInterrupt(work, "update.sh", "\n\n", signal);
      expect(r.sawOverride, r.out).toBe(true);
      expect(r.code).toBe(signal === "SIGTERM" ? 143 : 130);
      expect(fs.readFileSync(path.join(work, ".git/info/attributes"), "utf8")).toBe("*.png binary\n");
      expect(fs.readdirSync(path.join(work, ".git/info")).filter((f) => f.includes("blackvault"))).toEqual([]); // no backup left
      fs.rmSync(path.join(origin), { recursive: true, force: true });
    }
  }, 60_000);

  it("SIGKILL during the override (no trap can run): the NEXT run strips the marked lines first, and .bat files check out CRLF again (fix round 2)", async () => {
    const origin = originWithBats(true);
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    touchBats(work);
    const killed = await runAndInterrupt(work, "update.sh", "\n\n", "SIGKILL");
    expect(killed.sawOverride).toBe(true);
    const attrs = path.join(work, ".git/info/attributes");
    // Premise: the override is left behind, and it would make a checkout LF.
    expect(fs.readFileSync(attrs, "utf8")).toContain("install.bat -text blackvault-update");
    expect(git(work, "check-attr", "text", "--", "install.bat")).toBe("install.bat: text: unset");

    pushBatChange(origin, true);
    const r = run(work, "update.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Removing a line-ending override left in .git/info/attributes by an interrupted update...");
    expect(fs.existsSync(attrs)).toBe(false); // there was no file before: none now
    expect(git(work, "check-attr", "text", "--", "install.bat")).toBe("install.bat: text: set");
    // A checkout of an LF blob comes out CRLF again.
    git(work, "add", "--renormalize", "install.bat");
    git(work, "commit", "-q", "-m", "renormalize");
    fs.rmSync(path.join(work, "install.bat"));
    git(work, "checkout", "--", "install.bat");
    expect(fs.readFileSync(path.join(work, "install.bat"), "utf8")).toBe(BAT_V2);
  }, 60_000);

  it("an attributes file with NO trailing newline: the override starts on its own line (it works) and the file is restored byte for byte (fix round 2)", () => {
    const origin = originWithBats(true);
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    fs.mkdirSync(path.join(work, ".git/info"), { recursive: true });
    fs.writeFileSync(path.join(work, ".git/info/attributes"), "*.png binary");
    touchBats(work);
    pushBatChange(origin, true);
    const before = git(work, "rev-parse", "HEAD");
    const r = run(work, "update.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).not.toBe(before); // the override took effect, so the pull went through
    expect(fs.readFileSync(path.join(work, ".git/info/attributes"), "utf8")).toBe("*.png binary");
  });

  it("a REAL local edit is left alone: the pull still refuses, and the edit survives", () => {
    const origin = originWithBats(true);
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    touchBats(work);
    fs.appendFileSync(path.join(work, "install.bat"), "rem my local tweak\r\n");
    pushBatChange(origin, true);
    const r = run(work, "update.sh", "\n\n");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("Note: install.bat or update.bat has local edits; they are left alone.");
    expect(r.out).not.toContain("Clearing a line-ending-only difference");
    expect(fs.readFileSync(path.join(work, "install.bat"), "utf8")).toBe(`${BAT_V1}rem my local tweak\r\n`);
    expect(r.calls).not.toContain("compose up -d");
  });

  it("LF in the index (this release on): a fresh clone is clean and a later release changing both .bat files pulls without help", () => {
    const origin = originWithBats(false);
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    touchBats(work);
    expect(git(work, "status", "--porcelain", "--", "install.bat", "update.bat")).toBe("");
    expect(fs.readFileSync(path.join(work, "update.bat"), "utf8")).toBe(BAT_V1); // CRLF on disk
    pushBatChange(origin, false);
    const r = run(work, "update.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("Clearing a line-ending-only difference");
    expect(fs.readFileSync(path.join(work, "update.bat"), "utf8")).toBe(BAT_V2);
    expect(git(work, "status", "--porcelain", "--", "install.bat", "update.bat")).toBe("");
  });

  // ─── README one-time recovery command (fix round 1, I2) ─────────────────
  // Nested in this describe (not module scope): it reuses originWithBats,
  // touchBats and pushBatChange above, which are closures over BAT_V1/BAT_V2.
  //
  // The README documents TWO commands (POSIX here; a Windows cmd.exe one,
  // tested by scripts/ci/windows/Test-WindowsInstallers.ps1), each wrapped in
  // `<!-- readme-recovery-<platform>:start/end -->` HTML comments so a test
  // can pull the ACTUAL documented text out of README.md and execute it,
  // rather than a hand-copied approximation that could silently drift from
  // what a reader actually sees.
  describe("README recovery command, extracted verbatim from README.md and executed (fix round 1, I2)", () => {
  // Final review FIX 5 (Task 8 MUST-FIX): the clone starts from the
  // PRE-RELEASE scripts (develop 663523c), as every real reader's does. With
  // the CURRENT update.sh in the clone, a broken README block still passed:
  // its failed `git pull` fell through to `./update.sh`, which self-heals the
  // line endings and pulls by itself. The 663523c update.sh cannot, so only a
  // README block that really works gets the pull through.
  const PRE_RELEASE_TREE = TREE.filter(
    (f) => !["scripts/encryption-key.sh", "scripts/db-snapshot.sh", "scripts/uploads-snapshot.sh", "secrets/.gitignore", "rotate-key.sh"].includes(f),
  );

  /** v1: the 663523c update.sh, both .bat files with CRLF in the index (what releases before this one shipped). */
  function preReleaseOrigin(): string {
    const origin = newOrigin((d) => {
      copyTree(d, PRE_RELEASE_TREE);
      fs.copyFileSync(path.join(ROOT, "scripts/fixtures/update.sh.develop-663523c"), path.join(d, "update.sh"));
      fs.chmodSync(path.join(d, "update.sh"), 0o755); // as Git records it in a real clone
      fs.writeFileSync(path.join(d, ".gitattributes"), "*.bat text eol=crlf\n");
      for (const f of ["install.bat", "update.bat"]) fs.writeFileSync(path.join(d, f), BAT_V1);
    });
    stageCrlfBats(origin, BAT_V1);
    git(origin, "commit", "-q", "--amend", "--no-edit");
    expect(git(origin, "show", "HEAD:update.sh")).toBe(fs.readFileSync(path.join(ROOT, "scripts/fixtures/update.sh.develop-663523c"), "utf8").trim());
    return origin;
  }

  /** v2: THIS release — the current tree, and both .bat files changed (LF in the index, as this release renormalised them). */
  function pushThisRelease(origin: string) {
    commitAll(origin, (d) => {
      copyTree(d);
      fs.chmodSync(path.join(d, "update.sh"), 0o755);
      for (const f of ["install.bat", "update.bat"]) fs.writeFileSync(path.join(d, f), BAT_V2);
    }, "this release");
  }

  it("premise: the markers exist and wrap a real recovery command", () => {
    const script = extractReadmeBlock("posix");
    expect(script).toContain("git pull");
    expect(script).toContain("./update.sh");
    expect(script).toContain("info/attributes");
  });

  it("POSIX block: on a CRLF-dirty clone, the pull succeeds and no stray attributes file is left", () => {
    const script = extractReadmeBlock("posix");
    const origin = preReleaseOrigin();
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    touchBats(work);
    // Premise: Git reports both files modified although no byte changed, and
    // a plain pull of a release that changes them aborts (same premise as
    // the "CRLF-in-index checkout" scenario above).
    expect(git(work, "status", "--porcelain", "--", "install.bat", "update.bat")).toMatch(/M install\.bat[\s\S]*M update\.bat/);
    pushThisRelease(origin);
    const plain = spawnSync("git", ["pull", "-q"], { cwd: work, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig") } });
    expect(plain.status).not.toBe(0);
    // ...and the clone's own update.sh is the pre-release one (no self-heal).
    expect(fs.readFileSync(path.join(work, "update.sh"), "utf8")).not.toContain("clear_bat_eol_only_changes");

    // A real clone's update.sh is executable (Git records the bit); the
    // recovery command's last line runs it directly (`./update.sh`), unlike
    // this harness's own `run()`, which always invokes scripts via `bash
    // <script>` and so never depends on the executable bit.
    fs.chmodSync(path.join(work, "update.sh"), 0o755);
    fs.writeFileSync(path.join(work, "recovery.sh"), script);
    const before = git(work, "rev-parse", "HEAD");
    const r = run(work, "recovery.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).not.toBe(before);
    expect(fs.existsSync(path.join(work, ".git/info/attributes"))).toBe(false);
    // The README's last line ran the PULLED (this release's) update.sh: it created the key and snapshotted first.
    expect(fs.readFileSync(path.join(work, "update.sh"), "utf8")).toBe(fs.readFileSync(path.join(ROOT, "update.sh"), "utf8"));
    expect(r.calls).toMatch(/AT-APP-START backups=\[blackvault-\d{8}-\d{6}\.db \] key=yes/);
  });

  it("POSIX block: restores an EXISTING .git/info/attributes byte for byte, even with no trailing newline", () => {
    const script = extractReadmeBlock("posix");
    const origin = preReleaseOrigin();
    const work = path.join(tmp, "work");
    git(tmp, "clone", "-q", origin, work);
    sqliteInstall(work);
    touchBats(work);
    fs.mkdirSync(path.join(work, ".git/info"), { recursive: true });
    // No trailing newline (fix round 1, I2): the exact case the ORIGINAL
    // recovery command's `printf '...' >> "$ATTRS"` glued onto, corrupting
    // the user's last line.
    fs.writeFileSync(path.join(work, ".git/info/attributes"), "*.png binary");
    pushThisRelease(origin);

    fs.chmodSync(path.join(work, "update.sh"), 0o755);
    fs.writeFileSync(path.join(work, "recovery.sh"), script);
    const before = git(work, "rev-parse", "HEAD");
    const r = run(work, "recovery.sh", "\n\n");
    expect(r.code, r.out).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).not.toBe(before);
    expect(fs.readFileSync(path.join(work, ".git/info/attributes"), "utf8")).toBe("*.png binary");
  });
  }); // close nested "README recovery command" describe
});
