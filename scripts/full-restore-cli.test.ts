/**
 * scripts/entry/full-restore.ts, bundled exactly as the image ships it
 * (scripts/build-scripts.mjs → <out>/full-restore.mjs) and run under plain
 * `node` as a child process. Two scratch installs, each with its own SQLite
 * database (`connection_limit=1`), uploads root and ENCRYPTION KEY: the
 * backup is made on A by the bundled full-backup CLI, and restored onto B
 * by the bundled full-restore CLI. This pins the contract restore.sh /
 * restore.bat build on: the passphrase comes from stdin only, the one-line
 * stdout, one `full-restore: …` line on stderr, exit 0 / 1.
 *
 * What the engine does at each failure point is in
 * src/lib/backup/full-restore.real-db.test.ts. This file lives in scripts/,
 * not scripts/entry/ (every *.ts there is bundled as an entry point).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildScripts } from "./build-scripts.mjs";
import { decryptFile, deriveKeys, encryptFile, fileKeyId, parseKeyHex } from "@/lib/encryption/core.mjs";

const ROOT = path.resolve(__dirname, "..");
const PASS = "cli restore passphrase ünïcode";
const KEY_A = "a1a2a3a4a5a6a7a8a9a0b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9c0d1d2";
const KEY_B = "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const STAMP = "20261003-121314";
const OK_LINE = /^BLACKVAULT_FULL_RESTORE_OK file=(blackvault-full-\d{8}-\d{6}\.bvb) files=(\d+) bytes=(\d+) pre_restore=(\.pre-restore-\d{8}-\d{6})\n$/;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const IMG = Buffer.from("cli restore image bytes ".repeat(500));
const DOC = Buffer.from("%PDF cli restore document");

let tmp: string;
let outDir: string;
let backupBundle: string;
let restoreBundle: string;
let backups: string;
let archive: string;

interface Install {
  db: string;
  uploads: string;
  env: NodeJS.ProcessEnv;
  keys: ReturnType<typeof deriveKeys>;
}
let a: Install;
let b: Install;

function makeInstall(name: string, keyHex: string): Install {
  const dir = path.join(tmp, name);
  const db = path.join(dir, "t.db");
  const uploads = path.join(dir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `file:${db}` },
    stdio: "pipe",
    timeout: 90_000,
  });
  return {
    db,
    uploads,
    keys: deriveKeys(parseKeyHex(keyHex)),
    env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${db}?connection_limit=1`, IMAGE_UPLOAD_DIR: uploads, BLACKVAULT_ENCRYPTION_KEY: keyHex },
  };
}

function put(install: Install, rel: string, plaintext: Buffer) {
  const abs = path.join(install.uploads, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, encryptFile(install.keys, path.basename(abs), plaintext), { mode: 0o600 });
}

/** A tiny bundled helper that talks to an install's database through the app client, so fields are en/decrypted under ITS key. */
const PROBE = `
import { prisma } from "@/lib/prisma";
async function main() {
  const [cmd, name, serial] = process.argv.slice(2);
  if (cmd === "seed") {
    await prisma.firearm.deleteMany();
    await prisma.firearm.create({ data: { name, manufacturer: "M", model: "X", caliber: "9mm", serialNumber: serial, type: "PISTOL", acquisitionDate: new Date("2024-01-01T00:00:00.000Z") } });
  }
  const rows = await prisma.firearm.findMany({ orderBy: { name: "asc" } });
  console.log("ROWS=" + JSON.stringify(rows.map((r) => ({ name: r.name, serialNumber: r.serialNumber }))));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
`;
let probeBundle: string;

function probe(install: Install, args: string[]): Array<{ name: string; serialNumber: string }> {
  const r = spawnSync(process.execPath, [probeBundle, ...args], { cwd: ROOT, env: install.env, encoding: "utf8", timeout: 120_000 });
  const line = r.stdout.split("\n").find((l) => l.startsWith("ROWS="));
  if (r.status !== 0 || !line) throw new Error(`probe failed: ${r.stdout}${r.stderr}`);
  return JSON.parse(line.slice(5));
}
const seed = (install: Install, name: string, serial: string) => probe(install, ["seed", name, serial]);
const firearms = (install: Install) => probe(install, ["list"]);

