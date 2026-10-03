/**
 * scripts/entry/full-backup.ts, bundled exactly as the image ships it
 * (scripts/build-scripts.mjs → <out>/full-backup.mjs) and run under plain
 * `node` as a child process, against a scratch SQLite database
 * (`connection_limit=1`), a scratch uploads root and a scratch backup
 * folder. This pins the contract backup.sh / backup.bat build on: the
 * passphrase comes from stdin only, the one-line stdout format, the exit
 * codes (0 ok, 1 failed, 2 already running).
 *
 * This test lives in scripts/, NOT scripts/entry/: the build bundles every
 * `*.ts` in scripts/entry/ as an entry point, a test file included.
 *
 * RUN_SLOW_TESTS=1 adds the memory test: a child process running ONLY the
 * backup engine over 2 GiB of uploads must peak under 300 MB RSS on Linux
 * (512 MB on other platforms — ruling R8).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildScripts } from "./build-scripts.mjs";
import { writeEncryptedFile } from "@/lib/files/storage";

const ROOT = path.resolve(__dirname, "..");
const PASS = "cli test passphrase ünïcode";
const OK_LINE = /^BLACKVAULT_FULL_BACKUP_OK file=(blackvault-full-\d{8}-\d{6}\.bvb) files=(\d+) bytes=(\d+) archive_bytes=(\d+) skipped=(\d+) unreadable=(\d+)\n$/;
const VERIFIED_LINE = /^BLACKVAULT_FULL_BACKUP_VERIFIED file=(blackvault-full-\d{8}-\d{6}\.bvb) files=(\d+) bytes=(\d+) archive_bytes=(\d+)\n$/;
const isPosixNonRoot = process.platform !== "win32" && process.getuid?.() !== 0;

let tmp: string;
let outDir: string;
let bundle: string;
let uploads: string;
let backups: string;
let childEnv: NodeJS.ProcessEnv;
let seq = 0;

const IMG = Buffer.from("cli image bytes ".repeat(1000));
const DOC = Buffer.from("%PDF cli document");

function cli(args: string[], input: string | Buffer = `${PASS}\n`, timeout = 120_000) {
  const r = spawnSync(process.execPath, [bundle, ...args], { cwd: ROOT, env: childEnv, input, encoding: "utf8", timeout });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-full-backup-cli-"));
  // Under this repo's (gitignored) dist/, so the bundle resolves the
  // externalised @prisma/client the way dist/scripts/ does in the image.
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  outDir = fs.mkdtempSync(path.join(ROOT, "dist", "bv-test-out-"));
  const built = await buildScripts({ outDir });
  bundle = path.join(outDir, "full-backup.mjs");
  expect(built).toContain(bundle);

  const db = path.join(tmp, "t.db");
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${db}` },
    stdio: "pipe",
    timeout: 90_000,
  });

  uploads = path.join(tmp, "uploads");
  fs.mkdirSync(path.join(uploads, "images"), { recursive: true });
  fs.mkdirSync(path.join(uploads, "documents"), { recursive: true });
  await writeEncryptedFile(path.join(uploads, "images", "a.jpg"), IMG);
  await writeEncryptedFile(path.join(uploads, "documents", "d.pdf"), DOC);

  // The child inherits the fixed test key (vitest.config.ts test.env).
  childEnv = { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${db}?connection_limit=1`, IMAGE_UPLOAD_DIR: uploads };
}, 180_000);

afterAll(() => {
  if (tmp) {
    if (process.platform !== "win32") {
      for (const d of fs.readdirSync(tmp)) if (d.startsWith("backups-")) fs.chmodSync(path.join(tmp, d), 0o700);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

beforeEach(() => {
  backups = path.join(tmp, `backups-${++seq}`);
  fs.mkdirSync(backups, { mode: 0o700 });
});

describe("full-backup CLI (bundled, plain node)", () => {
  it("makes a backup with the passphrase on stdin: exit 0, exactly one parseable stdout line, a 0600 .bvb and nothing else in the folder", () => {
    const r = cli(["--dir", backups]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const m = OK_LINE.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    const [, file, files, bytes, archiveBytes, skipped, unreadable] = m!;
    expect(Number(unreadable)).toBe(0);
    expect(fs.readdirSync(backups)).toEqual([file]);
    expect(Number(files)).toBe(2);
    expect(Number(bytes)).toBe(IMG.length + DOC.length);
    expect(Number(archiveBytes)).toBe(fs.statSync(path.join(backups, file)).size);
    expect(Number(skipped)).toBe(0);
    if (process.platform !== "win32") expect(fs.statSync(path.join(backups, file)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(backups, file)).includes(Buffer.from("cli image bytes"))).toBe(false);
  });

  it("R9: an unreadable file is skipped with a WARNING line per file and a final count on stderr; exit 0, and the backup verifies", async () => {
    const dirty = path.join(tmp, "uploads-dirty");
    fs.mkdirSync(path.join(dirty, "images"), { recursive: true });
    await writeEncryptedFile(path.join(dirty, "images", "good.jpg"), IMG);
    await writeEncryptedFile(path.join(dirty, "images", "corrupt.jpg"), IMG);
    const corrupt = fs.readFileSync(path.join(dirty, "images", "corrupt.jpg"));
    corrupt[corrupt.length - 40] ^= 0xff;
    fs.writeFileSync(path.join(dirty, "images", "corrupt.jpg"), corrupt);

    const r = spawnSync(process.execPath, [bundle, "--dir", backups], {
      cwd: ROOT,
      env: { ...childEnv, IMAGE_UPLOAD_DIR: dirty },
      input: `${PASS}\n`,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status).toBe(0);
    const m = OK_LINE.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(m!.slice(2)).toEqual(["1", String(IMG.length), m![4], "1", "1"]);
    expect(r.stderr.split("\n").filter(Boolean)).toEqual([
      "WARNING: skipped files/images/corrupt.jpg: unreadable: could not be decrypted (AUTH_FAILED)",
      "WARNING: 1 file could not be read and is NOT in this backup.",
    ]);
    const v = cli(["--dir", backups, "--verify", m![1]]);
    expect(v.status).toBe(0);
    expect(VERIFIED_LINE.exec(v.stdout)!.slice(2, 4)).toEqual(["1", String(IMG.length)]);
  });

  it("--verify accepts that backup by bare name (looked up in --dir) and by path, with CRLF or no line ending on the passphrase", () => {
    const file = OK_LINE.exec(cli(["--dir", backups]).stdout)![1];

    const bare = cli(["--dir", backups, "--verify", file], `${PASS}\r\n`);
    expect(bare.stderr).toBe("");
    expect(bare.status).toBe(0);
    const m = VERIFIED_LINE.exec(bare.stdout);
    expect(m, bare.stdout).not.toBeNull();
    expect(m!.slice(1, 4)).toEqual([file, "2", String(IMG.length + DOC.length)]);

    const abs = cli(["--verify", path.join(backups, file)], PASS);
    expect(abs.status).toBe(0);
    expect(VERIFIED_LINE.test(abs.stdout)).toBe(true);
    // Verify writes nothing.
    expect(fs.readdirSync(backups)).toEqual([file]);
  });

  it("--verify with the wrong passphrase, or on a damaged file: exit 1, one clear stderr line, empty stdout, passphrase never echoed", () => {
    const file = OK_LINE.exec(cli(["--dir", backups]).stdout)![1];

    const wrong = cli(["--dir", backups, "--verify", file], "definitely the wrong one\n");
    expect(wrong.status).toBe(1);
    expect(wrong.stdout).toBe("");
    expect(wrong.stderr).toMatch(/^full-backup: .*passphrase.*\n$/i);
    expect(wrong.stderr).not.toContain("definitely the wrong one");

    const abs = path.join(backups, file);
    fs.truncateSync(abs, fs.statSync(abs).size - 50);
    const cut = cli(["--dir", backups, "--verify", file]);
    expect(cut.status).toBe(1);
    expect(cut.stdout).toBe("");
    expect(cut.stderr.trim().split("\n")).toHaveLength(1);
    expect(cut.stderr).not.toContain(PASS);

    const missing = cli(["--dir", backups, "--verify", "blackvault-full-20000101-000000.bvb"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/^full-backup: .*ENOENT/);
  });

  it("exits 2 when another backup holds the lock, and creates nothing", () => {
    const lock = path.join(backups, ".full-backup.lock");
    // This test process: alive for as long as the child runs.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: os.hostname(), token: "holder" }));
    const r = cli(["--dir", backups]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^full-backup: Another full backup is already running/);
    expect(fs.readdirSync(backups)).toEqual([".full-backup.lock"]);
    expect(JSON.parse(fs.readFileSync(lock, "utf8")).token).toBe("holder");
  });

  it("R10: a lock from ANOTHER host with a fresh heartbeat → exit 2; once its heartbeat is over 5 minutes old it is reclaimed and the backup runs", () => {
    const lock = path.join(backups, ".full-backup.lock");
    // pid 1 exists in every container and on this machine: a pid check alone would call this live forever.
    fs.writeFileSync(lock, JSON.stringify({ pid: 1, startedAt: new Date().toISOString(), hostname: "another-container", token: "theirs" }));
    const blocked = cli(["--dir", backups]);
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toMatch(/already running \(pid 1 on another-container/);

    const old = new Date(Date.now() - 6 * 60_000);
    fs.utimesSync(lock, old, old);
    const started = Date.now();
    const ok = cli(["--dir", backups]);
    expect(ok.status).toBe(0);
    expect(OK_LINE.test(ok.stdout)).toBe(true);
    expect(fs.readdirSync(backups)).toHaveLength(1); // the .bvb only: lock and reclaim guard are gone
    // The 30 s heartbeat timer did not keep the process alive.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("a missing backup folder: exit 1 with a message that names the folder", () => {
    const missing = path.join(tmp, "no-such-backups");
    const r = cli(["--dir", missing]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(missing);
  });

  it.runIf(isPosixNonRoot)("a backup folder that is not writable: exit 1 with a message that names the folder", () => {
    fs.chmodSync(backups, 0o500);
    const r = cli(["--dir", backups]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(backups);
    expect(r.stderr).toMatch(/not writable/);
  });

  it("no passphrase, a too-short passphrase, or an unknown argument: exit 1, nothing created, the argument is not echoed", () => {
    const empty = cli(["--dir", backups], "");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/no passphrase/);

    const short = cli(["--dir", backups], "short\n");
    expect(short.status).toBe(1);
    expect(short.stderr).toMatch(/^full-backup: .*12/);

    const arg = cli(["--dir", backups, "--passphrase", "secret-on-argv-by-mistake"]);
    expect(arg.status).toBe(1);
    expect(arg.stderr).toMatch(/unknown argument/);
    expect(arg.stderr).not.toContain("secret-on-argv-by-mistake");

    expect(fs.readdirSync(backups)).toEqual([]);
  });

  it.runIf(!!process.env.RUN_SLOW_TESTS)(
    "RSS: a child process running only the backup engine over 2 GiB of uploads peaks under 300 MB on Linux (512 MB elsewhere)",
    async () => {
      // 128 hard links to ONE encrypted 16 MiB file: 2 GiB to back up, 16 MiB
      // on disk ("sparse" source data). BVF1 binds the file's basename, so
      // every link has the same name in its own folder.
      const FILE_BYTES = 16 * 1024 * 1024;
      const COUNT = 128;
      const big = path.join(tmp, "uploads-big");
      const first = path.join(big, "images", "d000", "blob.bin");
      fs.mkdirSync(path.dirname(first), { recursive: true });
      await writeEncryptedFile(first, randomBytes(FILE_BYTES));
      for (let i = 1; i < COUNT; i++) {
        const dir = path.join(big, "images", `d${String(i).padStart(3, "0")}`);
        fs.mkdirSync(dir);
        fs.linkSync(first, path.join(dir, "blob.bin"));
      }

      // A probe entry that runs ONLY the engine and reports its own peak RSS.
      const entryDir = path.join(tmp, "probe-entry");
      fs.mkdirSync(entryDir);
      fs.writeFileSync(
        path.join(entryDir, "rss-probe.ts"),
        [
          'import { runFullBackup } from "@/lib/backup/full-backup";',
          'import { prisma } from "@/lib/prisma";',
          "async function main() {",
          "  const chunks: Buffer[] = [];",
          "  for await (const c of process.stdin) chunks.push(Buffer.from(c));",
          '  const result = await runFullBackup({ passphrase: Buffer.concat(chunks).toString("utf8").trim(), dir: process.argv[2] });',
          "  await prisma.$disconnect();",
          // process.resourceUsage().maxRSS is the peak resident set size, in kilobytes.
          "  console.log(JSON.stringify({ files: result.files, bytes: result.bytes, maxRssKb: process.resourceUsage().maxRSS }));",
          "}",
          "main().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });",
        ].join("\n"),
      );
      await buildScripts({ entryDir, outDir });

      const r = spawnSync(process.execPath, [path.join(outDir, "rss-probe.mjs"), backups], {
        cwd: ROOT,
        env: { ...childEnv, IMAGE_UPLOAD_DIR: big },
        input: `${PASS}\n`,
        encoding: "utf8",
        timeout: 600_000,
      });
      expect(r.stderr).toBe("");
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout.trim().split("\n").pop()!);
      expect(out.files).toBe(COUNT);
      expect(out.bytes).toBe(COUNT * FILE_BYTES);
      const peakMb = out.maxRssKb / 1024;
      // Ruling R8: the 300 MB cap is the spec's, and it is asserted on Linux —
      // the image is the supported runtime. Elsewhere (a macOS dev machine
      // counts freed-but-not-yet-reclaimed pages in RSS and measures ~385 MB
      // for the same run) the bound is 512 MB, and the peak is logged.
      const capMb = process.platform === "linux" ? 300 : 512;
      console.log(`[rss] full backup of ${(out.bytes / 2 ** 30).toFixed(2)} GiB on ${process.platform}: peak RSS ${peakMb.toFixed(1)} MB (cap ${capMb} MB)`);
      expect(peakMb).toBeLessThan(capMb);
    },
    660_000,
  );
});
