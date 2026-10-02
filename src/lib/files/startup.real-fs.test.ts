import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

/**
 * Task 3 (spec 3b §2 "Startup", §3 "Resume"): runFileStartup against REAL
 * temp directories and a throw-away SQLite database (`connection_limit=1`)
 * for the Document rows and the audit event. The repo's `uploads/`,
 * `storage/` and `prisma/prisma/dev.db` are never touched: every test passes
 * its own IMAGE_UPLOAD_DIR (in `env`) and its own `cwd` (legacy root).
 *
 * The key is the fixed test key from vitest.config.ts (`test.env`).
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-file-startup-${process.pid}-${Date.now()}`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  return { dir, file: `${dir}/t.db` };
});

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient } from "@/lib/prisma";
import { decryptFile, deriveKeys, encryptFile, fileKeyId, isEncryptedFile } from "@/lib/encryption/core.mjs";
import { getFieldKeys, resetFieldKeysForTests } from "@/lib/encryption/keys";
import { FileStartupError, runFileStartup, uploadsHostPath } from "./startup";

const OTHER_KEYS = deriveKeys(Buffer.from("11".repeat(32), "hex"));
const NOW = new Date("2026-10-01T12:34:56.000Z");
const STAMP = "20261001-123456";
const isPosixNonRoot = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;

let raw: PrismaClient;
let work: string;
let root: string; // the uploads root (IMAGE_UPLOAD_DIR)
let cwd: string; // the app cwd (legacy root lives under it)
let env: NodeJS.ProcessEnv;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

const run = (extraEnv: Record<string, string> = {}) =>
  within(30_000, runFileStartup(raw, { now: NOW, cwd, env: { ...env, ...extraEnv } as unknown as NodeJS.ProcessEnv }));

function put(rel: string, bytes: Buffer | string, base = root): string {
  const abs = path.join(base, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  return abs;
}

/** The plaintext of a BVF1 file at `abs`, under the current key. */
function plain(abs: string): Buffer {
  const stored = readFileSync(abs);
  expect(isEncryptedFile(stored)).toBe(true);
  return decryptFile(getFieldKeys(), path.basename(abs), stored);
}

const legacy = () => path.join(cwd, "storage", "uploads", "documents");
const snapshotDirs = () => (existsSync(root) ? readdirSync(root).filter((n) => n.startsWith(".pre-encryption-")) : []);
const events = () => raw.auditEvent.findMany({ where: { action: "FILES_ENCRYPTED" }, orderBy: { at: "asc" } });
const changesOf = (e: { changes: string | null }) => JSON.parse(e.changes ?? "null");
const logged = () => vi.mocked(console.log).mock.calls.flat().join("\n");
const warned = () => vi.mocked(console.error).mock.calls.flat().join("\n");

beforeAll(async () => {
  mkdirSync(ctx.dir, { recursive: true });
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: `file:${ctx.file}` },
    stdio: "pipe",
    timeout: 90_000,
  });
  raw = createRawPrismaClient();
}, 120_000);

afterAll(async () => {
  await raw?.$disconnect();
  rmSync(ctx.dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await within(10_000, raw.auditEvent.deleteMany());
  await within(10_000, raw.document.deleteMany());
  resetFieldKeysForTests();
  work = path.join(ctx.dir, `w-${Math.random().toString(16).slice(2)}`);
  root = path.join(work, "uploads");
  cwd = path.join(work, "app");
  mkdirSync(cwd, { recursive: true });
  env = { IMAGE_UPLOAD_DIR: root } as unknown as NodeJS.ProcessEnv;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // Undo any read-only/unreadable modes a test set, so cleanup can remove them.
  if (existsSync(work) && process.platform !== "win32") {
    const walk = (d: string) => {
      chmodSync(d, 0o700);
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (!e.isSymbolicLink()) chmodSync(p, 0o600);
      }
    };
    walk(work);
  }
});

