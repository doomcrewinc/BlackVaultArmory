import { describe, it, expect, afterAll } from "vitest";
import { PassThrough, Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { TarWriter, readTar } from "./tar";
import { createBackupSealer, createBackupOpener } from "../encryption/core.mjs";

/** A Writable that collects every chunk, for building an archive entirely in memory. */
function memorySink(): { writable: Writable; buffer: () => Buffer } {
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk as Buffer);
      cb();
    },
  });
  return { writable, buffer: () => Buffer.concat(chunks) };
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * An independent, minimal ustar header builder — deliberately NOT sharing any
 * code with src/lib/backup/tar.ts. It exists only to build headers the real
 * TarWriter would never produce (bad paths, a corrupt checksum), so the
 * reader's validation is tested against bytes it did not create itself.
 */
const BLOCK = 512;

function octalField(value: number, len: number): Buffer {
  const buf = Buffer.alloc(len, 0);
  buf.write(value.toString(8).padStart(len - 1, "0"), 0, len - 1, "ascii");
  return buf;
}

function strField(value: string | Buffer, len: number): Buffer {
  const buf = Buffer.alloc(len, 0);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  bytes.copy(buf, 0, 0, Math.min(bytes.length, len));
  return buf;
}

function rawChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum;
}

function rawHeader(opts: { name: string | Buffer; prefix?: string; size: number; typeflag: string; corruptChecksum?: boolean }): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  strField(opts.name, 100).copy(header, 0);
  octalField(0o644, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  octalField(opts.size, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136);
  header.write(opts.typeflag, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  strField(opts.prefix ?? "", 155).copy(header, 345);
  const sum = rawChecksum(header);
  const stored = opts.corruptChecksum ? sum + 1 : sum;
  header.write(`${stored.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

function padFor(size: number): Buffer {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem, 0);
}

function endMarker(): Buffer {
  return Buffer.alloc(BLOCK * 2, 0);
}

describe("TarWriter / readTar round trip", () => {
  it("round-trips nested paths, a >100-char path (ustar prefix), an empty file, and a 25 MB file", async () => {
    const { writable, buffer } = memorySink();
    const writer = new TarWriter(writable);

    const longPath = `files/images/${"d".repeat(50)}/${"e".repeat(90)}.jpg`;
    expect(longPath.length).toBeGreaterThan(100);

    const big = Buffer.alloc(25 * 1024 * 1024);
    // Deterministic, non-zero content so it can't be mistaken for an
    // all-zero end-of-archive block and so corruption would be detectable.
    for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) % 256;
    const bigSha = sha256(big);

    // Entry order follows the controller ruling: db.json, files/..., then
    // manifest.json last.
    await writer.addBuffer("db.json", Buffer.from('{"rows":[]}'));
    await writer.addFile("files/documents/empty.txt", 0, Readable.from(Buffer.alloc(0)));
    await writer.addFile(longPath, big.length, Readable.from(big));
    await writer.addBuffer("files/images/a/b/c/nested.bin", Buffer.from("nested-content"));
    await writer.addBuffer("manifest.json", Buffer.from('{"ok":true}'));
    await writer.finish();

    const archive = buffer();
    const seen: { path: string; size: number; sha: string }[] = [];
    await readTar(Readable.from(archive), async (p, size, body) => {
      const content = await drain(body);
      expect(content.length).toBe(size);
      seen.push({ path: p, size, sha: sha256(content) });
    });

    expect(seen.map((e) => e.path)).toEqual([
      "db.json",
      "files/documents/empty.txt",
      longPath,
      "files/images/a/b/c/nested.bin",
      "manifest.json",
    ]);
    expect(seen[1].size).toBe(0);
    const bigEntry = seen.find((e) => e.path === longPath);
    expect(bigEntry?.size).toBe(big.length);
    expect(bigEntry?.sha).toBe(bigSha);
  });

  it("rejects a file over the ustar size limit", async () => {
    const { writable } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addFile("huge.bin", 8589934592, Readable.from(Buffer.alloc(0)))).rejects.toThrow(/ustar limit|8589934591/);
  });

  it("throws, and never pads silently, when the source produces fewer bytes than declared", async () => {
    const { writable } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addFile("short.bin", 10, Readable.from(Buffer.from("abc")))).rejects.toThrow(/declared 10 bytes but the source produced 3/);
  });
});

describe("readTar rejects unsafe paths", () => {
  it("rejects a '..' path segment", async () => {
    const archive = Buffer.concat([rawHeader({ name: "../evil.txt", size: 5, typeflag: "0" }), Buffer.from("hello"), padFor(5), endMarker()]);
    await expect(readTar(Readable.from(archive), async () => {})).rejects.toThrow(/\.\./);
  });

  it("rejects an absolute path", async () => {
    const archive = Buffer.concat([rawHeader({ name: "/etc/passwd", size: 0, typeflag: "0" }), endMarker()]);
    await expect(readTar(Readable.from(archive), async () => {})).rejects.toThrow(/absolute/);
  });
});

describe("readTar header validation", () => {
  it("rejects a corrupt header checksum", async () => {
    const { writable, buffer } = memorySink();
    const writer = new TarWriter(writable);
    await writer.addBuffer("a.txt", Buffer.from("hi"));
    await writer.finish();

    const archive = buffer();
    // Flip the first byte of the name field without touching the stored
    // checksum (bytes 148..156), so the stored and recomputed checksums
    // disagree.
    archive[0] = archive[0] ^ 0xff;

    await expect(readTar(Readable.from(archive), async () => {})).rejects.toThrow(/checksum/i);
  });
});

describe("readTar on a tar built by the system tar CLI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bv-tar-cli-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("skips directory entries and delivers every regular file", async () => {
    const root = path.join(dir, "skip-src");
    mkdirSync(path.join(root, "sub", "deeper"), { recursive: true });
    writeFileSync(path.join(root, "top.txt"), "top-level");
    writeFileSync(path.join(root, "sub", "mid.txt"), "mid-level");
    writeFileSync(path.join(root, "sub", "deeper", "low.txt"), "deep-level");

    const archivePath = path.join(dir, "dirs.tar");
    // Members are named explicitly (not ".") because the reader rejects "."
    // path segments; bsdtar still emits the "sub/" and "sub/deeper/"
    // directory entries, with their trailing slash.
    execFileSync("tar", ["--format", "ustar", "-cf", archivePath, "-C", root, "top.txt", "sub"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    expect(execFileSync("tar", ["-tf", archivePath], { encoding: "utf8" })).toContain("sub/deeper/\n");

    const files = new Map<string, string>();
    await readTar(createReadStream(archivePath), async (p, _size, body) => {
      files.set(p, (await drain(body)).toString("utf8"));
    });

    expect(files.get("top.txt")).toBe("top-level");
    expect(files.get("sub/mid.txt")).toBe("mid-level");
    expect(files.get("sub/deeper/low.txt")).toBe("deep-level");
    // Only the three regular files — the directory entries ('sub/',
    // 'sub/deeper/') were skipped, not handed to onEntry.
    expect(files.size).toBe(3);
  });

  it("rejects a symlink entry with a clear error", async () => {
    const root = path.join(dir, "symlink-src");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "target.txt"), "target");
    symlinkSync("target.txt", path.join(root, "link.txt"));

    const archivePath = path.join(dir, "symlink.tar");
    execFileSync("tar", ["--format", "ustar", "-cf", archivePath, "-C", root, "link.txt"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    await expect(readTar(createReadStream(archivePath), async () => {})).rejects.toThrow(/unsupported entry type/i);
  });
});

describe("TarWriter output is real ustar, verified against the system tar CLI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bv-tar-interop-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("tar -tvf lists every entry and tar -xOf extracts matching bytes", async () => {
    const archivePath = path.join(dir, "ours.tar");
    const out = createWriteStream(archivePath);
    const writer = new TarWriter(out);

    const longPath = `files/documents/${"sub-".repeat(20)}deep/${"name-".repeat(15)}final.pdf`;
    expect(longPath.length).toBeGreaterThan(100);

    await writer.addBuffer(longPath, Buffer.from("content of the long-path file"));
    await writer.addBuffer("manifest.json", Buffer.from('{"formatVersion":1}'));
    await writer.finish();
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });

    const listing = execFileSync("tar", ["-tvf", archivePath], { encoding: "utf8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain(longPath);

    const extracted = execFileSync("tar", ["-xOf", archivePath, longPath]);
    expect(extracted.toString("utf8")).toBe("content of the long-path file");
  });
});

// ---------------------------------------------------------------------------
// Fix round 1 (review C1, I1–I4, M1–M4).
// ---------------------------------------------------------------------------

/**
 * Races `p` against a deadline so a regression that hangs fails by an
 * explicit assertion ("deadline exceeded"), well inside vitest's 5 s test
 * timeout, instead of by the timeout itself. The timer is unref'd so it never
 * keeps the worker alive.
 */
function withDeadline<T>(p: Promise<T>, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline exceeded (${ms} ms)`)), ms);
    timer.unref();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Deterministic PRNG (mulberry32), so a failing chunking is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Feeds `buf` into a PassThrough in random-sized pieces (1..maxPiece bytes)
 * with a setImmediate between writes, so the reader sees many small chunks
 * that arrive asynchronously — the shape of the BVB1 opener and of
 * fs.createReadStream, which the single-chunk `Readable.from(buffer)` used by
 * the original tests never exercised.
 */
