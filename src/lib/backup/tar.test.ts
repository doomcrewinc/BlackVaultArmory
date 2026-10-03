import { describe, it, expect, afterAll } from "vitest";
import { Readable, Writable } from "node:stream";
import { createReadStream, createWriteStream, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { TarWriter, readTar } from "./tar";

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

function strField(value: string, len: number): Buffer {
  const buf = Buffer.alloc(len, 0);
  buf.write(value, 0, Math.min(Buffer.byteLength(value, "ascii"), len), "ascii");
  return buf;
}

function rawChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
  return sum;
}

function rawHeader(opts: { name: string; prefix?: string; size: number; typeflag: string; corruptChecksum?: boolean }): Buffer {
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

    await writer.addBuffer("manifest.json", Buffer.from('{"ok":true}'));
    await writer.addFile("files/documents/empty.txt", 0, Readable.from(Buffer.alloc(0)));
    await writer.addFile(longPath, big.length, Readable.from(big));
    await writer.addBuffer("files/images/a/b/c/nested.bin", Buffer.from("nested-content"));
    await writer.finish();

    const archive = buffer();
    const seen: { path: string; size: number; sha: string }[] = [];
    await readTar(Readable.from(archive), async (p, size, body) => {
      const content = await drain(body);
      expect(content.length).toBe(size);
      seen.push({ path: p, size, sha: sha256(content) });
    });

    expect(seen.map((e) => e.path)).toEqual([
      "manifest.json",
      "files/documents/empty.txt",
      longPath,
      "files/images/a/b/c/nested.bin",
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
    execFileSync("tar", ["--format", "ustar", "-cf", archivePath, "-C", root, "."], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });

    const files = new Map<string, string>();
    await readTar(createReadStream(archivePath), async (p, _size, body) => {
      files.set(p, (await drain(body)).toString("utf8"));
    });

    expect(files.get("./top.txt")).toBe("top-level");
    expect(files.get("./sub/mid.txt")).toBe("mid-level");
    expect(files.get("./sub/deeper/low.txt")).toBe("deep-level");
    // Only the three regular files — every directory entry ('.', './sub',
    // './sub/deeper') was skipped, not handed to onEntry.
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

    await writer.addBuffer("manifest.json", Buffer.from('{"formatVersion":1}'));
    await writer.addBuffer(longPath, Buffer.from("content of the long-path file"));
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