describe("runFileStartup", () => {
  it("fresh state with no files and no documents: nothing happens and no event is written", async () => {
    const result = await run();
    expect(result).toEqual({ moved: 0, counts: { images: 0, documents: 0 }, missing: [], snapshot: null, finishedRotations: 0 });
    expect(await events()).toEqual([]);
    expect(snapshotDirs()).toEqual([]);
  });

  it("deletes leftover *.tmp files anywhere under the uploads root, but never inside a .pre-encryption-* folder", async () => {
    const keep = put(".pre-encryption-20250101-000000/images/a.jpg.0011aabb.tmp", "snapshot leftover");
    const t1 = put("images/a.jpg.0011aabb.tmp", "partial");
    const t2 = put("documents/nested/b.pdf.ccdd0011.tmp", "partial");
    await run();
    expect(existsSync(t1)).toBe(false);
    expect(existsSync(t2)).toBe(false);
    expect(readFileSync(keep, "utf8")).toBe("snapshot leftover");
  });

  it("moves legacy documents onto the volume and then encrypts them", async () => {
    put("a.pdf", "%PDF-a", legacy());
    put("b.pdf", "%PDF-b", legacy());
    const result = await run();
    expect(result.moved).toBe(2);
    expect(result.counts).toEqual({ images: 0, documents: 2 });
    expect(plain(path.join(root, "documents", "a.pdf")).toString()).toBe("%PDF-a");
    expect(plain(path.join(root, "documents", "b.pdf")).toString()).toBe("%PDF-b");
    expect(readdirSync(legacy())).toEqual([]);
  });

  it("Review Focus 1: a name collision keeps the destination, leaves the legacy copy and logs it", async () => {
    const dest = put("documents/same.pdf", encryptFile(getFieldKeys(), "same.pdf", Buffer.from("%PDF-new")));
    const destBytes = readFileSync(dest);
    const src = put("same.pdf", "%PDF-old", legacy());
    const result = await run();
    expect(result.moved).toBe(0);
    expect(readFileSync(dest).equals(destBytes)).toBe(true);
    expect(readFileSync(src, "utf8")).toBe("%PDF-old");
    expect(logged() + warned()).toContain(src);
    expect(logged() + warned()).toMatch(/already exists/);
  });

  it("Review Focus 2: an EXDEV rename falls back to copy, fsync, unlink", async () => {
    const src = put("x.pdf", "%PDF-cross-device", legacy());
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(from) === src) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return realRename(from, to);
    });
    const result = await run();
    expect(result.moved).toBe(1);
    expect(existsSync(src)).toBe(false);
    expect(plain(path.join(root, "documents", "x.pdf")).toString()).toBe("%PDF-cross-device");
  });

  it("Review Focus 2: a failed copy after EXDEV leaves the source intact and refuses to start, naming the file", async () => {
    const src = put("y.pdf", "%PDF-keep-me", legacy());
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(from) === src) throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      return realRename(from, to);
    });
    const realOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, "open").mockImplementation(async (p, ...rest) => {
      if (String(p).startsWith(path.join(root, "documents", "y.pdf"))) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realOpen(p, ...(rest as [string]));
    });
    await expect(run()).rejects.toThrow(src);
    expect(readFileSync(src, "utf8")).toBe("%PDF-keep-me");
    const docs = path.join(root, "documents");
    expect(existsSync(docs) ? readdirSync(docs) : []).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("snapshot: plaintext-only copy, dir 0700 / files 0600, holds the plaintext bytes, and the scan skips it", async () => {
    put("images/p.jpg", "jpeg-plain");
    put("documents/d.pdf", "%PDF-plain");
    const already = put("images/e.jpg", encryptFile(getFieldKeys(), "e.jpg", Buffer.from("enc-already")));
    const result = await run();

    const snap = path.join(root, `.pre-encryption-${STAMP}`);
    expect(snapshotDirs()).toEqual([`.pre-encryption-${STAMP}`]);
    expect(result.snapshot).toContain(`.pre-encryption-${STAMP}`);
    expect(readFileSync(path.join(snap, "images", "p.jpg"), "utf8")).toBe("jpeg-plain");
    expect(readFileSync(path.join(snap, "documents", "d.pdf"), "utf8")).toBe("%PDF-plain");
    expect(existsSync(path.join(snap, "images", "e.jpg"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(snap).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(snap, "images")).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(snap, "documents")).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(snap, "images", "p.jpg")).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(snap, "documents", "d.pdf")).mode & 0o777).toBe(0o600);
    }
    expect(plain(path.join(root, "images", "p.jpg")).toString()).toBe("jpeg-plain");
    expect(plain(already).toString()).toBe("enc-already");
    expect(logged() + warned()).toMatch(/PLAINTEXT/);
    expect(logged() + warned()).toMatch(/sudo/);

    // The scan skips the snapshot: a second run leaves its plaintext alone.
    const again = await run();
    expect(again.counts).toEqual({ images: 0, documents: 0 });
    expect(readFileSync(path.join(snap, "images", "p.jpg"), "utf8")).toBe("jpeg-plain");
  });

  it("with BLACKVAULT_UPLOADS_SNAPSHOT set, no snapshot is taken (the update script took one)", async () => {
    put("images/p.jpg", "jpeg-plain");
    const result = await run({ BLACKVAULT_UPLOADS_SNAPSHOT: "/srv/blackvault/backups/uploads-20261001-120000" });
    expect(snapshotDirs()).toEqual([]);
    expect(result.snapshot).toBe("/srv/blackvault/backups/uploads-20261001-120000");
    expect(result.counts.images).toBe(1);
  });

  it.skipIf(!isPosixNonRoot)("a snapshot failure (read-only uploads root) refuses to start and encrypts nothing", async () => {
    const p = put("images/p.jpg", "jpeg-plain");
    chmodSync(root, 0o555);
    await expect(run()).rejects.toThrow(/snapshot/i);
    chmodSync(root, 0o700);
    expect(readFileSync(p, "utf8")).toBe("jpeg-plain");
    expect(snapshotDirs()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it("is idempotent: a second run changes nothing and writes no event", async () => {
    put("images/p.jpg", "jpeg-plain");
    put("documents/d.pdf", "%PDF-plain");
    put("l.pdf", "%PDF-legacy", legacy());
    await run();
    expect(await events()).toHaveLength(1);
    const before = new Map(
      ["images/p.jpg", "documents/d.pdf", "documents/l.pdf"].map((r) => [r, readFileSync(path.join(root, r))] as const),
    );
    const result = await run();
    expect(result).toEqual({ moved: 0, counts: { images: 0, documents: 0 }, missing: [], snapshot: null, finishedRotations: 0 });
    for (const [r, bytes] of before) expect(readFileSync(path.join(root, r)).equals(bytes)).toBe(true);
    expect(await events()).toHaveLength(1);
    expect(snapshotDirs()).toHaveLength(1);
  });

  it("resumes after a crash: the files before the crash are encrypted, the rest plaintext, and the next run finishes", async () => {
    const files = ["a", "b", "c", "d", "e"].map((n) => put(`images/${n}.jpg`, `jpeg-${n}`));
    const realRename = fsp.rename.bind(fsp);
    let tmpRenames = 0;
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith(".tmp") && ++tmpRenames === 3) throw new Error("injected crash on the third file");
      return realRename(from, to);
    });
    await expect(run()).rejects.toThrow(files[2]);
    expect(isEncryptedFile(readFileSync(files[0]))).toBe(true);
    expect(isEncryptedFile(readFileSync(files[1]))).toBe(true);
    for (const f of files.slice(2)) expect(readFileSync(f, "utf8")).toMatch(/^jpeg-/);
    expect(readdirSync(path.join(root, "images")).filter((n) => n.endsWith(".tmp"))).toEqual([]);

    vi.mocked(fsp.rename).mockRestore();
    const result = await run();
    expect(result.counts.images).toBe(3);
    files.forEach((f, i) => expect(plain(f).toString()).toBe(`jpeg-${"abcde"[i]}`));
    // The first run's complete snapshot already holds every remaining plaintext file: reused, not repeated.
    expect(snapshotDirs()).toHaveLength(1);
    // Fix round 1, M2: the first event counts every encrypted file, not only this run's three.
    const all = await events();
    expect(all).toHaveLength(1);
    expect(changesOf(all[0]).counts).toEqual({ images: 5, documents: 0 });
  });

  it("an unreadable file refuses to start and names the path", async () => {
    if (!isPosixNonRoot) return;
    put("images/a.jpg", "jpeg-a");
    const locked = put("images/b.jpg", "jpeg-b");
    chmodSync(locked, 0o000);
    await expect(run()).rejects.toThrow(locked);
  });

  it(".rot under the current key is finalised; .rot under another key is deleted", async () => {
    const keys = getFieldKeys();
    // a.jpg: an interrupted finalise — original still under the old key, .rot under the current one.
    const a = put("images/a.jpg", encryptFile(OTHER_KEYS, "a.jpg", Buffer.from("photo-a")));
    put("images/a.jpg.rot", encryptFile(keys, "a.jpg", Buffer.from("photo-a")));
    // b.jpg: a rotation that never committed — original under the current key, .rot under another.
    const b = put("images/b.jpg", encryptFile(keys, "b.jpg", Buffer.from("photo-b")));
    const bBytes = readFileSync(b);
    put("images/b.jpg.rot", encryptFile(OTHER_KEYS, "b.jpg", Buffer.from("photo-b")));
    // c.jpg: only the .rot exists, under the current key — it is the only copy, so it is put in place.
    const c = path.join(root, "images", "c.jpg");
    put("images/c.jpg.rot", encryptFile(keys, "c.jpg", Buffer.from("photo-c")));

    const result = await run();
    expect(result.finishedRotations).toBe(2);
    expect(fileKeyId(readFileSync(a))).toBe(keys.id);
    expect(plain(a).toString()).toBe("photo-a");
    expect(readFileSync(b).equals(bBytes)).toBe(true);
    expect(plain(c).toString()).toBe("photo-c");
    expect(readdirSync(path.join(root, "images")).filter((n) => n.endsWith(".rot"))).toEqual([]);
    expect(logged() + warned()).toContain(c);
  });

  it("a .rot under another key whose original is missing is kept (it may be the only copy) and reported", async () => {
    const rot = put("images/d.jpg.rot", encryptFile(OTHER_KEYS, "d.jpg", Buffer.from("photo-d")));
    const bytes = readFileSync(rot);
    const result = await run();
    expect(result.finishedRotations).toBe(0);
    expect(readFileSync(rot).equals(bytes)).toBe(true);
    expect(existsSync(path.join(root, "images", "d.jpg"))).toBe(false);
    expect(warned()).toContain(rot);
  });

  it("a .rot under the current key that does not decrypt refuses to start and touches neither file", async () => {
    const orig = put("images/f.jpg", encryptFile(OTHER_KEYS, "f.jpg", Buffer.from("photo-f")));
    const origBytes = readFileSync(orig);
    // Encrypted under the WRONG basename: the AAD check fails for f.jpg.
    const rot = put("images/f.jpg.rot", encryptFile(getFieldKeys(), "other.jpg", Buffer.from("photo-f")));
    const rotBytes = readFileSync(rot);
    await expect(run()).rejects.toThrow(rot);
    expect(readFileSync(orig).equals(origBytes)).toBe(true);
    expect(readFileSync(rot).equals(rotBytes)).toBe(true);
  });

  it("a BVF1 file under a foreign key id refuses to start, naming the file and the key id", async () => {
    const foreign = put("images/z.jpg", encryptFile(OTHER_KEYS, "z.jpg", Buffer.from("old")));
    const p = put("images/p.jpg", "jpeg-plain");
    const err = await run().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain(foreign);
    expect(err?.message).toContain(OTHER_KEYS.id);
    // Refused before anything changed.
    expect(readFileSync(p, "utf8")).toBe("jpeg-plain");
    expect(await events()).toEqual([]);
  });

  it("reports missing documents by id and name in the log and in changes.missing, and still starts", async () => {
    put("images/p.jpg", "jpeg-plain");
    put("documents/here.pdf", "%PDF-here");
    await raw.document.createMany({
      data: [
        { id: "doc-here", name: "Present", type: "RECEIPT", fileUrl: "/api/files/documents/here.pdf" },
        { id: "doc-m1", name: "Form 4 scan", type: "NFA", fileUrl: "/api/files/documents/gone-1.pdf" },
        { id: "doc-m2", name: "Receipt", type: "RECEIPT", fileUrl: "/api/files/documents/gone-2.pdf" },
        { id: "doc-ext", name: "Link", type: "OTHER", fileUrl: "https://example.com/manual.pdf" },
      ],
    });
    const result = await run();
    expect(result.missing).toEqual([
      { id: "doc-m1", name: "Form 4 scan" },
      { id: "doc-m2", name: "Receipt" },
    ]);
    const out = logged() + warned();
    expect(out).toMatch(/doc-m1.*Form 4 scan/);
    expect(out).toMatch(/doc-m2.*Receipt/);
    const [event] = await events();
    expect(changesOf(event).missing).toEqual(result.missing);
    expect(changesOf(event).missingTotal).toBe(2);
  });

  it("missing documents alone (nothing to encrypt) are audited once, not on every start", async () => {
    await raw.document.create({ data: { id: "doc-m1", name: "Form 4 scan", type: "NFA", fileUrl: "/api/files/documents/gone.pdf" } });
    const first = await run();
    expect(first.missing).toEqual([{ id: "doc-m1", name: "Form 4 scan" }]);
    expect(await events()).toHaveLength(1);
    const second = await run();
    expect(second.missing).toEqual([{ id: "doc-m1", name: "Form 4 scan" }]);
    expect(await events()).toHaveLength(1);
  });

  it("caps changes.missing at 200 entries and records missingTotal", async () => {
    await raw.document.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        id: `doc-${String(i).padStart(3, "0")}`,
        name: `Doc ${i}`,
        type: "OTHER",
        fileUrl: `/api/files/documents/gone-${i}.pdf`,
      })),
    });
    const result = await run();
    expect(result.missing).toHaveLength(205);
    const [event] = await events();
    expect(changesOf(event).missing).toHaveLength(200);
    expect(changesOf(event).missingTotal).toBe(205);
  });

  it("FILES_ENCRYPTED: one system event with the right counts, moved, keyId and snapshot", async () => {
    put("images/a.jpg", "jpeg-a");
    put("images/sub/b.png", "png-b");
    put("documents/c.pdf", "%PDF-c");
    put("m.pdf", "%PDF-m", legacy());
    put(".hidden", "dotfile stays");
    const result = await run();
    expect(result.counts).toEqual({ images: 2, documents: 2 });
    expect(result.moved).toBe(1);
    const all = await events();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ actorName: "system", actorId: null, entityType: null });
    expect(changesOf(all[0])).toEqual({
      counts: { images: 2, documents: 2 },
      moved: 1,
      missing: [],
      missingTotal: 0,
      keyId: getFieldKeys().id,
      snapshot: result.snapshot,
    });
    expect(readFileSync(path.join(root, ".hidden"), "utf8")).toBe("dotfile stays");
  });

  it("never follows a symlink: a symlinked file is left alone and reported", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(work, "outside.jpg");
    writeFileSync(outside, "outside-plain");
    mkdirSync(path.join(root, "images"), { recursive: true });
    const link = path.join(root, "images", "link.jpg");
    execFileSync("ln", ["-s", outside, link]);
    await run();
    expect(readFileSync(outside, "utf8")).toBe("outside-plain");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(warned()).toContain(link);
  });
});

