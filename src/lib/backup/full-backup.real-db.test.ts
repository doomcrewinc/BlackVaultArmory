import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";

/**
 * Task 4 (spec 3c §2): the full-backup engine against a REAL database and
 * REAL folders.
 * - default: a throw-away SQLite file with `connection_limit=1` (as
 *   docker-compose ships it), migrated with `prisma migrate deploy`;
 * - with ENCRYPTION_REAL_DB_PG_URL set, the same suite on PostgreSQL.
 * The backup folder and the uploads root are temp dirs — the repo's
 * `uploads/`, `data/` and `prisma/prisma/dev.db` are never touched.
 * Every engine call is raced against a timer, so a deadlock fails the test.
 *
 * The key is the fixed test key from vitest.config.ts (`test.env`).
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.ENCRYPTION_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-full-backup-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

// Outside a request: the real next/headers throws, and the actor is `system`.
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => null),
  requireAuth: vi.fn(async () => null),
  requireAdmin: vi.fn(async () => null),
}));

// The engine's own verify step, wrapped so one test can make it fail.
const verifyHook = vi.hoisted(() => ({
  fail: null as Error | null,
  calls: 0,
  /** When set, awaited at the start of each verify with that verify's 1-based call number. */
  gate: null as ((call: number, file: string) => Promise<void>) | null,
}));
// The lock, wrapped so one test can let two runs in at once — which the real,
// advisory lock can do in rare orderings (full-lock.ts, "WHAT THIS DOES NOT GUARANTEE").
const lockHook = vi.hoisted(() => ({ bypass: false }));
vi.mock("./full-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./full-lock")>();
  return {
    ...actual,
    acquireFullBackupLock: async (...args: Parameters<typeof actual.acquireFullBackupLock>) =>
      lockHook.bypass ? { path: "(bypassed)", release: async () => undefined } : actual.acquireFullBackupLock(...args),
  };
});
vi.mock("./full-verify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./full-verify")>();
  return {
    ...actual,
    verifyFullBackup: async (...args: Parameters<typeof actual.verifyFullBackup>) => {
      verifyHook.calls += 1;
      if (verifyHook.gate) await verifyHook.gate(verifyHook.calls, args[0]);
      if (verifyHook.fail) throw verifyHook.fail;
      return actual.verifyFullBackup(...args);
    },
  };
});

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient, prisma } from "@/lib/prisma";
import { createBackupOpener, SealError } from "@/lib/encryption/core.mjs";
import { getFieldKeys } from "@/lib/encryption/keys";
import { writeEncryptedFile } from "@/lib/files/storage";
import { BACKUP_MODELS } from "./models";
import { parseManifest, type Manifest } from "./manifest";
import { readTar } from "./tar";
import { FULL_BACKUP_LOCK_NAME, FullBackupAlreadyRunningError } from "./full-lock";
import { FullBackupError, runFullBackup, type FullBackupProgress } from "./full-backup";

const actualVerify = async (file: string, passphrase: string) =>
  (await vi.importActual<typeof import("./full-verify")>("./full-verify")).verifyFullBackup(file, passphrase);

const PASS = "correct horse battery staple";
const NEEDLE = "PLAINTEXT-NEEDLE-7731";
const NOW = new Date("2026-10-02T18:04:05.000Z");
const NAME = "blackvault-full-20261002-180405.bvb";
/** R15: `blackvault-full-<ts>.<16 hex>.bvb.partial` — a per-run token, so two runs never share a partial. */
const PARTIAL_NAME = /^blackvault-full-20261002-1804\d\d\.[0-9a-f]{16}\.bvb\.partial$/;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const isPosix = process.platform !== "win32";

let raw: PrismaClient;
let work: string;
let root: string; // uploads root
let backups: string; // backup folder
let env: NodeJS.ProcessEnv;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const run = (over: Partial<Parameters<typeof runFullBackup>[0]> = {}) =>
  within(60_000, runFullBackup({ passphrase: PASS, dir: backups, env, now: NOW, ...over }));

