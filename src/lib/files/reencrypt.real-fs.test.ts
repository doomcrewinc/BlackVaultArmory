import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";

/**
 * Task 8 (full-backups spec §3 "reencrypt-files"): reencryptFiles against REAL
 * temp directories. The app's startup file step (runFileStartup) is called for
 * real afterwards, on a throw-away SQLite database (`connection_limit=1`),
 * to prove the app accepts the folder. The repo's own `uploads/` and
 * `prisma/prisma/dev.db` are never touched.
 *
 * The CURRENT key is the fixed test key from vitest.config.ts (`test.env`).
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-reencrypt-${process.pid}-${Date.now()}`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  return { dir, file: `${dir}/t.db` };
});

/**
 * The in-memory round-trip check (encrypt, then decrypt and compare, BEFORE anything is written) can only
 * fail if the core's encryptFile returns bytes that do not decrypt to the input. `core.badEncrypt` makes it
 * do exactly that for one test; otherwise the real core is used unchanged.
 */
const core = vi.hoisted(() => ({ badEncrypt: false }));
vi.mock("@/lib/encryption/core.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/encryption/core.mjs")>();
  return {
    ...real,
    encryptFile: (keys: Parameters<typeof real.encryptFile>[0], basename: string, plaintext: Buffer) =>
      real.encryptFile(keys, basename, core.badEncrypt ? Buffer.concat([plaintext, Buffer.from("!")]) : plaintext),
  };
});

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient } from "@/lib/prisma";
import { decryptFile, deriveKeys, encryptFile, fileKeyId, type FieldKeys } from "@/lib/encryption/core.mjs";
import { getFieldKeys } from "@/lib/encryption/keys";
import { ReencryptError, ReencryptKeyError, parseOldKey, reencryptFiles, summaryLine } from "./reencrypt";
import { FileStartupError, runFileStartup } from "./startup";

const OLD_HEX = "11".repeat(32);
const THIRD_HEX = "22".repeat(32);
const OLD = deriveKeys(Buffer.from(OLD_HEX, "hex"));
const THIRD = deriveKeys(Buffer.from(THIRD_HEX, "hex"));
const CURRENT_HEX = process.env.BLACKVAULT_ENCRYPTION_KEY as string;
const PAST = new Date("2026-01-02T03:04:05.000Z");

let raw: PrismaClient;
let work: string;
let root: string;
let seq = 0;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Writes `bytes` at `rel` under the uploads root, with an old mtime so any rewrite shows. */
function putRaw(rel: string, bytes: Buffer): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
  utimesSync(abs, PAST, PAST);
  return abs;
}
const putEnc = (rel: string, keys: FieldKeys, plain: Buffer) => putRaw(rel, encryptFile(keys, path.basename(rel), plain));

