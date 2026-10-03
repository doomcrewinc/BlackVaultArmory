import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/**
 * Task 7 (spec 3c §3): the full-restore engine against a REAL database and
 * REAL folders, and — for the rollback — the REAL snapshot scripts
 * (scripts/uploads-snapshot.sh to take one, scripts/snapshot-restore.sh to
 * put it back), run on the host exactly as the POSIX installer tests run
 * them.
 * - default: a throw-away SQLite file with `connection_limit=1`;
 * - with ENCRYPTION_REAL_DB_PG_URL set, the same suite on PostgreSQL. There
 *   the database half of the snapshot restore is psql inside the db
 *   container (restore.sh), which vitest cannot run: those assertions are
 *   SQLite-only, and say so.
 * Scratch dirs only: the repo's uploads/, data/ and prisma/prisma/dev.db are
 * never touched.
 *
 * "A different key": the backup is made under key A (the fixed test key),
 * then the process switches to key B and builds a second install — other
 * records, other files — and restores onto it.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.ENCRYPTION_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-full-restore-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => null),
  requireAuth: vi.fn(async () => null),
  requireAdmin: vi.fn(async () => null),
}));

// The shared record restore, wrapped so a test can fail the run right before it (= after staging).
const coreHook = vi.hoisted(() => ({ failBefore: null as Error | null, calls: 0 }));
vi.mock("./restore-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./restore-core")>();
  return {
    ...actual,
    restoreBackupRecords: async (...args: Parameters<typeof actual.restoreBackupRecords>) => {
      coreHook.calls += 1;
      if (coreHook.failBefore) throw coreHook.failBefore;
      return actual.restoreBackupRecords(...args);
    },
  };
});

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient, prisma } from "@/lib/prisma";
import { createBackupSealer, envelopeKeyId, fileKeyId, isEncryptedFile, SealError } from "@/lib/encryption/core.mjs";
import { getFieldKeys, resetFieldKeysForTests } from "@/lib/encryption/keys";
import { readDecryptedFile, writeEncryptedFile } from "@/lib/files/storage";
import { runFileStartup } from "@/lib/files/startup";
import { BACKUP_MODELS } from "./models";
import { buildManifest } from "./manifest";
import { collectBackupRecords, buildBackupPayload, backupCounts } from "./records";
import { TarWriter } from "./tar";
import { runFullBackup } from "./full-backup";
import { FullBackupVerifyError, verifyFullBackup } from "./full-verify";
import { acquireFullBackupLock, FullBackupAlreadyRunningError } from "./full-lock";
import { FullRestoreError, runFullRestore } from "./full-restore";

// Every test here spawns shell scripts or does real fsyncs. The default 5 s limit only guards against a hang, and on a
// stalled machine it has failed tests that were doing nothing wrong; the engine calls keep their own 60 s race (`within`).
vi.setConfig({ testTimeout: 90_000 });

const ROOT = path.resolve(__dirname, "../../..");
const PASS = "correct horse battery staple";
const KEY_A = process.env.BLACKVAULT_ENCRYPTION_KEY!;
const KEY_B = "b1b2b3b4b5b6b7b8b9b0c1c2c3c4c5c6c7c8c9c0d1d2d3d4d5d6d7d8d9d0e1e2";
const STAMP = "20261003-101112";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const isPosix = process.platform !== "win32";

let raw: PrismaClient;
let work: string;
let rootA: string; // uploads of the install the backup is made on
let rootB: string; // uploads of the install it is restored onto
let backups: string; // where the .bvb goes
let snapshots: string; // the wrapper's backups/ (db + uploads snapshots)

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

function switchKey(hex: string): string {
  process.env.BLACKVAULT_ENCRYPTION_KEY = hex;
  resetFieldKeysForTests();
  return getFieldKeys().id;
}

async function upload(root: string, rel: string, plaintext: Buffer): Promise<void> {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  await writeEncryptedFile(abs, plaintext);
}

/** Every entry under `dir`, hidden ones included: relative path → sha256 of the raw bytes ("dir" / "link" otherwise). */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (abs: string, rel: string) => {
    for (const name of readdirSync(abs).sort()) {
      const child = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) out[childRel] = "link";
      else if (stat.isDirectory()) {
        out[childRel] = "dir";
        visit(child, childRel);
      } else out[childRel] = sha(readFileSync(child));
    }
  };
  visit(dir, "");
  return out;
}

type Delegates = Record<string, { findMany(args?: unknown): Promise<unknown[]>; deleteMany(): Promise<unknown> }>;

/** Every backup model's rows as stored (ciphertext), in a stable order. */
async function storedRows(): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const { delegate, key } of BACKUP_MODELS) {
    const rows = await within(10_000, (raw as unknown as Delegates)[delegate].findMany());
    out[key] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return JSON.stringify(out);
}

async function wipeRecords(): Promise<void> {
  for (const { delegate } of [...BACKUP_MODELS].reverse()) await within(10_000, (raw as unknown as Delegates)[delegate].deleteMany());
}

const IMG_A = Buffer.from("image A from the backup ".repeat(40));
const IMG_BIG = Buffer.alloc(1024 * 1024 + 77, 0x5a);
const DOC_C = Buffer.from("%PDF-1.4 document C from the backup");
const SAME_NAME_OLD = Buffer.from("the target's own version of a.jpg");
const EXTRA = Buffer.from("a photo that exists ONLY on the target install");

interface Source {
  archive: string;
  records: Record<string, unknown[]>;
  files: Record<string, string>; // uploads-relative path → sha256 of the plaintext
  keyIdA: string;
}

/** Install A (key A): two firearms, three files, one full backup. */
async function makeSource(): Promise<Source> {
  const keyIdA = switchKey(KEY_A);
  await wipeRecords();
  await within(20_000, prisma.firearm.create({
    data: { name: "Restored pistol", manufacturer: "Glock", model: "19", caliber: "9mm", serialNumber: "SER-A-0001", type: "PISTOL", acquisitionDate: new Date("2024-01-01T00:00:00.000Z") },
  }));
  await within(20_000, prisma.firearm.create({
    data: { name: "Restored rifle", manufacturer: "Ruger", model: "10/22", caliber: ".22LR", serialNumber: "SER-A-0002", type: "RIFLE", acquisitionDate: new Date("2023-05-05T00:00:00.000Z") },
  }));
  await upload(rootA, "images/firearms/a.jpg", IMG_A);
  await upload(rootA, "images/firearms/big.jpg", IMG_BIG);
  await upload(rootA, "documents/c.pdf", DOC_C);
  const result = await within(60_000, runFullBackup({ passphrase: PASS, dir: backups, env: { ...process.env, IMAGE_UPLOAD_DIR: rootA } as NodeJS.ProcessEnv }));
  const records = await within(20_000, collectBackupRecords());
  return {
    archive: result.path,
    records: JSON.parse(JSON.stringify(records)),
    files: { "images/firearms/a.jpg": sha(IMG_A), "images/firearms/big.jpg": sha(IMG_BIG), "documents/c.pdf": sha(DOC_C) },
    keyIdA,
  };
}