describe("runFileStartup — fix round 1", () => {
  it("M1: a hand-placed legacy report.tmp is never moved and survives two starts; only writeAtomic's own temp names are swept", async () => {
    const legacyTmp = put("report.tmp", "only copy", legacy());
    const userTmp = put("images/notes.tmp", "user file");
    const atomicTmp = put("images/a.jpg.0a1b2c3d.tmp", "partial");
    await run();
    await run();
    expect(readFileSync(legacyTmp, "utf8")).toBe("only copy");
    expect(existsSync(path.join(root, "documents", "report.tmp"))).toBe(false);
    expect(warned()).toContain(legacyTmp);
    expect(readFileSync(userTmp, "utf8")).toBe("user file");
    expect(existsSync(atomicTmp)).toBe(false);
  });

  it("M2: an audit write failure is recovered: the restart writes exactly one event with the totals", async () => {
    put("images/a.jpg", "jpeg-a");
    put("images/b.jpg", "jpeg-b");
    put("l.pdf", "%PDF-l", legacy());
    const failing = {
      document: raw.document,
      auditEvent: {
        count: (a: never) => raw.auditEvent.count(a),
        create: async () => {
          throw new Error("SQLITE_BUSY");
        },
      },
    } as unknown as PrismaClient;
    await expect(within(30_000, runFileStartup(failing, { now: NOW, cwd, env }))).rejects.toThrow(/SQLITE_BUSY/);
    expect(await events()).toEqual([]);
    const result = await run();
    expect(result.counts).toEqual({ images: 0, documents: 0 });
    const all = await events();
    expect(all).toHaveLength(1);
    expect(changesOf(all[0])).toMatchObject({ counts: { images: 2, documents: 1 }, moved: 0 });
    await run();
    expect(await events()).toHaveLength(1);
  });

  it("M3: an EXDEV copy that does not read back identically is removed, and the source kept", async () => {
    const src = put("z.pdf", "%PDF-good", legacy());
    const dest = path.join(root, "documents", "z.pdf");
    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(from) === src) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      return realRename(from, to);
    });
    const realRead = fsp.readFile.bind(fsp) as (p: unknown, o?: unknown) => Promise<Buffer>;
    vi.spyOn(fsp, "readFile").mockImplementation((async (p: unknown, o?: unknown) => {
      const b = await realRead(p, o);
      return String(p) === dest ? Buffer.from("corrupt") : b;
    }) as never);
    await expect(run()).rejects.toThrow(/does not match/);
    expect(existsSync(dest)).toBe(false);
    expect(readFileSync(src, "utf8")).toBe("%PDF-good");
  });

  it("M4: documents/ as a symlink refuses to start, naming it, before anything moves", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(work, "docs-elsewhere");
    mkdirSync(outside, { recursive: true });
    mkdirSync(root, { recursive: true });
    const link = path.join(root, "documents");
    execFileSync("ln", ["-s", outside, link]);
    const src = put("d.pdf", "%PDF-d", legacy());
    await expect(run()).rejects.toThrow(link);
    expect(readFileSync(src, "utf8")).toBe("%PDF-d");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("M4: any symlinked directory the scan would enter refuses to start, naming it", async () => {
    if (process.platform === "win32") return;
    const outside = path.join(work, "elsewhere");
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, "x.jpg"), "outside-plain");
    mkdirSync(path.join(root, "images"), { recursive: true });
    const link = path.join(root, "images", "linked");
    execFileSync("ln", ["-s", outside, link]);
    const p = put("images/p.jpg", "jpeg-plain");
    await expect(run()).rejects.toThrow(link);
    expect(readFileSync(p, "utf8")).toBe("jpeg-plain");
    expect(readFileSync(path.join(outside, "x.jpg"), "utf8")).toBe("outside-plain");
  });

  it("M5: files inside hidden directories are left alone", async () => {
    const hidden = put(".thumbs/a.jpg", "hidden-dir-file");
    const result = await run();
    expect(readFileSync(hidden, "utf8")).toBe("hidden-dir-file");
    expect(result.counts).toEqual({ images: 0, documents: 0 });
  });

  it("M6: a raw fs failure becomes a FileStartupError naming the path, with a fix hint", async () => {
    const t = put("images/a.jpg.0a1b2c3d.tmp", "partial");
    const realRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, "rm").mockImplementation(async (p, o) => {
      if (String(p) === t) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return realRm(p, o);
    });
    const err = await run().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(FileStartupError);
    expect((err as Error).message).toContain(t);
    expect((err as Error).message).toContain("EACCES");
    expect((err as Error).message).toMatch(/start again/);
  });

  it("M7: logs progress every 250 files during the snapshot and the encryption", async () => {
    for (let i = 0; i < 260; i++) put(`images/p${String(i).padStart(3, "0")}.jpg`, `jpeg-${i}`);
    await run();
    expect(logged()).toContain("[files] snapshot 250/260");
    expect(logged()).toContain("[files] encrypted 250/260");
  }, 60_000);

  it("M8: with the update-script marker set, legacy documents are still snapshotted before they move", async () => {
    put("images/p.jpg", "jpeg-plain");
    put("l.pdf", "%PDF-legacy", legacy());
    const marker = "/srv/blackvault/backups/uploads-20261001-120000";
    const result = await run({ BLACKVAULT_UPLOADS_SNAPSHOT: marker });
    const snap = path.join(root, `.pre-encryption-${STAMP}`);
    expect(snapshotDirs()).toEqual([`.pre-encryption-${STAMP}`]);
    expect(readFileSync(path.join(snap, "documents", "l.pdf"), "utf8")).toBe("%PDF-legacy");
    expect(existsSync(path.join(snap, "images"))).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(snap).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(snap, "documents")).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(snap, "documents", "l.pdf")).mode & 0o777).toBe(0o600);
    }
    expect(plain(path.join(root, "documents", "l.pdf")).toString()).toBe("%PDF-legacy");
    expect(result.snapshot).toContain(marker);
    expect(result.snapshot).toContain(snap);
  });

  it("BLACKVAULT_HOST_UPLOADS_DIR maps an in-container uploads path to the host", () => {
    const env = { BLACKVAULT_HOST_UPLOADS_DIR: "/srv/blackvault/data/uploads" } as unknown as NodeJS.ProcessEnv;
    expect(uploadsHostPath("/app/uploads/.pre-encryption-20261001-123456", env)).toBe("/srv/blackvault/data/uploads/.pre-encryption-20261001-123456");
    expect(uploadsHostPath("/app/uploads/.pre-encryption-x", {} as unknown as NodeJS.ProcessEnv)).toMatch(/in the container.*uploads\/ folder/);
    expect(uploadsHostPath("/home/me/bv/uploads/.pre-encryption-x", env)).toBe("/home/me/bv/uploads/.pre-encryption-x");
  });
});