/** Every file and link under the root: relative path → bytes (hex) and mtime. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out[r] = "link";
      else if (e.isDirectory()) visit(abs, r);
      else out[r] = `${statSync(abs).mtimeMs}:${readFileSync(abs).toString("hex")}`;
    }
  };
  visit(root, "");
  return out;
}

const idOf = (rel: string) => fileKeyId(readFileSync(path.join(root, rel)));
const plainOf = (rel: string, keys: FieldKeys) => decryptFile(keys, path.basename(rel), readFileSync(path.join(root, rel)));

const P = {
  a: Buffer.from("old-key image a ".repeat(300)),
  b: Buffer.from("old-key image b in a sub-folder"),
  d: Buffer.from("%PDF old-key document"),
  empty: Buffer.alloc(0),
  cur: Buffer.from("already under the current key"),
  third: Buffer.from("under a third key nobody has"),
  plain: Buffer.from("just a plain file, never encrypted"),
  skipped: Buffer.from("old-key bytes in a place the tool never looks"),
};
const OLD_FILES: Array<[string, Buffer]> = [
  ["images/a.jpg", P.a],
  ["images/sub/b.jpg", P.b],
  ["documents/d.pdf", P.d],
  ["documents/empty.pdf", P.empty],
];

/** Old-key files, current-key files, a third-key file, a plain file, a damaged header, and files in every skipped place. */
function seedMixed() {
  const current = getFieldKeys();
  for (const [rel, plain] of OLD_FILES) putEnc(rel, OLD, plain);
  putEnc("images/cur.jpg", current, P.cur);
  putEnc("documents/cur.pdf", current, P.cur);
  putEnc("images/third.jpg", THIRD, P.third);
  putRaw("images/plain.txt", P.plain);
  putRaw("images/damaged.jpg", Buffer.concat([Buffer.from("BVF1"), Buffer.from([1]), Buffer.from("ZZZZZZZZ"), Buffer.alloc(40, 9)]));
  // Skipped: hidden files and folders, the snapshot / restore work folders, *.tmp, *.rot, links, anything outside images/ and documents/.
  putEnc("images/.hidden.jpg", OLD, P.skipped);
  putEnc("images/.hidden-dir/x.jpg", OLD, P.skipped);
  putEnc(".pre-encryption-20261001-000000/images/x.jpg", OLD, P.skipped);
  putEnc(".restore-20261001-000000/images/x.jpg", OLD, P.skipped);
  putEnc(".pre-restore-20261001-000000/images/x.jpg", OLD, P.skipped);
  putEnc("images/x.jpg.0a1b2c3d.tmp", OLD, P.skipped);
  putEnc("images/x.jpg.rot", OLD, P.skipped);
  putEnc("other/x.jpg", OLD, P.skipped);
  putEnc("top.jpg", OLD, P.skipped);
  const outside = path.join(work, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, "o.jpg"), encryptFile(OLD, "o.jpg", P.skipped));
  symlinkSync(outside, path.join(root, "images", "linked-dir"));
  symlinkSync(path.join(outside, "o.jpg"), path.join(root, "images", "linked.jpg"));
}

const run = (oldKeys: FieldKeys = OLD) => within(30_000, reencryptFiles({ oldKeys, root, log: () => undefined, warn: () => undefined }));

/** The first `open` for writing after `skip` earlier ones puts half the bytes on disk, then fails like a full disk. */
function failNthWrite(skip: number) {
  const realOpen = fsp.open.bind(fsp);
  let writes = 0;
  return vi.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    const flags = String(args[1] ?? "r");
    if (flags.includes("w") && writes++ === skip) {
      const realWrite = handle.write.bind(handle);
      vi.spyOn(handle, "write").mockImplementation((async (buf: Buffer, off = 0, len = buf.length - off) => {
        await realWrite(buf, off, Math.max(1, Math.floor(len / 2)));
        const e = new Error("ENOSPC: no space left on device, write") as NodeJS.ErrnoException;
        e.code = "ENOSPC";
        throw e;
      }) as never);
    }
    return handle;
  }) as unknown as typeof fsp.open);
}

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
  await raw?.$disconnect().catch(() => undefined);
  rmSync(ctx.dir, { recursive: true, force: true });
});

