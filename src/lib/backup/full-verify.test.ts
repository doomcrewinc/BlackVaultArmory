import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBackupSealer, SealError } from "@/lib/encryption/core.mjs";
import { buildManifest, MAX_MANIFEST_BYTES, type Manifest } from "./manifest";
import { TarWriter } from "./tar";
import { FullBackupVerifyError, verifyFullBackup } from "./full-verify";

/**
 * verifyFullBackup against HAND-BUILT archives. The BVB1 layer authenticates
 * every byte, so a flipped byte in the file is already rejected by the
 * opener — the only way to test verify's OWN checks (manifest vs contents)
 * is to seal a tar whose plaintext is internally inconsistent.
 */
const PASS = "correct horse battery staple";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const A = Buffer.from("alpha file contents");
const B = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a); // spans several 1 MiB chunks
const DB = { meta: { version: "1.1" }, firearms: [{ id: "f1" }, { id: "f2" }], accessories: [] };

type Entry = [path: string, body: Buffer | { declared: number; zeros: true }];

let dir: string;
let seq = 0;

async function seal(entries: Entry[], passphrase = PASS): Promise<string> {
  const file = path.join(dir, `t${++seq}.bvb`);
  const sealer = createBackupSealer(passphrase);
  const done = pipeline(sealer, createWriteStream(file));
  const tar = new TarWriter(sealer);
  for (const [name, body] of entries) {
    if (Buffer.isBuffer(body)) await tar.addBuffer(name, body);
    else {
      const block = Buffer.alloc(1024 * 1024);
      let left = body.declared;
      const zeros = new Readable({
        read() {
          if (left <= 0) return void this.push(null);
          const n = Math.min(left, block.length);
          left -= n;
          this.push(block.subarray(0, n));
        },
      });
      await tar.addFile(name, body.declared, zeros);
    }
  }
  await tar.finish();
  sealer.end();
  await done;
  return file;
}