function restoreCli(args: string[], input: string | Buffer = `${PASS}\n`, env: NodeJS.ProcessEnv = b.env) {
  const r = spawnSync(process.execPath, [restoreBundle, ...args], { cwd: ROOT, env, input, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string, rel: string) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const child = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (fs.lstatSync(child).isDirectory()) visit(child, childRel);
      else out[childRel] = sha(fs.readFileSync(child));
    }
  };
  visit(dir, "");
  return out;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bv-full-restore-cli-"));
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  outDir = fs.mkdtempSync(path.join(ROOT, "dist", "bv-test-out-"));
  const built = await buildScripts({ outDir });
  backupBundle = path.join(outDir, "full-backup.mjs");
  restoreBundle = path.join(outDir, "full-restore.mjs");
  expect(built).toContain(restoreBundle);
  const probeEntry = path.join(tmp, "probe-entry");
  fs.mkdirSync(probeEntry);
  fs.writeFileSync(path.join(probeEntry, "db-probe.ts"), PROBE);
  await buildScripts({ entryDir: probeEntry, outDir });
  probeBundle = path.join(outDir, "db-probe.mjs");

  a = makeInstall("a", KEY_A);
  b = makeInstall("b", KEY_B);
  seed(a, "From the backup", "SER-A-CLI-1");
  put(a, "images/firearms/a.jpg", IMG);
  put(a, "documents/d.pdf", DOC);
  seed(b, "Target's own", "SER-B-CLI-9");
  put(b, "images/firearms/only-on-b.jpg", DOC);

  backups = path.join(tmp, "backups");
  fs.mkdirSync(backups, { mode: 0o700 });
  const made = spawnSync(process.execPath, [backupBundle, "--dir", backups], { cwd: ROOT, env: a.env, input: `${PASS}\n`, encoding: "utf8", timeout: 120_000 });
  expect(made.status, made.stderr).toBe(0);
  archive = fs.readdirSync(backups).find((f) => f.endsWith(".bvb"))!;
}, 300_000);

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
});

describe("full-restore CLI (bundled, plain node)", () => {
  it("refuses without changing anything: a wrong passphrase, no passphrase, a missing file, a bad stamp, an unknown argument (never echoed)", () => {
    const before = { files: tree(b.uploads), db: sha(fs.readFileSync(b.db)) };
    const cases: Array<[string[], string, RegExp]> = [
      [["--dir", backups, "--stamp", STAMP, archive], "definitely the wrong passphrase\n", /^full-restore: .*passphrase/i],
      [["--dir", backups, "--stamp", STAMP, archive], "", /^full-restore: no passphrase was supplied on standard input\. Nothing was changed\.\n$/],
      [["--dir", backups, "--stamp", STAMP, "blackvault-full-19990101-000000.bvb"], `${PASS}\n`, /^full-restore: .*ENOENT/],
      [["--dir", backups, "--stamp", "../../x", archive], `${PASS}\n`, /^full-restore: The restore stamp must look like/],
      [["--dir", backups, archive, "typed-passphrase-by-mistake"], `${PASS}\n`, /^full-restore: unknown argument\. Usage: /],
      [["--passphrase", "typed-passphrase-by-mistake", archive], `${PASS}\n`, /^full-restore: unknown argument\. Usage: /],
      [["--dir", backups], `${PASS}\n`, /^full-restore: no backup file was given\./],
    ];
    for (const [args, input, message] of cases) {
      const r = restoreCli(args, input);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(message);
      expect(r.stderr.trim().split("\n")).toHaveLength(1);
      expect(r.stderr).not.toContain("typed-passphrase-by-mistake");
    }
    expect(tree(b.uploads)).toEqual(before.files);
    expect(sha(fs.readFileSync(b.db))).toBe(before.db);
    expect(firearms(b)).toEqual([{ name: "Target's own", serialNumber: "SER-B-CLI-9" }]);
  }, 240_000);

  it("restores A's backup onto B (a different key): exit 0, one stdout line, A's records and files under B's key, B's own files in .pre-restore-<stamp>/", () => {
    const r = restoreCli(["--dir", backups, "--stamp", STAMP, archive], `${PASS}\r\n`); // one trailing CRLF is dropped
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const m = OK_LINE.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    expect(m!.slice(1)).toEqual([archive, "2", String(IMG.length + DOC.length), `.pre-restore-${STAMP}`]);

    expect(firearms(b)).toEqual([{ name: "From the backup", serialNumber: "SER-A-CLI-1" }]);
    const files = tree(b.uploads);
    expect(Object.keys(files).sort()).toEqual([`.pre-restore-${STAMP}/images/firearms/only-on-b.jpg`, "documents/d.pdf", "images/firearms/a.jpg"]);
    for (const [rel, plain] of [["images/firearms/a.jpg", IMG], ["documents/d.pdf", DOC]] as Array<[string, Buffer]>) {
      const stored = fs.readFileSync(path.join(b.uploads, rel));
      expect(fileKeyId(stored)).toBe(b.keys.id);
      expect(fileKeyId(stored)).not.toBe(a.keys.id);
      expect(sha(decryptFile(b.keys, path.basename(rel), stored))).toBe(sha(plain));
    }
    // The same stamp again: this run's .pre-restore folder exists, so it refuses instead of overwriting it.
    const again = restoreCli(["--dir", backups, "--stamp", STAMP, archive]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/^full-restore: .*already exists.*Nothing was changed\.\n$/);
  }, 240_000);
});