beforeEach(() => {
  work = path.join(ctx.dir, `w${seq++}`);
  root = path.join(work, "uploads");
  mkdirSync(root, { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  core.badEncrypt = false;
  vi.restoreAllMocks();
});

/** The SECOND read of `target` (the read-back after its replacement) is answered by `answer`; every other read is real. */
function tamperReadBack(target: string, answer: (real: Buffer) => Buffer | Promise<Buffer>) {
  const realRead = fsp.readFile.bind(fsp) as (p: string) => Promise<Buffer>;
  let reads = 0;
  return vi.spyOn(fsp, "readFile").mockImplementation((async (p: unknown) => {
    const bytes = await realRead(String(p));
    if (String(p) === target && ++reads === 2) return answer(bytes);
    return bytes;
  }) as unknown as typeof fsp.readFile);
}

// Every re-encrypted file is fsynced (file and folder). On a busy machine that has taken more than the default 5 s.
describe("reencryptFiles (real filesystem)", { timeout: 60_000 }, () => {
  it("a mixed folder: only the old-key files change; they decrypt to the same plaintext under the CURRENT key; everything else is byte- and mtime-identical", async () => {
    seedMixed();
    const before = snapshot();

    const r = await run();

    expect(r.outcome).toBe("ok");
    expect(r.counts).toEqual({ reencrypted: 4, alreadyCurrent: 2, unknownKey: 2, notEncrypted: 1, failed: 0, stopped: 0 });
    const current = getFieldKeys();
    for (const [rel, plain] of OLD_FILES) {
      expect(idOf(rel), rel).toBe(current.id);
      expect(plainOf(rel, current).equals(plain), rel).toBe(true);
    }
    const after = snapshot();
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]).sort();
    expect(changed).toEqual(OLD_FILES.map(([rel]) => rel).sort());
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort()); // nothing deleted, no work file left
    // The third-key file still opens with its own key, and only with it.
    expect(plainOf("images/third.jpg", THIRD).equals(P.third)).toBe(true);
    expect(summaryLine(r)).toBe("BLACKVAULT_REENCRYPT_OK reencrypted=4 already_current=2 unknown_key=2 not_encrypted=1 failed=0 stopped=0");
  });

  it("the unknown-key files are named in WARNING lines (key id for a readable header, 'damaged' otherwise)", async () => {
    seedMixed();
    const warnings: string[] = [];
    await reencryptFiles({ oldKeys: OLD, root, log: () => undefined, warn: (l) => warnings.push(l) });
    expect(warnings.some((l) => l.startsWith("WARNING:") && l.includes("images/third.jpg") && l.includes(THIRD.id))).toBe(true);
    expect(warnings.some((l) => l.startsWith("WARNING:") && l.includes("images/damaged.jpg"))).toBe(true);
    expect(warnings.join("\n")).not.toContain(OLD_HEX);
  });

  it("re-running is a no-op: outcome 'nothing', and no file's bytes or mtime change", async () => {
    seedMixed();
    await run();
    const afterFirst = snapshot();

    const second = await run();

    expect(second.outcome).toBe("nothing");
    expect(second.counts).toEqual({ reencrypted: 0, alreadyCurrent: 6, unknownKey: 2, notEncrypted: 1, failed: 0, stopped: 0 });
    expect(snapshot()).toEqual(afterFirst);
    expect(summaryLine(second)).toBe("BLACKVAULT_REENCRYPT_NOTHING reencrypted=0 already_current=6 unknown_key=2 not_encrypted=1 failed=0 stopped=0");
  });

  it("a wrong key (valid format, matches nothing): outcome 'nothing' and nothing is touched", async () => {
    seedMixed();
    const before = snapshot();
    const r = await run(deriveKeys(Buffer.from("33".repeat(32), "hex")));
    expect(r.outcome).toBe("nothing");
    expect(r.counts.reencrypted).toBe(0);
    expect(r.counts.unknownKey).toBe(6); // the four old-key files, the third-key file and the damaged one
    expect(snapshot()).toEqual(before);
  });

  it("an empty or missing uploads folder: outcome 'nothing'", async () => {
    expect((await run()).outcome).toBe("nothing");
    root = path.join(work, "does-not-exist");
    expect((await run()).counts).toEqual({ reencrypted: 0, alreadyCurrent: 0, unknownKey: 0, notEncrypted: 0, failed: 0, stopped: 0 });
  });

  it("an invalid old key is refused (KEY_FILE_INVALID) and the install's own key is refused (SAME_KEY), before any file is read", async () => {
    seedMixed();
    const before = snapshot();
    const readdir = vi.spyOn(fsp, "readdir");
    for (const bad of ["", "not a key", "11".repeat(31), `${"11".repeat(32)}0`, "zz".repeat(32)]) {
      let thrown: unknown;
      try {
        parseOldKey(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, bad).toBeInstanceOf(ReencryptKeyError);
      expect((thrown as ReencryptKeyError).code).toBe("KEY_FILE_INVALID");
      expect((thrown as Error).message).not.toContain("11".repeat(31)); // the key text is never echoed
    }
    // The core's parsing: a byte-order mark, surrounding whitespace and upper case are accepted, as for the install's key file.
    expect(parseOldKey(`﻿ ${OLD_HEX.toUpperCase()}\r\n`).id).toBe(OLD.id);

    await expect(reencryptFiles({ oldKeys: parseOldKey(CURRENT_HEX), root })).rejects.toMatchObject({ name: "ReencryptKeyError", code: "SAME_KEY" });
    expect(readdir).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it("an old-key file that does not decrypt (damaged) is left untouched and reported; the others are still re-encrypted; outcome 'failed'", async () => {
    for (const [rel, plain] of OLD_FILES) putEnc(rel, OLD, plain);
    const bad = path.join(root, "documents/d.pdf");
    const bytes = readFileSync(bad);
    bytes[bytes.length - 1] ^= 0xff; // the GCM tag
    writeFileSync(bad, bytes);
    utimesSync(bad, PAST, PAST);
    const before = snapshot();

    const r = await run();

    expect(r.outcome).toBe("failed");
    expect(r.counts).toEqual({ reencrypted: 3, alreadyCurrent: 0, unknownKey: 0, notEncrypted: 0, failed: 1, stopped: 0 });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain("documents/d.pdf");
    expect(snapshot()["documents/d.pdf"]).toBe(before["documents/d.pdf"]);
    expect(idOf("images/a.jpg")).toBe(getFieldKeys().id);
    expect(summaryLine(r)).toBe("BLACKVAULT_REENCRYPT_FAILED reencrypted=3 already_current=0 unknown_key=0 not_encrypted=0 failed=1 stopped=0");
  });

  it("a failure halfway (a full disk in the middle of a write): every file is still complete and readable under one of the two keys, nothing is left behind, and a re-run finishes the job", async () => {
    for (const [rel, plain] of OLD_FILES) putEnc(rel, OLD, plain);
    const current = getFieldKeys();
    const names = Object.keys(snapshot()).sort();

    const spy = failNthWrite(2); // the third file's write
    let thrown: unknown;
    try {
      await run();
    } catch (e) {
      thrown = e;
    } finally {
      spy.mockRestore();
    }

    expect(thrown).toBeInstanceOf(ReencryptError);
    const err = thrown as ReencryptError;
    expect(err.message).toMatch(/ENOSPC/);
    expect(err.counts).toEqual({ reencrypted: 2, alreadyCurrent: 0, unknownKey: 0, notEncrypted: 0, failed: 1, stopped: 1 });
    expect(err.message).toMatch(/Could not write documents\/d\.pdf \(ENOSPC\); it was left as it was\./);
    expect(summaryLine({ outcome: "failed", counts: err.counts })).toBe("BLACKVAULT_REENCRYPT_FAILED reencrypted=2 already_current=0 unknown_key=0 not_encrypted=0 failed=1 stopped=1");
    // Every file: whole, and it decrypts to its plaintext under the old key or the current one.
    const ids: string[] = [];
    for (const [rel, plain] of OLD_FILES) {
      const id = idOf(rel);
      ids.push(id);
      expect([OLD.id, current.id], rel).toContain(id);
      expect(plainOf(rel, id === OLD.id ? OLD : current).equals(plain), rel).toBe(true);
    }
    expect(ids.filter((id) => id === current.id)).toHaveLength(2);
    expect(Object.keys(snapshot()).sort()).toEqual(names); // no temp file, nothing deleted

    const again = await run();
    expect(again.outcome).toBe("ok");
    expect(again.counts).toEqual({ reencrypted: 2, alreadyCurrent: 2, unknownKey: 0, notEncrypted: 0, failed: 0, stopped: 0 });
    for (const [rel, plain] of OLD_FILES) expect(plainOf(rel, current).equals(plain), rel).toBe(true);
  });

  describe("the read-back after a file has been replaced", () => {
    const eio = () => {
      const e = new Error("EIO: i/o error, read") as NodeJS.ErrnoException;
      e.code = "EIO";
      throw e;
    };
    it.each([
      ["returns different bytes", (): Buffer => encryptFile(getFieldKeys(), "a.jpg", Buffer.from("not what was written")), /the file read back differs from what was written/],
      ["fails (EIO)", eio, /EIO/],
    ] as Array<[string, () => Buffer, RegExp]>)("%s: the run stops and says the file WAS replaced but could not be confirmed — never 'left as it was'; it is counted as re-encrypted", async (_name, answer, why) => {
      for (const [rel, plain] of OLD_FILES) putEnc(rel, OLD, plain);
      const current = getFieldKeys();
      const target = path.join(root, "images/a.jpg"); // the first file the walk reaches

      const spy = tamperReadBack(target, answer);
      let thrown: unknown;
      try {
        await run();
      } catch (e) {
        thrown = e;
      } finally {
        spy.mockRestore();
      }

      expect(thrown).toBeInstanceOf(ReencryptError);
      const err = thrown as ReencryptError;
      expect(err.message).toMatch(/^images\/a\.jpg was replaced with its re-encrypted copy, but it could not be confirmed: reading it back failed \(/);
      expect(err.message).toMatch(why);
      expect(err.message).toContain("Check this file once BlackVault runs; if it does not open, put it back from your copy of the uploads folder or from a backup.");
      expect(err.message).toContain("The run stopped here, after 1 file (this one included).");
      expect(err.message).not.toContain("left as it was");
      expect(err.message).not.toMatch(/Every file is whole/); // only "Every OTHER file"
      // Counted as what is on disk: replaced. Not `failed` (that means "left untouched").
      expect(err.counts).toEqual({ reencrypted: 1, alreadyCurrent: 0, unknownKey: 0, notEncrypted: 0, failed: 0, stopped: 1 });
      expect(summaryLine({ outcome: "failed", counts: err.counts })).toBe("BLACKVAULT_REENCRYPT_FAILED reencrypted=1 already_current=0 unknown_key=0 not_encrypted=0 failed=0 stopped=1");
      // On disk: that file really is the new one; the files after it were not reached.
      expect(idOf("images/a.jpg")).toBe(current.id);
      expect(idOf("images/sub/b.jpg")).toBe(OLD.id);
      expect(idOf("documents/d.pdf")).toBe(OLD.id);
      // A re-run continues with the rest and skips the replaced one.
      const again = await run();
      expect(again.outcome).toBe("ok");
      expect(again.counts).toEqual({ reencrypted: 3, alreadyCurrent: 1, unknownKey: 0, notEncrypted: 0, failed: 0, stopped: 0 });
    });
  });

  it("the in-memory check BEFORE the write: bytes that do not decrypt back to the original are never installed — the run stops and the file is untouched", async () => {
    for (const [rel, plain] of OLD_FILES) putEnc(rel, OLD, plain);
    const before = snapshot();
    const open = vi.spyOn(fsp, "open");

    core.badEncrypt = true;
    let thrown: unknown;
    try {
      await run();
    } catch (e) {
      thrown = e;
    } finally {
      core.badEncrypt = false;
    }

    expect(thrown).toBeInstanceOf(ReencryptError);
    const err = thrown as ReencryptError;
    expect(err.message).toMatch(/^Could not re-encrypt images\/a\.jpg \(round-trip check failed\); it was left as it was\./);
    expect(err.counts).toEqual({ reencrypted: 0, alreadyCurrent: 0, unknownKey: 0, notEncrypted: 0, failed: 1, stopped: 1 });
    expect(snapshot()).toEqual(before); // nothing written, not even a temp file
    expect(open.mock.calls.filter((c) => String(c[1] ?? "r").includes("w"))).toEqual([]); // no file was opened for writing
  });

  it("afterwards the app's startup accepts the folder (it refused it before); a file under a third key still makes it refuse", async () => {
    for (const [rel, plain] of OLD_FILES) putEnc(rel, OLD, plain);
    putEnc("images/cur.jpg", getFieldKeys(), P.cur);
    const env = { IMAGE_UPLOAD_DIR: root } as unknown as NodeJS.ProcessEnv;
    const start = () => within(30_000, runFileStartup(raw, { cwd: work, env }));

    await expect(start()).rejects.toBeInstanceOf(FileStartupError); // premise: the copied folder is refused

    expect((await run()).outcome).toBe("ok");
    const result = await start();
    expect(result.counts).toEqual({ images: 0, documents: 0 }); // nothing left for startup to encrypt
    for (const [rel, plain] of OLD_FILES) expect(plainOf(rel, getFieldKeys()).equals(plain), rel).toBe(true);

    putEnc("images/third.jpg", THIRD, P.third);
    expect((await run()).outcome).toBe("nothing");
    await expect(start()).rejects.toThrow(/third\.jpg is encrypted with key/);
  });
});