/** Install B (key B): a different record, a same-named file with other content, and files the backup does not have. */
async function makeTarget(): Promise<string> {
  const keyIdB = switchKey(KEY_B);
  await wipeRecords();
  await within(20_000, prisma.firearm.create({
    data: { name: "Target's old shotgun", manufacturer: "Mossberg", model: "500", caliber: "12ga", serialNumber: "SER-B-9999", type: "SHOTGUN", acquisitionDate: new Date("2020-02-02T00:00:00.000Z") },
  }));
  await upload(rootB, "images/firearms/a.jpg", SAME_NAME_OLD);
  await upload(rootB, "images/firearms/only-on-target.jpg", EXTRA);
  await upload(rootB, "documents/only-on-target.pdf", EXTRA);
  // Things no snapshot holds, which a rollback must still leave exactly as they were.
  writeFileSync(path.join(rootB, "images", "half.jpg.1a2b3c4d.tmp"), "interrupted write");
  writeFileSync(path.join(rootB, "images", "x.jpg.rot"), "rotation staging");
  mkdirSync(path.join(rootB, ".pre-encryption-20260101-000000"), { recursive: true });
  writeFileSync(path.join(rootB, ".pre-encryption-20260101-000000", "old.jpg"), "plaintext snapshot");
  return keyIdB;
}

const restore = (archive: string, over: Partial<Parameters<typeof runFullRestore>[0]> = {}) =>
  within(60_000, runFullRestore({ file: archive, passphrase: PASS, env: { ...process.env, IMAGE_UPLOAD_DIR: rootB } as NodeJS.ProcessEnv, stamp: STAMP, ...over }));

const sh = (args: string[]) => spawnSync("sh", args, { cwd: ROOT, encoding: "utf8", timeout: 60_000 });

/** What scripts/db-snapshot.sh leaves behind: the uploads copy (the REAL uploads-snapshot.sh) and, on SQLite, a copy of the database file. */
async function takeSnapshot(): Promise<{ uploads: string; db: string | null }> {
  mkdirSync(snapshots, { recursive: true });
  const r = sh([path.join(ROOT, "scripts/uploads-snapshot.sh"), rootB, snapshots, "uploads-snap"]);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  let db: string | null = null;
  if (!ctx.pg) {
    await prisma.$disconnect();
    await raw.$disconnect();
    db = path.join(snapshots, "blackvault-snap.db");
    copyFileSync(ctx.file, db); // db-snapshot.sh's SQLite branch is this `cp`, with the app stopped
  }
  return { uploads: path.join(snapshots, "uploads-snap"), db };
}

const MARKER = `.restore-${STAMP}.db-started`;
const markerExists = () => existsSync(path.join(rootB, MARKER));
const withoutMarker = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([p]) => !p.startsWith(MARKER)));

/**
 * The wrapper's rollback, as restore.sh does it (ruling R24): the uploads
 * first (scripts/snapshot-restore.sh), then the DATABASE — only when the
 * engine left its "database step started" marker — then the marker itself.
 * `dbRolledBack` says whether the database step ran.
 */
async function rollBackFromSnapshot(snap: { uploads: string; db: string | null }): Promise<{ out: string; dbRolledBack: boolean }> {
  const u = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "uploads", rootB, STAMP, snap.uploads]);
  expect(u.status, u.stdout + u.stderr).toBe(0);
  let out = u.stdout;
  const dbRolledBack = markerExists();
  if (dbRolledBack && snap.db) {
    await prisma.$disconnect();
    await raw.$disconnect();
    const d = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "sqlite", snap.db, ctx.file]);
    expect(d.status, d.stdout + d.stderr).toBe(0);
    out += d.stdout;
  }
  if (dbRolledBack) {
    const c = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "clear-marker", rootB, STAMP]);
    expect(c.status, c.stdout + c.stderr).toBe(0);
  }
  return { out, dbRolledBack };
}

const dbFileSha = () => (ctx.pg ? "(postgres)" : sha(readFileSync(ctx.file)));

/** Writes a sealed archive from explicit tar entries (for archives the real engine would never produce). */
async function craftArchive(name: string, entries: Array<[string, Buffer]>): Promise<string> {
  const out = path.join(backups, name);
  const sealer = createBackupSealer(PASS);
  const done = pipeline(sealer, createWriteStream(out));
  const tar = new TarWriter(sealer);
  for (const [p, body] of entries) await tar.addBuffer(p, body);
  await tar.finish();
  sealer.end();
  await done;
  return out;
}

async function validParts(files: Array<[string, Buffer]>) {
  const records = await within(20_000, collectBackupRecords());
  const now = new Date("2026-10-03T10:00:00.000Z");
  const db = Buffer.from(JSON.stringify(buildBackupPayload(records, { now, includeUploads: true })));
  const manifest = (listed: Array<[string, Buffer]>) =>
    Buffer.from(JSON.stringify(buildManifest({
      appVersion: "test", createdAt: now, keyIdAtBackup: "00000000", counts: backupCounts(records),
      files: listed.map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })),
    })));
  return { db, manifest, files };
}