function manifest(over: Partial<Parameters<typeof buildManifest>[0]> = {}): Manifest {
  return buildManifest({
    appVersion: "test",
    createdAt: new Date("2026-10-02T12:00:00.000Z"),
    keyIdAtBackup: "abcd1234",
    counts: { firearms: 2, accessories: 0 },
    files: [
      { path: "files/images/a.jpg", size: A.length, sha256: sha(A) },
      { path: "files/documents/sub/b.pdf", size: B.length, sha256: sha(B) },
    ],
    ...over,
  });
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const good = (m: Manifest = manifest()): Entry[] => [
  ["db.json", json(DB)],
  ["files/images/a.jpg", A],
  ["files/documents/sub/b.pdf", B],
  ["manifest.json", json(m)],
];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "bv-full-verify-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("verifyFullBackup", () => {
  it("accepts a consistent archive and reports file count, content bytes, archive size and the manifest", async () => {
    const file = await seal(good());
    const before = readdirSync(dir).sort();
    const result = await verifyFullBackup(file, PASS);
    expect(result.files).toBe(2);
    expect(result.bytes).toBe(A.length + B.length);
    expect(result.archiveBytes).toBe(statSync(file).size);
    expect(result.manifest.counts).toEqual({ firearms: 2, accessories: 0 });
    // Nothing is written to disk during verify.
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it("accepts an archive with no files at all (empty uploads folder)", async () => {
    const file = await seal([
      ["db.json", json(DB)],
      ["manifest.json", json(manifest({ files: [] }))],
    ]);
    await expect(verifyFullBackup(file, PASS)).resolves.toMatchObject({ files: 0, bytes: 0 });
  });

  it("CORRUPTION: a file whose bytes do not hash to the manifest's sha256 is rejected, naming the file", async () => {
    const tampered = Buffer.from(A);
    tampered[0] ^= 0xff; // same size, different contents
    const entries = good();
    entries[1] = ["files/images/a.jpg", tampered];
    const file = await seal(entries);
    const err = await verifyFullBackup(file, PASS).catch((e) => e);
    expect(err).toBeInstanceOf(FullBackupVerifyError);
    expect(err.message).toMatch(/files\/images\/a\.jpg/);
    expect(err.message).toMatch(/checksum/i);
  });

  it("CORRUPTION in a later 1 MiB chunk of a multi-chunk file is rejected too", async () => {
    const tampered = Buffer.from(B);
    tampered[tampered.length - 5] ^= 0x01;
    const entries = good();
    entries[2] = ["files/documents/sub/b.pdf", tampered];
    await expect(verifyFullBackup(await seal(entries), PASS)).rejects.toThrow(/files\/documents\/sub\/b\.pdf.*checksum/i);
  });

  it("a file whose size differs from the manifest is rejected", async () => {
    const m = manifest();
    m.files[0].size = A.length + 1;
    await expect(verifyFullBackup(await seal(good(m)), PASS)).rejects.toThrow(/files\/images\/a\.jpg.*size/i);
  });

  it("an extra file entry that the manifest does not list is rejected", async () => {
    const entries = good();
    entries.splice(3, 0, ["files/images/extra.jpg", Buffer.from("x")]);
    const err = await verifyFullBackup(await seal(entries), PASS).catch((e) => e);
    expect(err).toBeInstanceOf(FullBackupVerifyError);
    expect(err.message).toMatch(/files\/images\/extra\.jpg/);
    expect(err.message).toMatch(/not listed/i);
  });

  it("a file the manifest lists but the archive does not hold is rejected", async () => {
    const entries = good();
    entries.splice(1, 1);
    await expect(verifyFullBackup(await seal(entries), PASS)).rejects.toThrow(/files\/images\/a\.jpg.*missing/i);
  });

  it("an entry that is not db.json, manifest.json or under files/ is rejected", async () => {
    const entries = good();
    entries.splice(1, 0, ["notes.txt", Buffer.from("hi")]);
    await expect(verifyFullBackup(await seal(entries), PASS)).rejects.toThrow(/unexpected entry.*notes\.txt/i);
  });

  // Ruling R26: the restore refuses these names, so an archive holding one must not verify —
  // even when its manifest lists the file with the right size and checksum.
  it.each([
    ["a control character in a name", [["files/images/a\u0007b.jpg", A]]],
    ["two names differing only in case", [["files/images/A.jpg", A], ["files/images/a.jpg", A]]],
    ["two names differing only in Unicode normalisation", [["files/images/caf\u00e9.jpg", A], ["files/images/cafe\u0301.jpg", A]]],
    ["a file where another entry needs a folder", [["files/images/a", A], ["files/images/a/b.jpg", A]]],
    ["a hidden folder", [["files/images/.pre-restore-20260101-000000/x.jpg", A]]],
    ["a rotation work file", [["files/documents/x.pdf.rot", A]]],
  ] as Array<[string, Array<[string, Buffer]>]>)("R26: an archive holding %s is rejected, although its manifest matches", async (_name, files) => {
    const m = manifest({ files: files.map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })) });
    const file = await seal([["db.json", json(DB)], ...files, ["manifest.json", json(m)]]);
    const failure = await verifyFullBackup(file, PASS).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(FullBackupVerifyError);
    expect((failure as Error).message).toMatch(/cannot be restored: it (is|would be|.*contains)|cannot be restored: its name/);
    expect((failure as Error).message).not.toMatch(/[\u0000-\u001f]/); // the name is printed safely
  });

  it("an archive with no manifest.json is rejected", async () => {
    await expect(verifyFullBackup(await seal(good().slice(0, 3)), PASS)).rejects.toThrow(/manifest\.json/);
  });

  it("an archive with no db.json is rejected", async () => {
    await expect(verifyFullBackup(await seal(good().slice(1)), PASS)).rejects.toThrow(/db\.json/);
  });

  it("an entry after manifest.json is rejected (the manifest is the last entry)", async () => {
    const [db, a, b, m] = good();
    await expect(verifyFullBackup(await seal([db, a, m, b]), PASS)).rejects.toThrow(/last entry/i);
  });

  it("db.json that is not valid JSON, or whose row counts differ from manifest.counts, is rejected", async () => {
    const bad = good();
    bad[0] = ["db.json", Buffer.from("{ not json")];
    await expect(verifyFullBackup(await seal(bad), PASS)).rejects.toThrow(/db\.json/);

    const short = good();
    short[0] = ["db.json", json({ ...DB, firearms: [{ id: "f1" }] })];
    await expect(verifyFullBackup(await seal(short), PASS)).rejects.toThrow(/firearms/);

    const absent = good();
    absent[0] = ["db.json", json({ meta: DB.meta, firearms: DB.firearms })];
    await expect(verifyFullBackup(await seal(absent), PASS)).rejects.toThrow(/accessories/);
  });

  it("a manifest.json entry declared larger than MAX_MANIFEST_BYTES is rejected without being parsed", async () => {
    const entries = good().slice(0, 3);
    entries.push(["manifest.json", { declared: MAX_MANIFEST_BYTES + 1, zeros: true }]);
    await expect(verifyFullBackup(await seal(entries), PASS)).rejects.toThrow(/manifest\.json is too large/i);
  }, 60_000);

  it("a malformed manifest is rejected", async () => {
    const entries = good();
    entries[3] = ["manifest.json", json({ formatVersion: 99 })];
    await expect(verifyFullBackup(await seal(entries), PASS)).rejects.toThrow(/formatVersion/);
  });

  it("the wrong passphrase is rejected with the sealer's own error", async () => {
    const file = await seal(good());
    const err = await verifyFullBackup(file, "not the right passphrase").catch((e) => e);
    expect(err).toBeInstanceOf(SealError);
    expect(err.code).toBe("WRONG_PASSPHRASE_OR_DAMAGED");
  });

  it("a truncated archive and a flipped byte are rejected", async () => {
    const cut = await seal(good());
    truncateSync(cut, statSync(cut).size - 100);
    await expect(verifyFullBackup(cut, PASS)).rejects.toBeInstanceOf(SealError);

    const flipped = await seal(good());
    const bytes = readFileSync(flipped);
    bytes[bytes.length - 2_000_000] ^= 0x01;
    writeFileSync(flipped, bytes);
    await expect(verifyFullBackup(flipped, PASS)).rejects.toBeInstanceOf(SealError);
  });

  it("a file that does not exist is rejected with the fs error", async () => {
    await expect(verifyFullBackup(path.join(dir, "missing.bvb"), PASS)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports progress per verified file", async () => {
    const seen: Array<{ filesDone: number; bytesDone: number }> = [];
    await verifyFullBackup(await seal(good()), PASS, { onProgress: (p) => seen.push({ ...p }) });
    expect(seen.at(-1)).toEqual({ filesDone: 2, bytesDone: A.length + B.length });
  });
});
