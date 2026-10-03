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

  it("R26: a file whose name a restore would refuse is left out with a WARNING (shown without the control character) and counted; exit 0, and the backup verifies", async () => {
    const odd = path.join(tmp, "uploads-odd-names");
    fs.mkdirSync(path.join(odd, "images"), { recursive: true });
    await writeEncryptedFile(path.join(odd, "images", "good.jpg"), IMG);
    await writeEncryptedFile(path.join(odd, "images", "be\u0007ll.jpg"), IMG);
    const r = spawnSync(process.execPath, [bundle, "--dir", backups], { cwd: ROOT, env: { ...childEnv, IMAGE_UPLOAD_DIR: odd }, input: `${PASS}\n`, encoding: "utf8", timeout: 120_000 });
    expect(r.status).toBe(0);
    const m = OK_LINE.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(m!.slice(2)).toEqual(["1", String(IMG.length), m![4], "1", "1"]);
    expect(r.stderr.split("\n").filter(Boolean)).toEqual([
      "WARNING: skipped files/images/be?ll.jpg: unsupported file name (its name contains a control character)",
      "WARNING: 1 file could not be read and is NOT in this backup.",
    ]);
    expect(cli(["--dir", backups, "--verify", m![1]]).status).toBe(0);
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

  it("fix round 1: a folder-fsync failure after the rename → exit 0, the OK line, the .bvb in place, and one WARNING line on stderr", () => {
    // Preloaded into the child: opening the backup FOLDER read-only (the folder fsync) fails with EIO.
    const preload = path.join(tmp, `dir-fsync-eio-${seq}.cjs`);
    fs.writeFileSync(
      preload,
      [
        'const fsp = require("node:fs").promises;',
        "const realOpen = fsp.open.bind(fsp);",
        "fsp.open = async (p, flags, ...rest) => {",
        `  if (String(p) === ${JSON.stringify(backups)} && flags === "r") throw Object.assign(new Error("EIO: i/o error, open"), { code: "EIO", syscall: "open" });`,
        "  return realOpen(p, flags, ...rest);",
        "};",
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, ["--require", preload, bundle, "--dir", backups], {
      cwd: ROOT,
      env: childEnv,
      input: `${PASS}\n`,
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(r.status).toBe(0);
    const m = OK_LINE.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(fs.readdirSync(backups)).toEqual([m![1]]);
    const lines = r.stderr.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^WARNING: .*EIO/);
    expect(cli(["--dir", backups, "--verify", m![1]]).status).toBe(0);
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

  describe("--keep (ruling R18: pruning runs here, in the same invocation as the backup)", () => {
    const backupFiles = () => fs.readdirSync(backups).filter((n) => /^blackvault-full-\d{8}-\d{6}\.bvb$/.test(n)).sort();
    /** Makes `n` good backups with the bare CLI (no --keep) and returns their names, oldest first. */
    function seed(n: number): string[] {
      for (let i = 0; i < n; i++) {
        const r = cli(["--dir", backups]);
        expect(r.status, r.stderr).toBe(0);
      }
      const files = backupFiles();
      expect(files).toHaveLength(n); // the bare CLI never deletes anything
      return files;
    }
    const preloadFile = (name: string, lines: string[]) => {
      const p = path.join(tmp, `${name}-${seq}.cjs`);
      fs.writeFileSync(p, lines.join("\n"));
      return p;
    };
    const cliWithPreload = (preload: string, args: string[]) => {
      const r = spawnSync(process.execPath, ["--require", preload, bundle, ...args], { cwd: ROOT, env: childEnv, input: `${PASS}\n`, encoding: "utf8", timeout: 120_000 });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    };

    it("keep=2 with 4 good backups deletes exactly the 2 oldest, after the new one verified; stdout is still exactly the one OK line", () => {
      const old = seed(3);
      const strangers = ["blackvault-full-20200101-000000-offsite.bvb", "blackvault-full-20200101-000000.bvb.bak", "notes.txt"];
      for (const s of strangers) fs.writeFileSync(path.join(backups, s), "not a backup of ours");

      const r = cli(["--dir", backups, "--keep", "2"]);
      expect(r.status, r.stderr).toBe(0);
      const m = OK_LINE.exec(r.stdout);
      expect(m, r.stdout).not.toBeNull();
      const created = m![1];
      expect(old).not.toContain(created);
      // 4 good files existed when pruning ran; the 2 oldest are gone, in order.
      expect(r.stderr.split("\n").filter(Boolean)).toEqual([`full-backup: deleted old backup ${old[0]}`, `full-backup: deleted old backup ${old[1]}`]);
      expect(backupFiles()).toEqual([old[2], created]);
      expect(fs.readdirSync(backups).sort()).toEqual([...strangers, old[2], created].sort());
      for (const f of [old[2], created]) expect(cli(["--dir", backups, "--verify", f]).status).toBe(0);
    });

    it("a corrupted newest file (the new backup fails its verify): NOTHING is deleted, exit 1, empty stdout, no new .bvb", () => {
      const old = seed(3);
      const before = old.map((f) => fs.readFileSync(path.join(backups, f)));
      // Preloaded into the child: the sealed work file is damaged on disk
      // right before the engine verifies it (verify's first step is a stat).
      const preload = preloadFile("corrupt-partial", [
        'const fs = require("node:fs");',
        "const realStat = fs.promises.stat.bind(fs.promises);",
        "fs.promises.stat = async (p, ...rest) => {",
        '  if (String(p).endsWith(".bvb.partial")) {',
        '    const fd = fs.openSync(String(p), "r+");',
        "    const size = fs.fstatSync(fd).size;",
        "    const byte = Buffer.alloc(1);",
        "    fs.readSync(fd, byte, 0, 1, size - 40);",
        "    byte[0] ^= 0xff;",
        "    fs.writeSync(fd, byte, 0, 1, size - 40);",
        "    fs.closeSync(fd);",
        "  }",
        "  return realStat(p, ...rest);",
        "};",
      ]);
      const r = cliWithPreload(preload, ["--dir", backups, "--keep", "1"]);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^full-backup: .*(damaged|incomplete|verif)/i); // it failed in the verify step, not earlier
      expect(r.stderr).not.toContain("deleted old backup");
      expect(fs.readdirSync(backups).sort()).toEqual(old); // nothing deleted, nothing new, no .partial, no lock
      old.forEach((f, i) => expect(fs.readFileSync(path.join(backups, f)).equals(before[i])).toBe(true));
    });

    it("the backup fails before anything is written (lock held): exit 2 and nothing is deleted", () => {
      const old = seed(2);
      const lock = path.join(backups, ".full-backup.lock");
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), hostname: os.hostname(), token: "holder" }));
      const r = cli(["--dir", backups, "--keep", "1"]);
      expect(r.status).toBe(2);
      expect(backupFiles()).toEqual(old);
    });

    it("an old backup that cannot be deleted is a WARNING naming it; the run still exits 0 and the others are deleted", () => {
      const old = seed(3);
      const preload = preloadFile("unlink-eacces", [
        'const fs = require("node:fs");',
        "const realUnlink = fs.promises.unlink.bind(fs.promises);",
        "fs.promises.unlink = async (p) => {",
        `  if (String(p).endsWith(${JSON.stringify(old[0])})) throw Object.assign(new Error("EACCES: permission denied, unlink"), { code: "EACCES", syscall: "unlink" });`,
        "  return realUnlink(p);",
        "};",
      ]);
      const r = cliWithPreload(preload, ["--dir", backups, "--keep", "1"]);
      expect(r.status, r.stderr).toBe(0);
      const created = OK_LINE.exec(r.stdout)![1];
      const lines = r.stderr.split("\n").filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines).toContain(`full-backup: deleted old backup ${old[1]}`);
      expect(lines).toContain(`full-backup: deleted old backup ${old[2]}`);
      expect(lines.find((l) => l.startsWith("WARNING: "))).toMatch(new RegExp(`${old[0].replace(/\./g, "\\.")}.*EACCES`));
      expect(backupFiles()).toEqual([old[0], created]);
    });

    it.each(["0", "-1", "1.5", "seven", "2e3", "1000000"])("--keep %s is refused before any work: exit 1, nothing created or deleted, stdin not even needed, the value not echoed", (value) => {
      const old = seed(1);
      const r = cli(["--dir", backups, "--keep", value], "");
      expect(r.status).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^full-backup: --keep needs a whole number/);
      if (value !== "0" && value !== "-1") expect(r.stderr).not.toContain(value);
      expect(fs.readdirSync(backups)).toEqual(old);
    });

    it("--keep without a value, and --keep together with --verify, are refused", () => {
      const old = seed(1);
      const bare = cli(["--dir", backups, "--keep"]);
      expect(bare.status).toBe(1);
      expect(bare.stderr).toMatch(/--keep needs a value/);
      const both = cli(["--dir", backups, "--keep", "1", "--verify", old[0]]);
      expect(both.status).toBe(1);
      expect(both.stderr).toMatch(/--keep cannot be used with --verify/);
      expect(fs.readdirSync(backups)).toEqual(old);
    });
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