function asyncChunked(buf: Buffer, seed: number, maxPiece = 70_000): PassThrough {
  const out = new PassThrough();
  const rand = prng(seed);
  let offset = 0;
  const step = () => {
    if (offset >= buf.length) {
      out.end();
      return;
    }
    const n = Math.min(buf.length - offset, 1 + Math.floor(rand() * maxPiece));
    out.write(buf.subarray(offset, offset + n));
    offset += n;
    setImmediate(step);
  };
  setImmediate(step);
  return out;
}

function patterned(size: number, seed: number): Buffer {
  const buf = Buffer.alloc(size);
  const rand = prng(seed);
  for (let i = 0; i < size; i += 251) buf[i] = 1 + Math.floor(rand() * 255);
  return buf;
}

async function buildArchive(entries: Array<[string, Buffer]>): Promise<Buffer> {
  const { writable, buffer } = memorySink();
  const writer = new TarWriter(writable);
  for (const [p, content] of entries) await writer.addBuffer(p, content);
  await writer.finish();
  return buffer();
}

async function readAll(input: Readable): Promise<Map<string, Buffer>> {
  const seen = new Map<string, Buffer>();
  await readTar(input, async (p, size, body) => {
    const content = await drain(body);
    expect(content.length).toBe(size);
    seen.set(p, content);
  });
  return seen;
}