/** Writes an uploaded file the way the upload routes do: BVF1 under the current key. */
async function upload(rel: string, plaintext: Buffer): Promise<string> {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  await writeEncryptedFile(abs, plaintext);
  return abs;
}

interface Opened {
  order: string[];
  entries: Map<string, Buffer>;
  manifest: Manifest;
  db: Record<string, unknown[]> & { meta: Record<string, unknown> };
}

/** Decrypts and unpacks an archive independently of full-verify.ts. */
async function open(file: string, passphrase = PASS): Promise<Opened> {
  const opener = createBackupOpener(passphrase);
  pipeline(createReadStream(file), opener, () => undefined);
  const order: string[] = [];
  const entries = new Map<string, Buffer>();
  await readTar(opener, async (p, _size, body) => {
    const chunks: Buffer[] = [];
    for await (const c of body as AsyncIterable<Buffer>) chunks.push(c);
    order.push(p);
    entries.set(p, Buffer.concat(chunks));
  });
  return {
    order,
    entries,
    manifest: parseManifest(entries.get("manifest.json")!),
    db: JSON.parse(entries.get("db.json")!.toString("utf8")),
  };
}

const backupFolder = () => readdirSync(backups).sort();
const events = () => raw.auditEvent.findMany({ where: { action: "BACKUP_CREATED" }, orderBy: { at: "asc" } });

function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""], { timeout: 30_000 });
  return child.pid;
}

const IMG_A = Buffer.from(`image A ${NEEDLE} `.repeat(50));
const IMG_B = Buffer.alloc(2 * 1024 * 1024 + 321, 0x42); // more than one 1 MiB chunk
const DOC_C = Buffer.from(`%PDF-1.4 document C ${NEEDLE}`);

async function seedUploads(): Promise<void> {
  await upload("images/firearms/a.jpg", IMG_A);
  await upload("images/firearms/b.jpg", IMG_B);
  await upload(`documents/${NEEDLE}-c.pdf`, DOC_C);
}