describe.skipIf(!isPosix)(`runFullRestore against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` },
      stdio: "pipe",
      timeout: 90_000,
    });
    raw = createRawPrismaClient();
  }, 120_000);

  afterAll(async () => {
    switchKey(KEY_A);
    await wipeRecords().catch(() => undefined);
    await prisma.$disconnect();
    await raw?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await within(10_000, raw.auditEvent.deleteMany());
    work = path.join(ctx.dir, `w-${Math.random().toString(16).slice(2)}`);
    rootA = path.join(work, "install-a", "uploads");
    rootB = path.join(work, "install-b", "uploads");
    backups = path.join(work, "bvb");
    snapshots = path.join(work, "snapshots");
    for (const d of [rootA, rootB, backups]) mkdirSync(d, { recursive: true });
    coreHook.failBefore = null;
    coreHook.calls = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    switchKey(KEY_A);
  });

  it("restores onto an install with a DIFFERENT key: identical records, identical file sha256s, every value and file under the NEW key; the target's own files (Review Focus 4) are in .pre-restore-<ts>/", async () => {
    const source = await makeSource();
    const keyIdB = await makeTarget();
    expect(keyIdB).not.toBe(source.keyIdA);
    const targetBefore = tree(rootB);
    await within(10_000, raw.auditEvent.deleteMany());

    const result = await restore(source.archive);
    expect(result).toMatchObject({ file: path.basename(source.archive), files: 3, bytes: IMG_A.length + IMG_BIG.length + DOC_C.length, preRestore: `.pre-restore-${STAMP}`, warnings: [] });
    expect(result.counts.firearms).toBe(2);

    // Records: read back through the app client under key B, equal to what install A held.
    const after = JSON.parse(JSON.stringify(await within(20_000, collectBackupRecords())));
    expect(after).toEqual(source.records);
    // ...and at rest they are ciphertext under key B, not A.
    const stored = await within(10_000, raw.firearm.findMany());
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.serialNumber).not.toContain("SER-A");
      expect(envelopeKeyId(row.serialNumber!)).toBe(keyIdB);
    }

    // Files: exactly the backup's set, each BVF1 under key B, decrypting to the original bytes.
    const live = tree(rootB);
    const liveFiles = Object.keys(live).filter((p) => (p.startsWith("images/") || p.startsWith("documents/")) && live[p] !== "dir");
    expect(liveFiles.sort()).toEqual(Object.keys(source.files).sort());
    for (const rel of liveFiles) {
      const bytes = readFileSync(path.join(rootB, rel));
      expect(isEncryptedFile(bytes), rel).toBe(true);
      expect(fileKeyId(bytes), rel).toBe(keyIdB);
      expect(sha(await readDecryptedFile(path.join(rootB, rel))), rel).toBe(source.files[rel]);
    }

    // Review Focus 4: everything that was there before — the same-named file, the two files the backup
    // lacks, even the work files — is now under .pre-restore-<ts>/, byte for byte. Nothing was deleted.
    const pre = `.pre-restore-${STAMP}`;
    for (const [rel, digest] of Object.entries(targetBefore)) {
      if (!rel.startsWith("images") && !rel.startsWith("documents")) continue;
      expect(live[`${pre}/${rel}`], rel).toBe(digest);
    }
    expect(sha(await readDecryptedFile(path.join(rootB, pre, "images/firearms/only-on-target.jpg")))).toBe(sha(EXTRA));
    // What lives outside images/ and documents/ was not touched, and no staging folder is left.
    expect(live[".pre-encryption-20260101-000000/old.jpg"]).toBe(targetBefore[".pre-encryption-20260101-000000/old.jpg"]);
    expect(Object.keys(live).filter((p) => p.startsWith(".restore-"))).toEqual([]); // no staging folder, and the R24 marker was removed

    // The audit entry: written after the replace, attributed like the CLI's BACKUP_CREATED, and it survived.
    const events = await within(10_000, raw.auditEvent.findMany({ where: { action: "RESTORE" } }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorName: "system", entityLabel: path.basename(source.archive) });
    expect(JSON.parse(events[0].changes!)).toEqual({ full: true, file: path.basename(source.archive), files: 3 });
    // No row-level entries for the replaced rows.
    expect(await within(10_000, raw.auditEvent.count())).toBe(1);
  });

  it("audit entries written BEFORE the restore survive it (the audit table is not part of a backup)", async () => {
    const source = await makeSource();
    await makeTarget();
    await within(10_000, raw.auditEvent.deleteMany());
    await within(10_000, raw.auditEvent.create({ data: { action: "LOGIN", actorName: "someone", entityLabel: "before the restore" } }));
    await restore(source.archive);
    const actions = (await within(10_000, raw.auditEvent.findMany({ orderBy: { at: "asc" } }))).map((e) => e.action);
    expect(actions).toEqual(["LOGIN", "RESTORE"]);
  });

  it("after a restore, the 3b startup file scan accepts the uploads folder: .pre-restore-<ts>/ (and a leftover .restore-*/) never locks startup and is never encrypted or moved", async () => {
    const source = await makeSource();
    await makeTarget();
    await restore(source.archive);
    // A leftover staging folder and a pre-restore folder holding things the scan would refuse or change if it entered them.
    const pre = path.join(rootB, `.pre-restore-${STAMP}`);
    mkdirSync(path.join(rootB, ".restore-20260101-000000/images"), { recursive: true });
    writeFileSync(path.join(rootB, ".restore-20260101-000000/images/plain.jpg"), "plaintext in a leftover staging folder");
    writeFileSync(path.join(pre, "images/plain.jpg"), "plaintext in the pre-restore folder");
    switchKey(KEY_A);
    await writeEncryptedFile(path.join(pre, "images/foreign-key.jpg"), Buffer.from("under another key")); // would refuse startup
    switchKey(KEY_B);
    const hidden = { ...tree(pre), ...tree(path.join(rootB, ".restore-20260101-000000")) };

    const started = await within(60_000, runFileStartup(raw as never, { env: { ...process.env, IMAGE_UPLOAD_DIR: rootB } as NodeJS.ProcessEnv, cwd: path.join(work, "install-b") }));
    expect(started.snapshot).toBeNull(); // nothing plaintext was found, so nothing was snapshotted or encrypted
    expect(started.moved).toBe(0);
    expect({ ...tree(pre), ...tree(path.join(rootB, ".restore-20260101-000000")) }).toEqual(hidden);
  });

  it("a full backup made afterwards does not pick up .pre-restore-<ts>/ or .restore-*/", async () => {
    const source = await makeSource();
    await makeTarget();
    await restore(source.archive);
    mkdirSync(path.join(rootB, ".restore-20260101-000000/images"), { recursive: true });
    await upload(rootB, ".restore-20260101-000000/images/x.jpg", EXTRA);
    const again = await within(60_000, runFullBackup({ passphrase: PASS, dir: backups, now: new Date("2027-01-01T00:00:00Z"), env: { ...process.env, IMAGE_UPLOAD_DIR: rootB } as NodeJS.ProcessEnv }));
    expect(again.files).toBe(3);
  });

  /**
   * Ruling R26 — the invariant: for ANY uploads tree, a backup that verifies
   * restores. The backup leaves out (and reports) every name the restore
   * would refuse. The case / Unicode pairs can only exist on a filesystem
   * that keeps them apart (Linux, CI); the control-character name exists
   * everywhere.
   */
  it("R26: a tree with a control-character name and colliding names → the backup skips and reports them, verifies, and restores", async () => {
    const source = await makeSource(); // key A; rootA holds a.jpg, big.jpg, c.pdf
    const probe = path.join(work, "case-probe");
    mkdirSync(probe);
    writeFileSync(path.join(probe, "x"), "1");
    const caseSensitive = !existsSync(path.join(probe, "X"));
    const BELL = "images/firearms/be\u0007ll.jpg";
    await upload(rootA, BELL, EXTRA);
    await upload(rootA, "documents/line\nbreak.pdf", EXTRA);
    const expectedSkipped = [
      { path: "files/images/firearms/be?ll.jpg", kind: "unreadable", reason: "unsupported file name (its name contains a control character)" },
      { path: "files/documents/line?break.pdf", kind: "unreadable", reason: "unsupported file name (its name contains a control character)" },
    ];
    const kept: Record<string, string> = { ...source.files };
    if (caseSensitive) {
      await upload(rootA, "images/firearms/A.jpg", DOC_C); // sorts before a.jpg: A.jpg is kept, a.jpg skipped
      await upload(rootA, "images/Zdir/x.jpg", DOC_C);
      await upload(rootA, "images/zdir", EXTRA); // a FILE that collides with the folder Zdir/: the folder (first) is kept
      kept["images/firearms/A.jpg"] = sha(DOC_C);
      kept["images/Zdir/x.jpg"] = sha(DOC_C);
      delete kept["images/firearms/a.jpg"];
      expectedSkipped.splice(
        0,
        0,
        { path: "files/images/firearms/a.jpg", kind: "unreadable", reason: 'unsupported file name (it would be the same file or folder as "files/images/firearms/A.jpg" on a system that ignores case or accents)' },
      );
      expectedSkipped.splice(2, 0, { path: "files/images/zdir", kind: "unreadable", reason: 'unsupported file name (it would be the same file or folder as "files/images/Zdir/x.jpg" on a system that ignores case or accents)' });
    }

    const made = await within(60_000, runFullBackup({ passphrase: PASS, dir: backups, now: new Date("2027-02-02T00:00:00Z"), env: { ...process.env, IMAGE_UPLOAD_DIR: rootA } as NodeJS.ProcessEnv }));
    expect(made.skipped).toEqual(expect.arrayContaining(expectedSkipped));
    expect(made.skipped).toHaveLength(expectedSkipped.length);
    expect(made.files).toBe(Object.keys(kept).length);
    // It verified (the engine verifies before publishing; once more, independently).
    await expect(verifyFullBackup(made.path, PASS)).resolves.toMatchObject({ files: made.files });

    await makeTarget();
    const result = await restore(made.path);
    expect(result.files).toBe(made.files);
    const live = tree(rootB);
    const liveFiles = Object.keys(live).filter((p) => (p.startsWith("images/") || p.startsWith("documents/")) && live[p] !== "dir");
    expect(liveFiles.sort()).toEqual(Object.keys(kept).sort());
    for (const rel of liveFiles) expect(sha(await readDecryptedFile(path.join(rootB, rel))), rel).toBe(kept[rel]);
  });

  describe("refused before any change", () => {
    async function expectUntouched(run: () => Promise<unknown>, error: unknown, message?: RegExp) {
      await makeTarget();
      const before = { files: tree(rootB), rows: await storedRows(), db: dbFileSha() };
      const failure = await run().then(() => null, (e: unknown) => e);
      expect(failure).toBeInstanceOf(error as never);
      if (message) expect((failure as Error).message).toMatch(message);
      if (failure instanceof FullRestoreError) expect(failure.databaseReplaced).toBe(false);
      expect(coreHook.calls).toBe(0); // the database step was never reached
      expect(tree(rootB)).toEqual(before.files); // no staging folder, nothing moved
      expect(await storedRows()).toBe(before.rows);
      expect(dbFileSha()).toBe(before.db);
    }

    it("a wrong passphrase", async () => {
      const source = await makeSource();
      await expectUntouched(() => restore(source.archive, { passphrase: "not the right passphrase" }), SealError);
    });

    it("a truncated archive, and one with a flipped byte", async () => {
      const source = await makeSource();
      const bytes = readFileSync(source.archive);
      const cut = path.join(backups, "cut.bvb");
      writeFileSync(cut, bytes.subarray(0, bytes.length - 4000));
      await expectUntouched(() => restore(cut), SealError);
      const flipped = Buffer.from(bytes);
      flipped[Math.floor(flipped.length / 2)] ^= 0x01;
      const bad = path.join(backups, "flipped.bvb");
      writeFileSync(bad, flipped);
      await expectUntouched(() => restore(bad), SealError);
    });

    it("the manifest lists a file the archive lacks", async () => {
      await makeSource();
      const p = await validParts([["files/images/a.jpg", IMG_A]]);
      const archive = await craftArchive("missing.bvb", [["db.json", p.db], ["files/images/a.jpg", IMG_A], ["manifest.json", p.manifest([["files/images/a.jpg", IMG_A], ["files/images/gone.jpg", DOC_C]])]]);
      await expectUntouched(() => restore(archive), FullBackupVerifyError, /files\/images\/gone\.jpg is listed in the manifest but missing/);
    });

    it("the archive holds a file the manifest does not list", async () => {
      await makeSource();
      const p = await validParts([]);
      const archive = await craftArchive("extra.bvb", [["db.json", p.db], ["files/images/a.jpg", IMG_A], ["files/images/smuggled.jpg", DOC_C], ["manifest.json", p.manifest([["files/images/a.jpg", IMG_A]])]]);
      await expectUntouched(() => restore(archive), FullBackupVerifyError, /smuggled\.jpg is in the archive but not listed/);
    });

    it("a file whose bytes do not match the manifest's sha256 or size", async () => {
      await makeSource();
      const p = await validParts([]);
      const sameSize = Buffer.from(IMG_A);
      sameSize[0] ^= 0xff;
      const a = await craftArchive("sha.bvb", [["db.json", p.db], ["files/images/a.jpg", sameSize], ["manifest.json", p.manifest([["files/images/a.jpg", IMG_A]])]]);
      await expectUntouched(() => restore(a), FullBackupVerifyError, /does not match its recorded checksum/);
    });

    it.each([
      ["an entry outside files/images and files/documents", [["files/other/x.jpg", DOC_C]], /does not belong/],
      ["a stray top-level entry", [["extra.json", DOC_C]], /does not belong/],
      ["a hidden folder (.pre-restore-*)", [["files/images/.pre-restore-20260101-000000/x.jpg", DOC_C]], /hidden/],
      ["a hidden file", [["files/documents/.htaccess", DOC_C]], /hidden/],
      ["a rotation work file", [["files/images/a.jpg.rot", DOC_C]], /work file/],
      ["an interrupted-write work file", [["files/images/a.jpg.1a2b3c4d.tmp", DOC_C]], /work file/],
      ["a control character in a name", [["files/images/a\u0007b.jpg", DOC_C]], /control character/],
      ["two names differing only in case", [["files/images/A.jpg", DOC_C], ["files/images/a.jpg", IMG_A]], /same file or folder/],
      ["two names differing only in Unicode normalisation", [["files/images/café.jpg", DOC_C], ["files/images/café.jpg", IMG_A]], /same file or folder/],
      ["a name that is a file in one entry and a folder in another", [["files/images/a", DOC_C], ["files/images/a/b", IMG_A]], /same file or folder/],
      ["the same, folder first", [["files/images/a/a/b", DOC_C], ["files/images/a/a", IMG_A]], /same file or folder/],
    ] as Array<[string, Array<[string, Buffer]>, RegExp]>)("%s", async (_name, files, message) => {
      await makeSource();
      const p = await validParts(files);
      // The manifest lists exactly these entries where it can; the path rule must refuse them on its own.
      const listable = files.filter(([f]) => /^files\/(images|documents)\//.test(f));
      const archive = await craftArchive("odd.bvb", [["db.json", p.db], ...files, ["manifest.json", p.manifest(listable)]]);
      await expectUntouched(() => restore(archive), FullRestoreError, message);
    });

    it("an entry after manifest.json, a missing manifest, a missing db.json, and an oversized manifest", async () => {
      await makeSource();
      const p = await validParts([]);
      const m = p.manifest([]);
      await expectUntouched(() => craftArchive("late.bvb", [["db.json", p.db], ["manifest.json", m], ["files/images/late.jpg", DOC_C]]).then(restore), FullRestoreError, /after manifest\.json/);
      rmSync(rootB, { recursive: true, force: true });
      await expectUntouched(() => craftArchive("nomanifest.bvb", [["db.json", p.db]]).then(restore), FullRestoreError, /no manifest\.json/);
      rmSync(rootB, { recursive: true, force: true });
      await expectUntouched(() => craftArchive("nodb.bvb", [["manifest.json", m]]).then(restore), FullRestoreError, /no db\.json/);
      rmSync(rootB, { recursive: true, force: true });
      const huge = Buffer.alloc(64 * 1024 * 1024 + 1, 0x20);
      await expectUntouched(() => craftArchive("hugemanifest.bvb", [["db.json", p.db], ["manifest.json", huge]]).then(restore), FullRestoreError, /manifest\.json is too large/);
    }, 120_000);

    it("db.json that the shared restore logic refuses (a content error): the transaction never commits", async () => {
      await makeSource();
      const p = await validParts([]);
      const db = JSON.parse(p.db.toString("utf8"));
      db.firearms[1].id = db.firearms[0].id; // a duplicate primary key
      const archive = await craftArchive("dup.bvb", [["db.json", Buffer.from(JSON.stringify(db))], ["manifest.json", p.manifest([])]]);
      await makeTarget();
      const before = { files: tree(rootB), rows: await storedRows() };
      const failure = await restore(archive).then(() => null, (e: unknown) => e);
      expect(failure).toBeInstanceOf(FullRestoreError);
      expect((failure as FullRestoreError).databaseReplaced).toBe(false);
      expect(coreHook.calls).toBe(1);
      // The marker stays (R24: the database step had started; only the wrapper may decide it is safe to forget).
      expect(existsSync(path.join(rootB, `.restore-${STAMP}.db-started`, "started"))).toBe(true);
      expect(Object.fromEntries(Object.entries(tree(rootB)).filter(([p]) => !p.startsWith(`.restore-${STAMP}.db-started`)))).toEqual(before.files);
      expect(await storedRows()).toBe(before.rows);
    });

    it("an existing .pre-restore-<ts> for the same stamp, or a live folder that is a link: refused, nothing staged", async () => {
      const source = await makeSource();
      await makeTarget();
      mkdirSync(path.join(rootB, `.pre-restore-${STAMP}`));
      await expect(restore(source.archive)).rejects.toThrow(/already exists/);
      rmSync(path.join(rootB, `.pre-restore-${STAMP}`), { recursive: true });
      rmSync(path.join(rootB, "documents"), { recursive: true });
      symlinkSync(path.join(work, "install-a"), path.join(rootB, "documents"));
      await expect(restore(source.archive)).rejects.toThrow(/is not a folder/);
      expect(readdirSync(rootB).filter((n) => n.startsWith(".restore-"))).toEqual([]);
    });
  });

  /**
   * ROLLBACK MATRIX. For each failure point: what the ENGINE alone leaves
   * behind (asserted first), then the wrapper's snapshot restore (the real
   * scripts/snapshot-restore.sh), then: byte-identical to before.
   */
  describe("a failed restore leaves the install byte-identical to before", () => {
    async function scenario() {
      const source = await makeSource();
      await makeTarget();
      const snap = await takeSnapshot();
      const before = { files: tree(rootB), rows: await storedRows(), db: dbFileSha() };
      return { source, snap, before };
    }

    async function expectIdentical(before: { files: Record<string, string>; rows: string; db: string }) {
      expect(tree(rootB)).toEqual(before.files); // every file's bytes, no staging folder, no .pre-restore folder
      if (!ctx.pg) {
        expect(dbFileSha()).toBe(before.db); // the SQLite file, byte for byte
        expect(await storedRows()).toBe(before.rows);
      }
    }

    it("failure AFTER STAGING, before the database step: no marker is left, so the wrapper does NOT touch the database; the engine alone undid everything", async () => {
      const { source, snap, before } = await scenario();
      // The marker itself cannot be written (a full disk): the database step is never reached.
      const realMkdir = fsp.mkdir.bind(fsp);
      vi.spyOn(fsp, "mkdir").mockImplementation((async (p: Parameters<typeof fsp.mkdir>[0], o?: Parameters<typeof fsp.mkdir>[1]) => {
        if (String(p).endsWith(".db-started")) throw Object.assign(new Error("injected: ENOSPC after staging"), { code: "ENOSPC" });
        return realMkdir(p, o);
      }) as never);
      const failure = await restore(source.archive).then(() => null, (e: unknown) => e);
      vi.restoreAllMocks();
      expect((failure as Error).message).toBe("injected: ENOSPC after staging");
      expect(coreHook.calls).toBe(0);

      // Engine layer alone: staging removed, NO marker, uploads and records untouched — already identical.
      expect(markerExists()).toBe(false);
      expect(tree(rootB)).toEqual(before.files);
      expect(await storedRows()).toBe(before.rows);
      expect(dbFileSha()).toBe(before.db);

      const { out, dbRolledBack } = await rollBackFromSnapshot(snap);
      expect(dbRolledBack).toBe(false); // R24: nothing reached the database, so nothing is done to it
      expect(out).not.toContain("copied back from the snapshot");
      expect(out).not.toContain("Moved the previous");
      await expectIdentical(before);
    });

    it("the database step STARTED and threw before committing (or its commit was never acknowledged): the marker is left, so the wrapper puts the database back", async () => {
      const { source, snap, before } = await scenario();
      coreHook.failBefore = new Error("injected: the database step failed");
      const failure = await restore(source.archive).then(() => null, (e: unknown) => e);
      expect((failure as Error).message).toBe("injected: the database step failed");

      // Engine layer alone: staging removed, uploads untouched; the marker says the database may have changed.
      expect(markerExists()).toBe(true);
      expect(withoutMarker(tree(rootB))).toEqual(before.files);

      const { dbRolledBack } = await rollBackFromSnapshot(snap);
      expect(dbRolledBack).toBe(true);
      expect(markerExists()).toBe(false);
      await expectIdentical(before);
    });

    it("failure AFTER THE DATABASE COMMIT (before any rename): the engine removes its staging folder; the records are the backup's until the snapshot restore puts the database back", async () => {
      const { source, snap, before } = await scenario();
      const realMkdir = fsp.mkdir.bind(fsp);
      vi.spyOn(fsp, "mkdir").mockImplementation((async (p: Parameters<typeof fsp.mkdir>[0], o?: Parameters<typeof fsp.mkdir>[1]) => {
        if (String(p).includes(".pre-restore-")) throw Object.assign(new Error("injected: ENOSPC after the commit"), { code: "ENOSPC" });
        return realMkdir(p, o);
      }) as never);
      const failure = await restore(source.archive).then(() => null, (e: unknown) => e);
      vi.restoreAllMocks();
      expect(failure).toBeInstanceOf(FullRestoreError);
      expect((failure as FullRestoreError).databaseReplaced).toBe(true);
      expect((failure as Error).message).toMatch(/database records were already replaced/);

      // Engine layer alone: the uploads are as before (staging gone) plus the marker; the database is NOT.
      expect(markerExists()).toBe(true);
      expect(withoutMarker(tree(rootB))).toEqual(before.files);
      expect(await storedRows()).not.toBe(before.rows);
      expect(await within(10_000, raw.firearm.count())).toBe(2);

      expect((await rollBackFromSnapshot(snap)).dbRolledBack).toBe(true);
      expect(markerExists()).toBe(false);
      await expectIdentical(before);
    });

    it("failure MID-RENAME (images swapped, documents not yet): the engine reverses its renames; the snapshot restore puts the database back", async () => {
      const { source, snap, before } = await scenario();
      const realRename = fsp.rename.bind(fsp);
      let swaps = 0;
      vi.spyOn(fsp, "rename").mockImplementation((async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
        // Renames 1 and 2 swap images; the 3rd (documents → .pre-restore) fails once. The undo renames are let through.
        if (String(to).includes(".pre-restore-") && ++swaps === 2) throw Object.assign(new Error("injected: EIO mid-rename"), { code: "EIO" });
        return realRename(from, to);
      }) as never);
      const failure = await restore(source.archive).then(() => null, (e: unknown) => e);
      vi.restoreAllMocks();
      expect(failure).toBeInstanceOf(FullRestoreError);
      expect((failure as FullRestoreError).databaseReplaced).toBe(true);
      expect((failure as Error).message).toMatch(/photos and documents were put back as they were/);

      // Engine layer alone: uploads exactly as before (plus the marker), no staging or .pre-restore- folder; database replaced.
      expect(markerExists()).toBe(true);
      expect(withoutMarker(tree(rootB))).toEqual(before.files);
      expect(await storedRows()).not.toBe(before.rows);

      const { out } = await rollBackFromSnapshot(snap);
      expect(out).not.toContain("copied back from the snapshot");
      await expectIdentical(before);
    });

    it("the engine is KILLED mid-rename (no undo runs): the snapshot restore removes the staging folder, moves the previous folders back and restores the database", async () => {
      const { source, snap, before } = await scenario();
      const realRename = fsp.rename.bind(fsp);
      let swaps = 0;
      let dead = false;
      vi.spyOn(fsp, "rename").mockImplementation((async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
        if (dead || (String(to).includes(".pre-restore-") && ++swaps === 2)) {
          dead = true; // from here on nothing works: the undo fails too, as if the process had died
          throw Object.assign(new Error("injected: killed"), { code: "EIO" });
        }
        return realRename(from, to);
      }) as never);
      const realRm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, "rm").mockImplementation((async (p: Parameters<typeof fsp.rm>[0], o?: Parameters<typeof fsp.rm>[1]) => {
        if (dead) throw Object.assign(new Error("injected: killed"), { code: "EIO" });
        return realRm(p, o);
      }) as never);
      const failure = await restore(source.archive).then(() => null, (e: unknown) => e);
      vi.restoreAllMocks();
      expect((failure as Error).message).toMatch(/could NOT be put back completely/);

      // What a killed engine leaves: restored images in place, the previous ones in .pre-restore, staging still there.
      const left = tree(rootB);
      expect(left[`.pre-restore-${STAMP}/images/firearms/only-on-target.jpg`]).toBe(before.files["images/firearms/only-on-target.jpg"]);
      expect(left["images/firearms/big.jpg"]).toBeDefined();
      expect(left[`.restore-${STAMP}/documents/c.pdf`]).toBeDefined();
      expect(left).not.toEqual(before.files);

      const { out } = await rollBackFromSnapshot(snap);
      expect(out).toContain("Moved the previous images folder back into place.");
      await expectIdentical(before);
    });

    it("killed mid-rename AND the moved-aside folder is damaged: the missing and changed files are copied back from the snapshot itself", async () => {
      const { source, snap, before } = await scenario();
      const realRename = fsp.rename.bind(fsp);
      let swaps = 0;
      let dead = false;
      vi.spyOn(fsp, "rename").mockImplementation((async (from: Parameters<typeof fsp.rename>[0], to: Parameters<typeof fsp.rename>[1]) => {
        if (dead || (String(to).includes(".pre-restore-") && ++swaps === 2)) {
          dead = true;
          throw Object.assign(new Error("injected: killed"), { code: "EIO" });
        }
        return realRename(from, to);
      }) as never);
      await restore(source.archive).catch(() => undefined);
      vi.restoreAllMocks();
      const pre = path.join(rootB, `.pre-restore-${STAMP}`);
      rmSync(path.join(pre, "images/firearms/only-on-target.jpg"));
      writeFileSync(path.join(pre, "images/firearms/a.jpg"), "damaged while it sat in .pre-restore");
      rmSync(path.join(rootB, "documents/only-on-target.pdf"));

      const { out } = await rollBackFromSnapshot(snap);
      expect(out).toContain("copied back from the snapshot: images/firearms/only-on-target.jpg");
      expect(out).toContain("copied back from the snapshot: images/firearms/a.jpg");
      expect(out).toContain("copied back from the snapshot: documents/only-on-target.pdf");
      await expectIdentical(before);
    });

    it("the restore FINISHED: no marker is left and .pre-restore-<ts> exists — the state the wrapper reads as 'complete' when the program's exit status is lost", async () => {
      const { source } = await scenario();
      await restore(source.archive);
      expect(markerExists()).toBe(false);
      expect(existsSync(path.join(rootB, `.pre-restore-${STAMP}`, "images"))).toBe(true);
      expect(existsSync(path.join(rootB, `.pre-restore-${STAMP}`, "documents"))).toBe(true);
      expect(existsSync(path.join(rootB, `.restore-${STAMP}`))).toBe(false);
    });

    it("a leftover marker for the same stamp refuses a new run before anything is staged; an OLDER run's marker is never removed by a later run", async () => {
      const { source, before } = await scenario();
      mkdirSync(path.join(rootB, MARKER));
      await expect(restore(source.archive)).rejects.toThrow(/\.db-started already exists/);
      rmSync(path.join(rootB, MARKER), { recursive: true });
      expect(tree(rootB)).toEqual(before.files);
      mkdirSync(path.join(rootB, ".restore-20250101-000000.db-started"));
      mkdirSync(path.join(rootB, ".restore-20250101-000000/images"), { recursive: true }); // old staging: removed
      await restore(source.archive);
      expect(existsSync(path.join(rootB, ".restore-20250101-000000.db-started"))).toBe(true);
      expect(existsSync(path.join(rootB, ".restore-20250101-000000"))).toBe(false);
    });
  });

  describe("the full-backup lock (a backup and a restore never run at the same time)", () => {
    it("a restore refuses, before any change, while a backup holds the lock; and a backup refuses while a restore is running", async () => {
      const source = await makeSource();
      await makeTarget();
      const before = { files: tree(rootB), rows: await storedRows() };

      // 1. A backup is running (it holds the lock in the backup folder).
      const held = await acquireFullBackupLock(backups);
      try {
        const failure = await restore(source.archive).then(() => null, (e: unknown) => e);
        expect(failure).toBeInstanceOf(FullBackupAlreadyRunningError);
        expect(coreHook.calls).toBe(0);
        expect(tree(rootB)).toEqual(before.files); // nothing staged, no marker
        expect(await storedRows()).toBe(before.rows);
      } finally {
        await held.release();
      }

      // 2. A restore is running: a backup started while it is inside its database step is refused.
      let backupDuringRestore: unknown = "not attempted";
      const realMkdir = fsp.mkdir.bind(fsp);
      vi.spyOn(fsp, "mkdir").mockImplementation((async (p: Parameters<typeof fsp.mkdir>[0], o?: Parameters<typeof fsp.mkdir>[1]) => {
        if (String(p).endsWith(".db-started")) {
          backupDuringRestore = await runFullBackup({ passphrase: PASS, dir: backups, now: new Date("2027-03-03T00:00:00Z"), env: { ...process.env, IMAGE_UPLOAD_DIR: rootB } as NodeJS.ProcessEnv }).then(() => "a backup was made", (e: unknown) => e);
        }
        return realMkdir(p, o);
      }) as never);
      await restore(source.archive);
      vi.restoreAllMocks();
      expect(backupDuringRestore).toBeInstanceOf(FullBackupAlreadyRunningError);
      // The lock is released afterwards: no lock file left, and a backup works again.
      expect(readdirSync(backups).filter((n) => n.includes("lock"))).toEqual([]);
      await expect(within(60_000, runFullBackup({ passphrase: PASS, dir: backups, now: new Date("2027-03-04T00:00:00Z"), env: { ...process.env, IMAGE_UPLOAD_DIR: rootB } as NodeJS.ProcessEnv }))).resolves.toMatchObject({ files: 3 });
    });

    it("the lock is released after a FAILED restore too", async () => {
      const source = await makeSource();
      await makeTarget();
      await restore(source.archive, { passphrase: "not the right passphrase" }).catch(() => undefined);
      expect(readdirSync(backups).filter((n) => n.includes("lock"))).toEqual([]);
    });
  });

  describe("scripts/snapshot-restore.sh (more)", () => {
    // Ruling R28: the rule lives in the script, so no caller — a wrapper, a person following the recovery file — can undo a finished restore.
    it("R28: uploads mode on a FINISHED restore (no marker, .pre-restore-<ts> in place) changes nothing, says so, exits 0 — with or without a snapshot", async () => {
      const source = await makeSource();
      await makeTarget();
      const snap = await takeSnapshot();
      await restore(source.archive);
      const finished = tree(rootB);
      expect(markerExists()).toBe(false);
      for (const args of [[rootB, STAMP, snap.uploads], [rootB, STAMP]]) {
        const r = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "uploads", ...args]);
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toMatch(/^The restore \d{8}-\d{6} had FINISHED .* Nothing was changed\.\n$/);
        expect(tree(rootB)).toEqual(finished);
      }
      expect(sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "state", rootB, STAMP]).stdout).toBe("complete\n");
    });

    it("R28: `state` prints started / untouched; `sqlite` given the uploads folder and stamp leaves the database alone unless the marker exists", () => {
      const state = () => sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "state", rootB, STAMP]).stdout;
      expect(state()).toBe("untouched\n");
      const live = path.join(work, "vault.db");
      const snapDb = path.join(work, "blackvault-x.db");
      writeFileSync(live, "LIVE");
      writeFileSync(snapDb, "SNAPSHOT");
      const guarded = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "sqlite", snapDb, live, rootB, STAMP]);
      expect(guarded.status, guarded.stderr).toBe(0);
      expect(guarded.stdout).toMatch(/the database was not touched/);
      expect(readFileSync(live, "utf8")).toBe("LIVE");
      mkdirSync(path.join(rootB, MARKER));
      expect(state()).toBe("started\n");
      // The marker wins over .pre-restore-<ts>: killed after the renames, before the marker was removed.
      mkdirSync(path.join(rootB, `.pre-restore-${STAMP}/images`), { recursive: true });
      expect(state()).toBe("started\n");
      expect(sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "sqlite", snapDb, live, rootB, STAMP]).status).toBe(0);
      expect(readFileSync(live, "utf8")).toBe("SNAPSHOT");
    });

    it("clear-marker removes exactly this stamp's marker", () => {
      mkdirSync(path.join(rootB, MARKER));
      writeFileSync(path.join(rootB, MARKER, "started"), "");
      mkdirSync(path.join(rootB, ".restore-20250101-000000.db-started"));
      const r = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "clear-marker", rootB, STAMP]);
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(rootB)).toEqual([".restore-20250101-000000.db-started"]);
      expect(sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "clear-marker", rootB, "../x"]).status).toBe(1);
    });
  });

  describe("scripts/snapshot-restore.sh", () => {
    it("never touches the snapshot, and refuses a missing or empty database snapshot without touching the live database", async () => {
      await makeSource();
      await makeTarget();
      const snap = await takeSnapshot();
      const snapTree = tree(snapshots);
      await rollBackFromSnapshot(snap);
      expect(tree(snapshots)).toEqual(snapTree);

      const live = path.join(work, "live.db");
      writeFileSync(live, "live database bytes");
      const missing = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "sqlite", path.join(work, "nope.db"), live]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/^ERROR: could not restore from the snapshot: the database snapshot .* does not exist\.\n$/);
      writeFileSync(path.join(work, "empty.db"), "");
      const empty = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "sqlite", path.join(work, "empty.db"), live]);
      expect(empty.status).toBe(1);
      expect(readFileSync(live, "utf8")).toBe("live database bytes");
      expect(readdirSync(work).filter((n) => n.includes("rollback"))).toEqual([]);
    });

    it("sqlite: the live file becomes the snapshot byte for byte, keeps its mode, loses the failed restore's journal/WAL and gets the snapshot's own", () => {
      const live = path.join(work, "vault.db");
      const snap = path.join(work, "blackvault-x.db");
      writeFileSync(live, "REPLACED BY THE FAILED RESTORE", { mode: 0o640 });
      writeFileSync(`${live}-journal`, "hot journal of the failed restore");
      writeFileSync(`${live}-wal`, "wal of the failed restore");
      writeFileSync(`${live}-shm`, "shm");
      writeFileSync(snap, "the database as it was");
      writeFileSync(`${snap}-wal`, "the wal saved with the snapshot");
      const r = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "sqlite", snap, live]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(live, "utf8")).toBe("the database as it was");
      expect(lstatSync(live).mode & 0o777).toBe(0o640);
      expect(existsSync(`${live}-journal`)).toBe(false);
      expect(existsSync(`${live}-shm`)).toBe(false);
      expect(readFileSync(`${live}-wal`, "utf8")).toBe("the wal saved with the snapshot");
      expect(readdirSync(work).filter((n) => n.includes("rollback"))).toEqual([]);
    });

    it("uploads without a snapshot (the folder had no files): the staging folder goes and the moved-aside folders come back; a file the snapshot lacks is reported, never deleted", async () => {
      mkdirSync(path.join(rootB, `.restore-${STAMP}/images`), { recursive: true });
      mkdirSync(path.join(rootB, `.pre-restore-${STAMP}/images`), { recursive: true });
      mkdirSync(path.join(rootB, "images"), { recursive: true });
      mkdirSync(path.join(rootB, MARKER)); // the restore had reached its database step (R28: only then are folders moved back)
      writeFileSync(path.join(rootB, "images/from-the-archive.jpg"), "restored content");
      const r = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "uploads", rootB, STAMP]);
      expect(r.status, r.stderr).toBe(0);
      expect(tree(rootB)).toEqual({ images: "dir", [MARKER]: "dir" });
      rmSync(path.join(rootB, MARKER), { recursive: true });

      // With a snapshot: an extra file stays and is counted.
      mkdirSync(path.join(snapshots, "u/images"), { recursive: true });
      writeFileSync(path.join(snapshots, "u/images/kept.jpg"), "in the snapshot");
      writeFileSync(path.join(rootB, "images/not-in-snapshot.jpg"), "extra");
      const s = sh([path.join(ROOT, "scripts/snapshot-restore.sh"), "uploads", rootB, STAMP, path.join(snapshots, "u")]);
      expect(s.status, s.stderr).toBe(0);
      expect(s.stdout).toContain("WARNING: 1 file(s) in");
      expect(readFileSync(path.join(rootB, "images/not-in-snapshot.jpg"), "utf8")).toBe("extra");
      expect(readFileSync(path.join(rootB, "images/kept.jpg"), "utf8")).toBe("in the snapshot");
      if (isPosix) expect(lstatSync(path.join(rootB, "images/kept.jpg")).mode & 0o777).toBe(0o600);
    });
  });

  describe("scripts/uploads-snapshot.sh", () => {
    it("never copies a .restore-* or .pre-restore-* folder into a snapshot", async () => {
      await upload(rootB, "images/keep.jpg", IMG_A);
      await upload(rootB, `.pre-restore-${STAMP}/images/old.jpg`, EXTRA);
      await upload(rootB, `.restore-${STAMP}/images/staged.jpg`, EXTRA);
      await upload(rootB, ".pre-encryption-20260101-000000/x.jpg", EXTRA);
      mkdirSync(snapshots, { recursive: true });
      const r = sh([path.join(ROOT, "scripts/uploads-snapshot.sh"), rootB, snapshots, "uploads-x"]);
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(Object.keys(tree(path.join(snapshots, "uploads-x")))).toEqual(["images", "images/keep.jpg"]);

      // Only such folders: nothing to snapshot (exit 3), nothing written.
      rmSync(path.join(rootB, "images"), { recursive: true });
      const none = sh([path.join(ROOT, "scripts/uploads-snapshot.sh"), rootB, snapshots, "uploads-y"]);
      expect(none.status).toBe(3);
      expect(existsSync(path.join(snapshots, "uploads-y"))).toBe(false);
    });
  });
});