function sampleEntries(): Array<[string, Buffer]> {
  return [
    ["db.json", Buffer.from('{"rows":[1,2,3]}')],
    ["files/images/big.bin", patterned(1_500_001, 1)],
    ["files/images/empty.bin", Buffer.alloc(0)],
    ["files/documents/mid.pdf", patterned(700_123, 2)],
    ["files/documents/exact.bin", patterned(1024, 3)],
    ["manifest.json", Buffer.from('{"formatVersion":1}')],
  ];
}

function expectSameEntries(seen: Map<string, Buffer>, entries: Array<[string, Buffer]>): void {
  expect([...seen.keys()]).toEqual(entries.map(([p]) => p));
  for (const [p, content] of entries) expect(sha256(seen.get(p) as Buffer)).toBe(sha256(content));
}

describe("readTar handles any input chunking (review C1)", () => {
  it("reads an archive fed through an async PassThrough in random-sized chunks", async () => {
    const entries = sampleEntries();
    const archive = await buildArchive(entries);
    for (const seed of [11, 22, 33]) {
      const seen = await withDeadline(readAll(asyncChunked(archive, seed)));
      expectSameEntries(seen, entries);
    }
  });

  it("reads an archive delivered one byte at a time", async () => {
    const entries: Array<[string, Buffer]> = [
      ["db.json", Buffer.from("{}")],
      ["files/images/x.bin", patterned(1500, 4)],
      ["manifest.json", Buffer.from('{"v":1}')],
    ];
    const archive = await buildArchive(entries);
    const seen = await withDeadline(readAll(asyncChunked(archive, 5, 1)));
    expectSameEntries(seen, entries);
  });

  it("reads an archive via fs.createReadStream with small and default chunk sizes", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bv-tar-fs-"));
    try {
      const entries = sampleEntries();
      const file = path.join(dir, "a.tar");
      writeFileSync(file, await buildArchive(entries));
      for (const highWaterMark of [1000, 16384, 65536]) {
        const seen = await withDeadline(readAll(createReadStream(file, { highWaterMark })));
        expectSameEntries(seen, entries);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readTar through the real BVB1 sealer and opener", () => {
  const passphrase = "correct horse battery staple";

  async function sealToFile(file: string, write: (writer: TarWriter) => Promise<void>, trailer?: Buffer): Promise<void> {
    const plain = new PassThrough();
    const sealed = pipeline(plain, createBackupSealer(passphrase), createWriteStream(file));
    const writer = new TarWriter(plain);
    await write(writer);
    await writer.finish();
    plain.end(trailer);
    await sealed;
  }

  function openFile(file: string): Readable {
    const opener = createBackupOpener(passphrase);
    const src = createReadStream(file);
    src.on("error", (err) => opener.destroy(err));
    return src.pipe(opener);
  }

  it("round-trips more than 2 MiB of plaintext, including a file over 1 MiB", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bv-tar-bvb-"));
    try {
      const entries = sampleEntries();
      const total = entries.reduce((n, [, b]) => n + b.length, 0);
      expect(total).toBeGreaterThan(2 * 1024 * 1024);
      expect(entries.some(([, b]) => b.length > 1024 * 1024)).toBe(true);

      const file = path.join(dir, "a.bvb");
      await sealToFile(file, async (w) => {
        for (const [p, content] of entries) await w.addBuffer(p, content);
      });
      const seen = await withDeadline(readAll(openFile(file)), 4000);
      expectSameEntries(seen, entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not resolve before the opener ends: a backup missing its final chunk rejects", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bv-tar-bvb-"));
    try {
      // The opener withholds each 1 MiB chunk until it knows whether it is the
      // last one, and checks for a proper final chunk only at its end. So:
      // a tar of exactly 2 MiB (end marker included), then 1 MiB of zero
      // record padding, 3 MiB of plaintext in all; the sealer adds a
      // zero-length final chunk (just its 16-byte tag). Cutting that tag
      // leaves the opener emitting the complete tar and then failing at its
      // end ("damaged or incomplete"). readTar must read the input to its end
      // and surface that error, not resolve after the end marker.
      const chunk = 1024 * 1024;
      const dbJson = Buffer.from("{}");
      const used = 512 + 512 + 512 + 1024; // db.json header + padded body, big header, end marker
      const bigSize = 2 * chunk - used;
      expect(bigSize % 512).toBe(0);
      const file = path.join(dir, "cut.bvb");
      await sealToFile(file, async (w) => {
        await w.addBuffer("db.json", dbJson);
        await w.addBuffer("files/images/big.bin", patterned(bigSize, 9));
      }, Buffer.alloc(chunk, 0));
      // Sanity: the uncut file reads cleanly.
      const ok = await withDeadline(readAll(openFile(file)), 4000);
      expect([...ok.keys()]).toEqual(["db.json", "files/images/big.bin"]);
      truncateSync(file, statSync(file).size - 16);

      const seen: string[] = [];
      await expect(
        withDeadline(
          readTar(openFile(file), async (p, _size, body) => {
            await drain(body);
            seen.push(p);
          }),
          4000,
        ),
      ).rejects.toThrow(/damaged or incomplete/);
      expect(seen).toEqual(["db.json", "files/images/big.bin"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readTar rejects truncated archives (review C1)", () => {
  it("rejects a truncated body from a single-chunk source", async () => {
    const archive = Buffer.concat([rawHeader({ name: "a.bin", size: 2000, typeflag: "0" }), Buffer.alloc(700, 7)]);
    await expect(withDeadline(readTar(Readable.from(archive), async (_p, _s, body) => void (await drain(body))))).rejects.toThrow(
      /unexpected end of archive/,
    );
  });

  it("rejects a truncated body from an async multi-chunk source", async () => {
    const full = await buildArchive([["files/images/a.bin", patterned(300_000, 6)]]);
    const cut = full.subarray(0, 512 + 150_000);
    await expect(withDeadline(readAll(asyncChunked(cut, 7, 4000)))).rejects.toThrow(/unexpected end of archive/);
  });

  it("rejects a truncated body even when onEntry does not read it", async () => {
    const archive = Buffer.concat([rawHeader({ name: "a.bin", size: 2000, typeflag: "0" }), Buffer.alloc(700, 7)]);
    await expect(withDeadline(readTar(asyncChunked(archive, 8, 100), async () => {}))).rejects.toThrow(/unexpected end of archive/);
  });

  it("rejects an archive cut inside a header", async () => {
    const full = await buildArchive([["a.txt", Buffer.from("hi")]]);
    await expect(withDeadline(readAll(asyncChunked(full.subarray(0, 300), 9, 50)))).rejects.toThrow(/unexpected end of archive/);
  });

  it("rejects an archive with no end-of-archive marker", async () => {
    const full = await buildArchive([["a.txt", Buffer.from("hi")]]);
    await expect(withDeadline(readAll(Readable.from(full.subarray(0, 1024))))).rejects.toThrow(/unexpected end of archive/);
  });

  it("rejects an archive with only one of the two end zero blocks", async () => {
    const full = await buildArchive([["a.txt", Buffer.from("hi")]]);
    await expect(withDeadline(readAll(Readable.from(full.subarray(0, 1024 + 512))))).rejects.toThrow(/unexpected end of archive/);
  });

  it("propagates an input stream error", async () => {
    const input = new PassThrough();
    const p = withDeadline(readAll(input));
    input.write(rawHeader({ name: "a.bin", size: 2000, typeflag: "0" }));
    setImmediate(() => input.destroy(new Error("disk on fire")));
    await expect(p).rejects.toThrow(/disk on fire/);
  });
});

describe("readTar end-of-archive handling (review I2)", () => {
  it("rejects a single zero block followed by another entry", async () => {
    const archive = Buffer.concat([
      rawHeader({ name: "a.txt", size: 2, typeflag: "0" }),
      Buffer.from("hi"),
      padFor(2),
      Buffer.alloc(BLOCK, 0),
      rawHeader({ name: "b.txt", size: 2, typeflag: "0" }),
      Buffer.from("yo"),
      padFor(2),
      endMarker(),
    ]);
    await expect(withDeadline(readAll(Readable.from(archive)))).rejects.toThrow(/end-of-archive/);
  });

  it("rejects non-zero garbage after the two zero blocks", async () => {
    const archive = Buffer.concat([await buildArchive([["a.txt", Buffer.from("hi")]]), Buffer.alloc(4096, 0x41)]);
    await expect(withDeadline(readAll(Readable.from(archive)))).rejects.toThrow(/trailing/);
  });

  it("rejects a single non-zero byte far into the trailing zero padding", async () => {
    const tail = Buffer.alloc(10_240, 0);
    tail[9_000] = 1;
    const archive = Buffer.concat([await buildArchive([["a.txt", Buffer.from("hi")]]), tail]);
    await expect(withDeadline(readAll(asyncChunked(archive, 10, 700)))).rejects.toThrow(/trailing/);
  });

  it("accepts all-zero record padding after the two zero blocks (as bsdtar writes)", async () => {
    const archive = Buffer.concat([await buildArchive([["a.txt", Buffer.from("hi")]]), Buffer.alloc(9_216, 0)]);
    const seen = await withDeadline(readAll(asyncChunked(archive, 12, 700)));
    expect([...seen.keys()]).toEqual(["a.txt"]);
  });
});

describe("readTar when onEntry does not consume the body (review I1)", () => {
  // Chosen behaviour: after onEntry settles, readTar skips (drains) whatever
  // the callback left unread and carries on with the next entry.
  it("skips an unread non-empty body and delivers the next entry intact", async () => {
    const second = patterned(200_000, 13);
    const archive = await buildArchive([
      ["files/images/skip.bin", patterned(300_000, 14)],
      ["files/images/keep.bin", second],
    ]);
    const seen = new Map<string, Buffer>();
    await withDeadline(
      readTar(asyncChunked(archive, 15, 9000), async (p, _size, body) => {
        if (p.endsWith("skip.bin")) return;
        seen.set(p, await drain(body));
      }),
    );
    expect([...seen.keys()]).toEqual(["files/images/keep.bin"]);
    expect(sha256(seen.get("files/images/keep.bin") as Buffer)).toBe(sha256(second));
  });

  it("skips an unread empty body", async () => {
    const archive = await buildArchive([
      ["files/images/empty.bin", Buffer.alloc(0)],
      ["files/images/next.bin", Buffer.from("next")],
    ]);
    const paths: string[] = [];
    await withDeadline(
      readTar(Readable.from(archive), async (p, _size, body) => {
        paths.push(p);
        if (p.endsWith("next.bin")) expect((await drain(body)).toString()).toBe("next");
      }),
    );
    expect(paths).toEqual(["files/images/empty.bin", "files/images/next.bin"]);
  });

  it("skips the rest of a body that onEntry partly read and then destroyed", async () => {
    const second = patterned(100_000, 16);
    const archive = await buildArchive([
      ["files/images/partial.bin", patterned(500_000, 17)],
      ["files/images/after.bin", second],
    ]);
    let after: Buffer | undefined;
    await withDeadline(
      readTar(asyncChunked(archive, 18, 5000), async (p, _size, body) => {
        if (p.endsWith("partial.bin")) {
          // Read one chunk, then leave the loop — which destroys the body.
          for await (const chunk of body as AsyncIterable<Buffer>) {
            expect(chunk.length).toBeGreaterThan(0);
            break;
          }
          expect(body.destroyed).toBe(true);
          return;
        }
        after = await drain(body);
      }),
    );
    expect(sha256(after as Buffer)).toBe(sha256(second));
  });

  it("rejects with onEntry's own error and does not hang", async () => {
    const archive = await buildArchive([["a.bin", patterned(200_000, 19)]]);
    await expect(
      withDeadline(
        readTar(asyncChunked(archive, 20, 3000), async () => {
          throw new Error("consumer failed");
        }),
      ),
    ).rejects.toThrow(/consumer failed/);
  });
});

describe("readTar entry validation (review M1, M3, M4)", () => {
  async function rejectsName(name: string | Buffer, prefix?: string, typeflag = "0"): Promise<void> {
    const archive = Buffer.concat([rawHeader({ name, prefix, size: 0, typeflag }), endMarker()]);
    await expect(withDeadline(readTar(Readable.from(archive), async () => {}))).rejects.toThrow(/^tar: /);
  }

  it.each([
    ["./a", /"\." path segment/],
    ["a/./b", /"\." path segment/],
    [".", /"\." path segment/],
    ["a//b", /empty path segment/],
    ["a/", /empty path segment/],
    ["..\\..\\evil", /backslash/],
    ["a\\b", /backslash/],
  ])("rejects the file entry path %j", async (name, message) => {
    const archive = Buffer.concat([rawHeader({ name, size: 0, typeflag: "0" }), endMarker()]);
    await expect(withDeadline(readTar(Readable.from(archive), async () => {}))).rejects.toThrow(message);
  });

  it("rejects a prefix with an empty name (decodes to a trailing slash)", async () => {
    const archive = Buffer.concat([rawHeader({ name: "", prefix: "a", size: 0, typeflag: "0" }), endMarker()]);
    await expect(withDeadline(readTar(Readable.from(archive), async () => {}))).rejects.toThrow(/empty path segment/);
  });

  it("rejects '..' and absolute paths by assertion, without needing a body to be read", async () => {
    await rejectsName("a/../../x");
    await rejectsName("x", "/abs");
  });

  it("rejects names that are not valid UTF-8", async () => {
    const archive = Buffer.concat([rawHeader({ name: Buffer.from([0x61, 0xff]), size: 0, typeflag: "0" }), endMarker()]);
    await expect(withDeadline(readTar(Readable.from(archive), async () => {}))).rejects.toThrow(/UTF-8/);
    const inPrefix = Buffer.concat([rawHeader({ name: "b", prefix: "\u00e9x", size: 0, typeflag: "0" }), endMarker()]);
    // A valid two-byte UTF-8 prefix is accepted...
    const paths: string[] = [];
    await withDeadline(readTar(Readable.from(inPrefix), async (p) => void paths.push(p)));
    expect(paths).toEqual(["éx/b"]);
  });

  it("rejects a directory entry with a '.' segment", async () => {
    await rejectsName("./", undefined, "5");
  });

  it("rejects a directory entry whose size is above 0", async () => {
    const archive = Buffer.concat([rawHeader({ name: "d/", size: 1024, typeflag: "5" }), Buffer.alloc(1024, 0), endMarker()]);
    await expect(withDeadline(readTar(Readable.from(archive), async () => {}))).rejects.toThrow(/directory entry .* size/);
  });

  it("rejects duplicate entry names", async () => {
    const archive = Buffer.concat([
      rawHeader({ name: "a.txt", size: 2, typeflag: "0" }),
      Buffer.from("hi"),
      padFor(2),
      rawHeader({ name: "a.txt", size: 2, typeflag: "0" }),
      Buffer.from("yo"),
      padFor(2),
      endMarker(),
    ]);
    const seen: string[] = [];
    await expect(
      withDeadline(
        readTar(Readable.from(archive), async (p, _s, body) => {
          await drain(body);
          seen.push(p);
        }),
      ),
    ).rejects.toThrow(/duplicate entry/);
    expect(seen).toEqual(["a.txt"]);
  });

  it("rejects a file entry that duplicates a directory entry's name", async () => {
    const archive = Buffer.concat([rawHeader({ name: "d/", size: 0, typeflag: "5" }), rawHeader({ name: "d", size: 0, typeflag: "0" }), endMarker()]);
    await expect(withDeadline(readTar(Readable.from(archive), async () => {}))).rejects.toThrow(/duplicate entry/);
  });
});

describe("TarWriter failure handling (review I3, M2)", () => {
  it("rejects a source longer than declared as soon as it overruns, without waiting for the source to end", async () => {
    const { writable, buffer } = memorySink();
    const writer = new TarWriter(writable);
    const source = new PassThrough();
    source.write(Buffer.from("abcdef")); // 6 bytes against a declared 2; the source never ends
    await expect(withDeadline(writer.addFile("long.bin", 2, source))).rejects.toThrow(/more than the declared 2 bytes/);
    // Only the header reached the output: the overrunning chunk was not written.
    expect(buffer().length).toBe(512);
    expect(source.destroyed).toBe(true);
  });

  it("rejects an overrun detected on a later chunk", async () => {
    const { writable } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addFile("long.bin", 1000, Readable.from([Buffer.alloc(600, 1), Buffer.alloc(600, 2)]))).rejects.toThrow(
      /more than the declared 1000 bytes/,
    );
  });

  it("enters a failed state after a short source: later addFile, addBuffer and finish all reject", async () => {
    const { writable, buffer } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addFile("short.bin", 10, Readable.from(Buffer.from("abc")))).rejects.toThrow(/declared 10 bytes but the source produced 3/);
    const before = buffer().length;
    await expect(writer.addBuffer("next.bin", Buffer.from("x"))).rejects.toThrow(/failed state/);
    await expect(writer.addFile("next.bin", 0, Readable.from(Buffer.alloc(0)))).rejects.toThrow(/failed state/);
    await expect(writer.finish()).rejects.toThrow(/failed state/);
    expect(buffer().length).toBe(before);
  });

  it("enters a failed state after an overrun too", async () => {
    const { writable } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addFile("long.bin", 1, Readable.from(Buffer.from("ab")))).rejects.toThrow(/more than the declared/);
    await expect(writer.finish()).rejects.toThrow(/failed state/);
  });

  it.each(["", "../x", "a/../b", "/abs", "a//b", "./a", "a/./b", "a/", "a\\b"])("rejects the path %j on write", async (p) => {
    const { writable, buffer } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addBuffer(p, Buffer.from("x"))).rejects.toThrow(/^tar: /);
    expect(buffer().length).toBe(0);
  });

  it("rejects a non-integer size", async () => {
    const { writable } = memorySink();
    const writer = new TarWriter(writable);
    await expect(writer.addFile("a.bin", 1.5, Readable.from(Buffer.from("x")))).rejects.toThrow(/invalid size/);
  });
});