describe(`runFullBackup against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` },
        stdio: "pipe",
        timeout: 90_000,
      },
    );
    raw = createRawPrismaClient();
    await within(20_000, raw.firearm.deleteMany());
    await within(
      20_000,
      prisma.firearm.create({
        data: {
          name: "Backup test pistol",
          manufacturer: "Glock",
          model: "19",
          caliber: "9mm",
          serialNumber: `SER-${NEEDLE}`,
          type: "PISTOL",
          acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
        },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await within(20_000, raw.firearm.deleteMany()).catch(() => undefined);
    await prisma.$disconnect();
    await raw?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await within(10_000, raw.auditEvent.deleteMany());
    work = path.join(ctx.dir, `w-${Math.random().toString(16).slice(2)}`);
    root = path.join(work, "uploads");
    backups = path.join(work, "backups");
    mkdirSync(root, { recursive: true });
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    env = { ...process.env, IMAGE_UPLOAD_DIR: root } as NodeJS.ProcessEnv;
    verifyHook.fail = null;
    verifyHook.calls = 0;
    verifyHook.gate = null;
    lockHook.bypass = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(backups) && isPosix) chmodSync(backups, 0o700);
  });

  it("writes one archive that verifies: db.json first, manifest.json last, counts and sha256s match what is on disk and in the database", async () => {
    await seedUploads();
    const result = await run();

    expect(result.file).toBe(NAME);
    expect(result.path).toBe(path.join(backups, NAME));
    expect(result.files).toBe(3);
    expect(result.bytes).toBe(IMG_A.length + IMG_B.length + DOC_C.length);
    expect(result.skipped).toEqual([]);
    expect(backupFolder()).toEqual([NAME]); // no .partial, no lock left behind
    expect(result.archiveBytes).toBe(statSync(result.path).size);
    if (isPosix) expect(statSync(result.path).mode & 0o777).toBe(0o600);

    // The real verify accepts it.
    await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 3, bytes: result.bytes });
    expect(verifyHook.calls).toBe(1); // the engine verified it before renaming

    const opened = await open(result.path);
    expect(opened.order[0]).toBe("db.json");
    expect(opened.order.at(-1)).toBe("manifest.json");
    expect(opened.order.slice(1, -1)).toEqual([
      "files/images/firearms/a.jpg",
      "files/images/firearms/b.jpg",
      `files/documents/${NEEDLE}-c.pdf`,
    ]);

    // Files: decrypted contents, and the manifest's size + sha256 for each.
    const expected: Record<string, Buffer> = {
      "files/images/firearms/a.jpg": IMG_A,
      "files/images/firearms/b.jpg": IMG_B,
      [`files/documents/${NEEDLE}-c.pdf`]: DOC_C,
    };
    expect(opened.manifest.files.map((f) => f.path).sort()).toEqual(Object.keys(expected).sort());
    for (const f of opened.manifest.files) {
      expect(opened.entries.get(f.path)!.equals(expected[f.path])).toBe(true);
      expect(f.size).toBe(expected[f.path].length);
      expect(f.sha256).toBe(sha(expected[f.path]));
    }

    // Records: every backup model, decrypted, with counts equal to the database's.
    for (const { key, delegate } of BACKUP_MODELS) {
      const rows = await within(10_000, (raw as unknown as Record<string, { count(): Promise<number> }>)[delegate].count());
      expect(opened.manifest.counts[key], key).toBe(rows);
      expect(opened.db[key], key).toHaveLength(rows);
    }
    expect(opened.manifest.counts.firearms).toBe(1);
    expect((opened.db.firearms[0] as { serialNumber: string }).serialNumber).toBe(`SER-${NEEDLE}`);
    expect(opened.db.meta).toMatchObject({ version: "1.1", createdAt: NOW.toISOString(), counts: opened.manifest.counts });
    expect(opened.manifest.createdAt).toBe(NOW.toISOString());
    expect(opened.manifest.keyIdAtBackup).toBe(getFieldKeys().id);
    expect(opened.manifest.skipped).toEqual([]);
  });

  it("the archive bytes contain no plaintext needle (records, file contents and file names are all sealed)", async () => {
    await seedUploads();
    // The needle really is stored encrypted at rest too, so this is not vacuous the other way round.
    const stored = await within(10_000, raw.firearm.findFirstOrThrow());
    expect(stored.serialNumber).not.toContain(NEEDLE);

    const result = await run();
    const bytes = readFileSync(result.path);
    expect(bytes.includes(Buffer.from(NEEDLE))).toBe(false);
    expect(bytes.includes(Buffer.from("db.json"))).toBe(false);
    expect(bytes.includes(Buffer.from("manifest.json"))).toBe(false);
    // ...while the opened archive does hold it, three ways.
    const opened = await open(result.path);
    expect(opened.entries.get("db.json")!.includes(Buffer.from(NEEDLE))).toBe(true);
    expect(opened.entries.get("files/images/firearms/a.jpg")!.includes(Buffer.from(NEEDLE))).toBe(true);
    expect(opened.order.some((p) => p.includes(NEEDLE))).toBe(true);
  });

  it("leaves out .pre-encryption-* folders, *.tmp, *.rot, hidden entries, symlinks, and anything outside images/ and documents/", async () => {
    await upload("images/keep.jpg", IMG_A);
    await upload("images/.pre-encryption-20261001-123456/old.jpg", IMG_A);
    await upload(".pre-encryption-20261001-123456/images/old.jpg", IMG_A);
    await upload("images/half.jpg.1a2b3c4d.tmp", IMG_A);
    await upload("images/rotating.jpg.rot", IMG_A);
    await upload("images/.hidden.jpg", IMG_A);
    await upload("images/.hiddendir/x.jpg", IMG_A);
    await upload("other/elsewhere.jpg", IMG_A);
    await upload("toplevel.jpg", IMG_A);
    const outside = path.join(work, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "secret.txt"), "outside the uploads root");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "images", "link.jpg"));
    symlinkSync(outside, path.join(root, "images", "linkdir"));

    const result = await run();
    const opened = await open(result.path);
    expect(opened.manifest.files.map((f) => f.path)).toEqual(["files/images/keep.jpg"]);
    expect(opened.order).toEqual(["db.json", "files/images/keep.jpg", "manifest.json"]);
    expect(opened.manifest.skipped).toEqual([]);
  });

  it("an empty (or missing) uploads folder still makes a valid archive with no files", async () => {
    rmSync(root, { recursive: true, force: true });
    const result = await run();
    expect(result).toMatchObject({ files: 0, bytes: 0 });
    const opened = await open(result.path);
    expect(opened.order).toEqual(["db.json", "manifest.json"]);
    await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 0 });
  });

  it("Review Focus 3: a file deleted mid-run lands in manifest.skipped, a new upload is simply absent, and the backup still verifies", async () => {
    await seedUploads();
    const victim = path.join(root, "images/firearms/b.jpg");
    const progress: FullBackupProgress[] = [];
    let acted = false;

    const result = await run({
      onProgress: (p) => {
        progress.push({ ...p });
        if (!acted && p.phase === "writing") {
          acted = true;
          // The run has listed the files and started writing; b.jpg is not yet read.
          rmSync(victim);
          mkdirSync(path.join(root, "images/new"), { recursive: true });
          writeFileSync(path.join(root, "images/new/late.jpg"), "uploaded after the listing");
        }
      },
    });

    expect(acted).toBe(true);
    expect(result.files).toBe(2);
    expect(result.skipped).toEqual([{ path: "files/images/firearms/b.jpg", kind: "vanished", reason: expect.stringMatching(/^vanished/) }]);

    const opened = await open(result.path);
    expect(opened.manifest.skipped).toEqual([{ path: "files/images/firearms/b.jpg", reason: result.skipped[0].reason }]);
    expect(JSON.parse((await events())[0].changes ?? "null")).toMatchObject({ files: 2, skipped: 1, verified: true });
    expect(opened.manifest.files.map((f) => f.path)).toEqual(["files/images/firearms/a.jpg", `files/documents/${NEEDLE}-c.pdf`]);
    expect(opened.order).not.toContain("files/images/firearms/b.jpg");
    expect(opened.order.some((p) => p.includes("late.jpg"))).toBe(false);
    await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 2 });

    // Progress carries files and bytes, done and total, and finishes complete.
    const writing = progress.filter((p) => p.phase === "writing");
    expect(writing[0]).toMatchObject({ filesDone: 0, filesTotal: 3, bytesDone: 0 });
    expect(writing[0].bytesTotal).toBeGreaterThan(IMG_B.length);
    expect(writing.at(-1)).toMatchObject({ filesDone: 3, filesTotal: 3, bytesDone: writing[0].bytesTotal });
    const verifying = progress.filter((p) => p.phase === "verifying");
    expect(verifying.at(-1)).toEqual({
      phase: "verifying",
      filesDone: 2,
      filesTotal: 2,
      bytesDone: IMG_A.length + DOC_C.length,
      bytesTotal: IMG_A.length + DOC_C.length,
    });
  });

  it("a second concurrent run gets FullBackupAlreadyRunningError and does not disturb the first", async () => {
    await seedUploads();
    let second: unknown = "not started";
    const first = await run({
      onProgress: async (p) => {
        if (second === "not started" && p.phase === "writing") {
          second = "pending";
          second = await runFullBackup({ passphrase: PASS, dir: backups, env, now: NOW }).catch((e) => e);
        }
      },
    });
    // onProgress is not awaited by the engine: wait for the second attempt to settle.
    await within(20_000, (async () => {
      while (second === "pending" || second === "not started") await new Promise((r) => setTimeout(r, 10));
    })());
    expect(second).toBeInstanceOf(FullBackupAlreadyRunningError);
    expect((second as FullBackupAlreadyRunningError).code).toBe("ALREADY_RUNNING");
    expect(backupFolder()).toEqual([first.file]);
    await expect(actualVerify(first.path, PASS)).resolves.toMatchObject({ files: 3 });
    expect(await events()).toHaveLength(1);
  });

  it("a lock held by another live process blocks the run and creates nothing", async () => {
    const lock = path.join(backups, FULL_BACKUP_LOCK_NAME);
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString(), hostname: os.hostname(), token: "other" }));
    await expect(run()).rejects.toBeInstanceOf(FullBackupAlreadyRunningError);
    expect(backupFolder()).toEqual([FULL_BACKUP_LOCK_NAME]);
    expect(await events()).toHaveLength(0);
  });

  it("a stale lock with a dead pid is reclaimed, and a leftover .partial from the crashed run is removed", async () => {
    await seedUploads();
    writeFileSync(path.join(backups, FULL_BACKUP_LOCK_NAME), JSON.stringify({ pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", hostname: os.hostname(), token: "x" }));
    writeFileSync(path.join(backups, "blackvault-full-20260101-000000.bvb.partial"), "half a backup");
    writeFileSync(path.join(backups, "blackvault-full-20260101-000000.0123456789abcdef.bvb.partial"), "half a backup, tokened name");
    const result = await run();
    expect(backupFolder()).toEqual([result.file]);
    await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 3 });
  });

  it("an injected write failure (disk full) removes .partial, releases the lock, writes no audit entry and reports the cause", async () => {
    await seedUploads();
    const realOpen = fsp.open.bind(fsp);
    let partialSeen = "";
    let writes = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith(".bvb.partial")) {
        partialSeen = String(args[0]);
        const realWrite = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
        (handle as unknown as { write: unknown }).write = async (...a: unknown[]) => {
          writes += 1;
          if (writes > 2) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
          return realWrite(...a);
        };
      }
      return handle;
    }) as typeof fsp.open);

    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOSPC");
    expect(path.dirname(partialSeen)).toBe(backups);
    expect(path.basename(partialSeen)).toMatch(PARTIAL_NAME);
    expect(writes).toBeGreaterThan(2);
    expect(backupFolder()).toEqual([]); // no .partial, no .bvb, no lock
    expect(await events()).toHaveLength(0);

    // The lock really is free: the next run succeeds.
    vi.restoreAllMocks();
    const ok = await run();
    expect(backupFolder()).toEqual([ok.file]);
  });

  it("a failed verify of the sealed .partial removes it, releases the lock and fails the run — nothing unverified is ever named .bvb", async () => {
    await seedUploads();
    verifyHook.fail = new Error("injected verify failure");
    await expect(run()).rejects.toThrow(/injected verify failure/);
    expect(verifyHook.calls).toBe(1);
    expect(backupFolder()).toEqual([]);
    expect(await events()).toHaveLength(0);
  });

  it("fix round 1: a folder-fsync failure AFTER the rename does not fail the run — the verified backup is in place, the audit entry is written, and the result carries a warning", async () => {
    await seedUploads();
    const realOpen = fsp.open.bind(fsp);
    let dirOpens = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      // Only the folder fsync opens the backup folder itself, read-only.
      if (String(args[0]) === backups && args[1] === "r") {
        dirOpens += 1;
        throw Object.assign(new Error("EIO: i/o error, open"), { code: "EIO", syscall: "open" });
      }
      return realOpen(...args);
    }) as typeof fsp.open);

    const result = await run();
    expect(dirOpens).toBe(1);
    expect(result.file).toBe(NAME);
    expect(result.files).toBe(3);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/EIO/);
    expect(result.warnings[0]).toContain(backups);
    expect(backupFolder()).toEqual([NAME]);
    vi.restoreAllMocks();
    await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 3 });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].changes ?? "null")).toMatchObject({ full: true, file: NAME, verified: true });
  });

  it("a normal run has no warnings", async () => {
    expect((await run()).warnings).toEqual([]);
  });

  it("writes a BACKUP_CREATED audit entry: { full, file, files, bytes, verified }, attributed to system outside a request", async () => {
    await seedUploads();
    const result = await run();
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBeNull();
    expect(rows[0].actorName).toBe("system");
    expect(rows[0].entityLabel).toBe(result.file);
    expect(JSON.parse(rows[0].changes ?? "null")).toEqual({
      full: true,
      file: NAME,
      files: 3,
      bytes: IMG_A.length + IMG_B.length + DOC_C.length,
      verified: true,
      skipped: 0,
    });
    expect(rows[0].changes).not.toContain(PASS);
  });

  it("an explicit actor (the Settings button's admin) is recorded instead of system", async () => {
    await run({ actor: { actorId: null, actorName: "anonymous" } });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorName).toBe("anonymous");
  });

  it("a passphrase under 12 characters is refused before anything is created", async () => {
    const err = await run({ passphrase: "short" }).catch((e) => e);
    expect(err).toBeInstanceOf(SealError);
    expect(err.code).toBe("PASSPHRASE_TOO_SHORT");
    expect(backupFolder()).toEqual([]);
  });

  it("a missing backup folder fails with a message that names the folder", async () => {
    const missing = path.join(work, "no-such-folder");
    const err = await run({ dir: missing }).catch((e) => e);
    expect(err).toBeInstanceOf(FullBackupError);
    expect(err.code).toBe("BACKUP_DIR_NOT_WRITABLE");
    expect(err.message).toContain(missing);
  });

  it.runIf(isPosix && process.getuid?.() !== 0)("a backup folder that is not writable fails with a message that names the folder", async () => {
    chmodSync(backups, 0o500);
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(FullBackupError);
    expect(err.code).toBe("BACKUP_DIR_NOT_WRITABLE");
    expect(err.message).toContain(backups);
    expect(err.message).toMatch(/not writable/i);
  });

  it("R9: a corrupted file among good ones is SKIPPED, loudly — the backup succeeds and verifies, the others are intact, manifest.skipped and the audit entry record it", async () => {
    await seedUploads();
    // A real BVF1 file with one ciphertext byte flipped: exists, reads, fails to decrypt.
    const corrupt = await upload("images/firearms/corrupt.jpg", Buffer.from("this will not decrypt ".repeat(100)));
    const bytes = readFileSync(corrupt);
    bytes[bytes.length - 40] ^= 0xff;
    writeFileSync(corrupt, bytes);
    // And one that was never encrypted at all.
    writeFileSync(path.join(root, "images/firearms/plain.jpg"), "not BVF1: plaintext at rest");

    const result = await run();

    expect(result.files).toBe(3);
    expect(result.bytes).toBe(IMG_A.length + IMG_B.length + DOC_C.length);
    expect(result.skipped).toEqual([
      { path: "files/images/firearms/corrupt.jpg", kind: "unreadable", reason: "unreadable: could not be decrypted (AUTH_FAILED)" },
      { path: "files/images/firearms/plain.jpg", kind: "unreadable", reason: "unreadable: could not be decrypted (PLAINTEXT_AT_REST)" },
    ]);
    // Distinguishable from a vanished file by the reason alone (the manifest has no `kind`).
    expect(result.skipped.every((s) => !/vanished/.test(s.reason))).toBe(true);
    expect(backupFolder()).toEqual([result.file]);

    await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 3, bytes: result.bytes });

    const opened = await open(result.path);
    expect(opened.manifest.skipped).toEqual(result.skipped.map(({ path: p, reason }) => ({ path: p, reason })));
    // No half-written entry for a skipped file: the archive holds exactly the good files.
    expect(opened.order).toEqual([
      "db.json",
      "files/images/firearms/a.jpg",
      "files/images/firearms/b.jpg",
      `files/documents/${NEEDLE}-c.pdf`,
      "manifest.json",
    ]);
    const expected: Record<string, Buffer> = {
      "files/images/firearms/a.jpg": IMG_A,
      "files/images/firearms/b.jpg": IMG_B,
      [`files/documents/${NEEDLE}-c.pdf`]: DOC_C,
    };
    for (const f of opened.manifest.files) {
      expect(f.sha256, f.path).toBe(sha(expected[f.path]));
      expect(opened.entries.get(f.path)!.equals(expected[f.path]), f.path).toBe(true);
    }

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].changes ?? "null")).toEqual({ full: true, file: result.file, files: 3, bytes: result.bytes, verified: true, skipped: 2 });
  });

  it.runIf(isPosix && process.getuid?.() !== 0)("R9: a file that exists but cannot be read (EACCES) is skipped as unreadable too", async () => {
    await seedUploads();
    const locked = await upload("images/firearms/locked.jpg", IMG_A);
    chmodSync(locked, 0o000);
    try {
      const result = await run();
      expect(result.files).toBe(3);
      expect(result.skipped).toEqual([{ path: "files/images/firearms/locked.jpg", kind: "unreadable", reason: "unreadable: could not be read (EACCES)" }]);
      await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 3 });
    } finally {
      chmodSync(locked, 0o600);
    }
  });

  describe("R15: the .partial name carries a per-run token; publishing never replaces another backup", () => {
    /** Every `.bvb.partial` path the engine creates, in order. */
    function watchPartials(): string[] {
      const seen: string[] = [];
      const realOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
        if (String(args[0]).endsWith(".bvb.partial") && args[1] === "wx") seen.push(String(args[0]));
        return realOpen(...args);
      }) as typeof fsp.open);
      return seen;
    }

    it("two runs with the SAME injected `now` write different partials, and the partial name never looks like a published backup", async () => {
      const partials = watchPartials();
      const a = await run();
      const b = await run();
      expect(partials).toHaveLength(2);
      expect(partials[0]).not.toBe(partials[1]);
      for (const p of partials) {
        expect(path.basename(p)).toMatch(PARTIAL_NAME);
        // Still what the orphan cleanup looks for...
        expect(path.basename(p).startsWith("blackvault-full-") && p.endsWith(".bvb.partial")).toBe(true);
        // ...and never what a listing of published backups (`blackvault-full-*.bvb`) matches.
        expect(/^blackvault-full-.*\.bvb$/.test(path.basename(p))).toBe(false);
      }
      // The published names are unchanged: no token.
      expect([a.file, b.file]).toEqual([NAME, "blackvault-full-20261002-180406.bvb"]);
    });

    it("the finding's ordering: run 1's partial is removed by run 2's cleanup while run 2 is active in the same second → run 1 rejects (ENOENT) and publishes nothing; it never verifies or renames run 2's file", async () => {
      await seedUploads();
      lockHook.bypass = true; // both runs "hold" the lock
      const partials = watchPartials();
      const published: Array<{ from: string; to: string }> = [];
      for (const fn of ["link", "rename"] as const) {
        const real = (fsp[fn] as (a: string, b: string) => Promise<void>).bind(fsp);
        vi.spyOn(fsp, fn).mockImplementation((async (from: string, to: string) => {
          if (String(to).endsWith(".bvb")) published.push({ from: String(from), to: String(to) });
          return real(from, to);
        }) as never);
      }

      // Both runs stop at the start of their verify — archive fully written and synced, not yet published.
      const reached = [0, 1].map(() => {
        let open!: () => void;
        return { promise: new Promise<void>((r) => (open = r)), open };
      });
      const release = [0, 1].map(() => {
        let open!: () => void;
        return { promise: new Promise<void>((r) => (open = r)), open };
      });
      const verified: string[] = [];
      verifyHook.gate = async (call, file) => {
        verified.push(file);
        reached[call - 1].open();
        await release[call - 1].promise;
      };

      const run1 = run();
      run1.catch(() => undefined);
      await within(30_000, reached[0].promise); // run 1 wrote its partial and waits to verify
      const run2 = run(); // same `now`: its cleanup removes run 1's partial, then it writes its own
      run2.catch(() => undefined);
      await within(30_000, reached[1].promise); // run 2's partial is complete, unpublished

      expect(partials).toHaveLength(2);
      expect(partials[0]).not.toBe(partials[1]); // without the token run 2 would reuse run 1's name
      expect(readdirSync(backups).filter((n) => n.endsWith(".partial"))).toEqual([path.basename(partials[1])]);

      // Run 1 goes first, while run 2's complete partial sits in the folder.
      release[0].open();
      const err1 = await within(30_000, run1.catch((e) => e));
      expect(err1).toBeInstanceOf(Error);
      expect((err1 as NodeJS.ErrnoException).code).toBe("ENOENT");
      expect(published).toEqual([]); // run 1 published nothing — in particular not run 2's file
      expect(readdirSync(backups)).toEqual([path.basename(partials[1])]); // and did not delete run 2's partial

      release[1].open();
      const result2 = await within(30_000, run2);
      expect(result2.file).toBe(NAME);
      expect(published).toEqual([{ from: partials[1], to: path.join(backups, NAME) }]);
      expect(verified).toEqual([partials[0], partials[1]]); // each run verified only its own path
      expect(backupFolder()).toEqual([NAME]);
      expect(await events()).toHaveLength(1);
      vi.restoreAllMocks();
      verifyHook.gate = null;
      await expect(actualVerify(result2.path, PASS)).resolves.toMatchObject({ files: 3 });
    });

    it("a backup published under this run's name while it was verifying is NOT replaced: this run takes the next second's name", async () => {
      await seedUploads();
      const other = Buffer.from("another run's published backup — must survive byte for byte");
      verifyHook.gate = async () => {
        writeFileSync(path.join(backups, NAME), other); // appears after this run chose its name
      };
      const result = await run();
      expect(result.file).toBe("blackvault-full-20261002-180406.bvb");
      expect(backupFolder()).toEqual([NAME, result.file]);
      expect(readFileSync(path.join(backups, NAME)).equals(other)).toBe(true);
      verifyHook.gate = null;
      await expect(actualVerify(result.path, PASS)).resolves.toMatchObject({ files: 3 });
      const rows = await events();
      expect(JSON.parse(rows[0].changes ?? "null").file).toBe(result.file);
      if (isPosix) expect(statSync(result.path).mode & 0o777).toBe(0o600);
    });

    // R16: any link error but EEXIST / ENOENT falls back — EACCES (SMB), EXDEV (a union filesystem) and EIO are not on any "unsupported" list.
    it.each(["EPERM", "ENOTSUP", "ENOSYS", "EOPNOTSUPP", "EMLINK", "EACCES", "EXDEV", "EIO"])("a folder that cannot hard-link (%s, e.g. an SMB share) still publishes, and still refuses a name that is taken", async (code) => {
      vi.spyOn(fsp, "link").mockImplementation((async () => {
        throw Object.assign(new Error(`${code}: link`), { code, syscall: "link" });
      }) as never);
      const first = await run();
      expect(first.file).toBe(NAME);
      const second = await run();
      expect(second.file).toBe("blackvault-full-20261002-180406.bvb");
      expect(backupFolder()).toEqual([first.file, second.file]);
    });

    it("R16: link fails with ENOENT (the work file is gone) → no fallback: rename is never tried, the run fails, nothing is published", async () => {
      vi.spyOn(fsp, "link").mockImplementation((async () => {
        throw Object.assign(new Error("ENOENT: link"), { code: "ENOENT", syscall: "link" });
      }) as never);
      const rename = vi.spyOn(fsp, "rename");
      await expect(run()).rejects.toMatchObject({ code: "ENOENT", syscall: "link" });
      expect(rename.mock.calls.filter(([, to]) => String(to).endsWith(".bvb"))).toEqual([]);
      expect(backupFolder()).toEqual([]);
      expect(await events()).toHaveLength(0);
    });

    it("R16: a real fault (link EIO, then the fallback rename EIO too) fails the run with the rename's error and leaves no .partial", async () => {
      vi.spyOn(fsp, "link").mockImplementation((async () => {
        throw Object.assign(new Error("EIO: link"), { code: "EIO", syscall: "link" });
      }) as never);
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, "rename").mockImplementation((async (from: string, to: string) => {
        if (String(to).endsWith(".bvb")) throw Object.assign(new Error("EIO: rename"), { code: "EIO", syscall: "rename" });
        return realRename(from, to);
      }) as never);
      await expect(run()).rejects.toMatchObject({ code: "EIO", syscall: "rename" });
      expect(backupFolder()).toEqual([]);
      expect(await events()).toHaveLength(0);
    });
  });

  it("two backups in the same second get different names; neither overwrites the other", async () => {
    const a = await run();
    const b = await run();
    expect(a.file).toBe(NAME);
    expect(b.file).toBe("blackvault-full-20261002-180406.bvb");
    expect(backupFolder()).toEqual([a.file, b.file]);
  });
});
