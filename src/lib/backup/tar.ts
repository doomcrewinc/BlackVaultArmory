import { Readable, Writable } from "node:stream";

/**
 * A minimal POSIX ustar tar writer and reader, with no dependency beyond
 * node:stream.
 *
 * Why hand-rolled: the full backup's plaintext stream (manifest.json, db.json,
 * then every decrypted upload) is piped straight into the BVB1 sealer
 * (core.mjs's createBackupSealer). Pulling in a tar library would add a
 * dependency to a crypto-adjacent path for a format that is this small:
 * 512-byte headers, octal numeric fields, a checksum, and padding to 512.
 *
 * Scope, matching the spec (§1 "Plaintext stream") and the global
 * constraints:
 * - the writer only ever emits typeflag '0' (regular file) entries — no
 *   directories, symlinks or hardlinks;
 * - files over ~8 GiB (the largest size a plain 11-digit octal field can
 *   hold) are rejected rather than switched to a base-256 field, because the
 *   per-file cap elsewhere in the app is 20 MB;
 * - the reader accepts regular files and directories (real tar producers
 *   emit directory entries; we skip them) and rejects every other type
 *   (symlink, hardlink, device, fifo, pax extended header, ...) with a clear
 *   error, because the writer here never produces them and a backup must
 *   not silently drop content it doesn't understand.
 */

const BLOCK_SIZE = 512;
const NAME_LEN = 100;
const PREFIX_LEN = 155;
const LINKNAME_LEN = 100;
const UNAME_LEN = 32;
const GNAME_LEN = 32;

/** Largest value an 11-octal-digit field (12-byte field, 1 byte for the terminator) can hold. */
const MAX_USTAR_SIZE = 8 ** 11 - 1; // 8589934591 bytes, ~8 GiB minus 1 byte.

const TYPE_REGULAR = "0";
const TYPE_DIRECTORY = "5";

const USTAR_MAGIC = "ustar\0";
const USTAR_VERSION = "00";

/** Offsets within a 512-byte ustar header, per POSIX.1-1988. */
const FIELD = {
  name: 0,
  mode: 100,
  uid: 108,
  gid: 116,
  size: 124,
  mtime: 136,
  chksum: 148,
  typeflag: 156,
  linkname: 157,
  magic: 257,
  version: 263,
  uname: 265,
  gname: 297,
  devmajor: 329,
  devminor: 337,
  prefix: 345,
} as const;

function asciiByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Writes an ASCII/UTF-8 string into `len` bytes, NUL-padded. Throws if it doesn't fit (with room for no required terminator — callers that need one pass len - 1). */
function writeField(header: Buffer, offset: number, len: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > len) {
    throw new Error(`tar: field value "${value}" (${bytes.length} bytes) does not fit in ${len}-byte field`);
  }
  bytes.copy(header, offset);
}

/** Writes a zero-padded octal number followed by a NUL terminator, filling exactly `len` bytes. */
function writeOctalField(header: Buffer, offset: number, len: number, value: number): void {
  const octal = Math.trunc(value).toString(8);
  if (octal.length > len - 1) {
    throw new Error(`tar: value ${value} does not fit in a ${len}-byte octal field`);
  }
  const padded = octal.padStart(len - 1, "0");
  header.write(padded, offset, len - 1, "ascii");
  header[offset + len - 1] = 0;
}

/** Sum of every header byte, with the checksum field itself treated as eight ASCII spaces. */
function computeChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    sum += i >= FIELD.chksum && i < FIELD.chksum + 8 ? 0x20 : header[i];
  }
  return sum;
}

/**
 * Splits a path into ustar's `prefix` + `name` pair (joined on read as
 * `prefix + "/" + name`). Returns an empty prefix when the whole path
 * already fits in the 100-byte name field. Throws when no split keeps both
 * parts within their field widths — in particular when the final path
 * segment alone is longer than 100 bytes.
 */
function splitUstarPath(filePath: string): { prefix: string; name: string } {
  if (asciiByteLength(filePath) <= NAME_LEN) {
    return { prefix: "", name: filePath };
  }
  for (let i = filePath.length - 1; i >= 0; i--) {
    if (filePath[i] !== "/") continue;
    const prefix = filePath.slice(0, i);
    const name = filePath.slice(i + 1);
    if (asciiByteLength(name) <= NAME_LEN && asciiByteLength(prefix) <= PREFIX_LEN) {
      return { prefix, name };
    }
  }
  throw new Error(`tar: path too long for ustar format (no valid prefix/name split): ${filePath}`);
}

function buildHeader(opts: { name: string; prefix: string; size: number; typeflag: string; mtimeSec: number }): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  writeField(header, FIELD.name, NAME_LEN, opts.name);
  writeOctalField(header, FIELD.mode, 8, 0o644);
  writeOctalField(header, FIELD.uid, 8, 0);
  writeOctalField(header, FIELD.gid, 8, 0);
  writeOctalField(header, FIELD.size, 12, opts.size);
  writeOctalField(header, FIELD.mtime, 12, opts.mtimeSec);
  // chksum field is filled in below, after the rest of the header is written.
  header.write(opts.typeflag, FIELD.typeflag, 1, "ascii");
  writeField(header, FIELD.linkname, LINKNAME_LEN, "");
  header.write(USTAR_MAGIC, FIELD.magic, 6, "ascii");
  header.write(USTAR_VERSION, FIELD.version, 2, "ascii");
  writeField(header, FIELD.uname, UNAME_LEN, "");
  writeField(header, FIELD.gname, GNAME_LEN, "");
  writeOctalField(header, FIELD.devmajor, 8, 0);
  writeOctalField(header, FIELD.devminor, 8, 0);
  writeField(header, FIELD.prefix, PREFIX_LEN, opts.prefix);

  const checksum = computeChecksum(header);
  const chksumText = checksum.toString(8).padStart(6, "0");
  header.write(`${chksumText}\0 `, FIELD.chksum, 8, "ascii");
  return header;
}

function padLength(size: number): number {
  const remainder = size % BLOCK_SIZE;
  return remainder === 0 ? 0 : BLOCK_SIZE - remainder;
}

/** Writes `chunk` to `stream`, resolving once the write has been accepted (and awaiting drain if the stream asked for backpressure). */
function writeAsync(stream: Writable, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    stream.once("error", onError);
    const ok = stream.write(chunk, (err) => {
      stream.off("error", onError);
      if (err) {
        reject(err);
        return;
      }
      if (ok) resolve();
    });
    if (!ok) {
      stream.once("drain", () => {
        stream.off("error", onError);
        resolve();
      });
    }
  });
}

/**
 * Streams every chunk of `source` into `dest` (without ending it) and
 * returns the total byte count. Uses async iteration + an awaited write per
 * chunk, so at most one chunk is ever held at a time regardless of the
 * source's total size — the 25 MB round-trip test and the eventual 5–10 GB
 * backup both rely on this not buffering the whole input.
 */
async function pipeCounting(source: Readable, dest: Writable): Promise<number> {
  let total = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    total += chunk.length;
    await writeAsync(dest, chunk);
  }
  return total;
}

/**
 * Writes a ustar archive to `out`. Call `addFile`/`addBuffer` for each entry
 * in order, then `finish()` exactly once.
 */
export class TarWriter {
  private readonly out: Writable;
  private finished = false;

  constructor(out: Writable) {
    this.out = out;
  }

  /**
   * Streams `source` into the archive as `path`, declared as `size` bytes.
   * Never buffers the whole file: the source is piped directly into the
   * underlying stream. After the source ends, the actual byte count is
   * compared against `size` — a mismatch throws (never padded or truncated
   * silently), leaving the archive unusable, which is the caller's signal to
   * abort rather than ship a corrupt backup.
   */
  async addFile(path: string, size: number, source: Readable): Promise<void> {
    if (this.finished) throw new Error("tar: cannot add an entry after finish()");
    if (size < 0 || !Number.isFinite(size)) {
      throw new Error(`tar: invalid size ${size} for ${path}`);
    }
    if (size > MAX_USTAR_SIZE) {
      throw new Error(
        `tar: ${path} is ${size} bytes, over the ${MAX_USTAR_SIZE}-byte ustar limit (base-256 sizes are not supported; this app caps uploads well under that)`,
      );
    }
    const { prefix, name } = splitUstarPath(path);
    const header = buildHeader({
      name,
      prefix,
      size,
      typeflag: TYPE_REGULAR,
      mtimeSec: Math.floor(Date.now() / 1000),
    });
    await writeAsync(this.out, header);

    const written = await pipeCounting(source, this.out);
    if (written !== size) {
      throw new Error(`tar: ${path} declared ${size} bytes but the source produced ${written}`);
    }

    const pad = padLength(size);
    if (pad > 0) await writeAsync(this.out, Buffer.alloc(pad, 0));
  }

  /** Convenience wrapper over `addFile` for content already in memory. */
  async addBuffer(path: string, buf: Buffer): Promise<void> {
    await this.addFile(path, buf.length, Readable.from(buf, { objectMode: false }));
  }

  /** Writes the two terminating zero blocks. The writer must not be used afterwards. */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    await writeAsync(this.out, Buffer.alloc(BLOCK_SIZE * 2, 0));
  }
}

/** Reads a NUL-terminated (and NUL-padded) ASCII field. Throws if a non-NUL byte follows the terminator — a sign of a malformed or hostile header. */
function readCString(buf: Buffer, offset: number, len: number): string {
  const field = buf.subarray(offset, offset + len);
  const nul = field.indexOf(0);
  if (nul === -1) return field.toString("utf8");
  for (let i = nul + 1; i < field.length; i++) {
    if (field[i] !== 0) {
      throw new Error("tar: malformed header field (non-NUL byte after string terminator)");
    }
  }
  return field.subarray(0, nul).toString("utf8");
}

function readOctalField(buf: Buffer, offset: number, len: number): number {
  const field = buf.subarray(offset, offset + len);
  const nul = field.indexOf(0);
  const text = (nul === -1 ? field : field.subarray(0, nul)).toString("ascii").trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error("tar: malformed octal header field");
  }
  return parseInt(text, 8);
}

function isZeroBlock(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function validateEntryPath(path: string): void {
  if (path.length === 0) throw new Error("tar: empty entry path");
  if (path.includes("\0")) throw new Error(`tar: NUL byte in entry path`);
  if (path.startsWith("/")) throw new Error(`tar: absolute path in archive: ${path}`);
  for (const segment of path.split("/")) {
    if (segment === "..") throw new Error(`tar: ".." path segment in archive: ${path}`);
  }
}

interface ParsedHeader {
  path: string;
  size: number;
  typeflag: string;
}

function parseHeader(block: Buffer): ParsedHeader {
  const storedChecksum = readOctalField(block, FIELD.chksum, 8);
  const actualChecksum = computeChecksum(block);
  if (storedChecksum !== actualChecksum) {
    throw new Error(`tar: header checksum mismatch (stored ${storedChecksum}, computed ${actualChecksum})`);
  }

  const magic = block.subarray(FIELD.magic, FIELD.magic + 6).toString("ascii");
  if (magic !== USTAR_MAGIC) {
    throw new Error(`tar: not a ustar header (bad magic ${JSON.stringify(magic)})`);
  }

  const name = readCString(block, FIELD.name, NAME_LEN);
  const prefix = readCString(block, FIELD.prefix, PREFIX_LEN);
  const path = prefix.length > 0 ? `${prefix}/${name}` : name;
  const size = readOctalField(block, FIELD.size, 12);
  const typeflag = block.subarray(FIELD.typeflag, FIELD.typeflag + 1).toString("ascii") || TYPE_REGULAR;

  return { path, size, typeflag: typeflag === "\0" ? TYPE_REGULAR : typeflag };
}

/** Pull-based reader over a Node Readable: lets callers ask for exactly N bytes at a time without ever buffering more than requested. */
class BlockReader {
  private readonly input: Readable;
  private ended = false;

  constructor(input: Readable) {
    this.input = input;
  }

  async readExact(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let needed = n;
    while (needed > 0) {
      const chunk = this.input.read(needed) as Buffer | null;
      if (chunk && chunk.length > 0) {
        // `.read(n)` is only guaranteed to return AT MOST n bytes for a
        // stream in byte mode. Defend anyway (an object-mode or otherwise
        // unusual Readable can hand back more in one go): keep only what's
        // needed and push the rest back onto the stream for the next call,
        // rather than silently discarding it.
        if (chunk.length > needed) {
          chunks.push(chunk.subarray(0, needed));
          this.input.unshift(chunk.subarray(needed));
          needed = 0;
          continue;
        }
        chunks.push(chunk);
        needed -= chunk.length;
        continue;
      }
      if (this.ended) break;
      await this.waitForMore();
    }
    const result = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, n - needed);
    if (result.length < n) {
      throw new Error(`tar: unexpected end of archive (wanted ${n} bytes, got ${result.length})`);
    }
    return result;
  }

  private waitForMore(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        this.ended = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.input.off("readable", onReadable);
        this.input.off("end", onEnd);
        this.input.off("error", onError);
      };
      this.input.once("readable", onReadable);
      this.input.once("end", onEnd);
      this.input.once("error", onError);
    });
  }
}

const BODY_CHUNK = 64 * 1024;

/** The Readable handed to `onEntry`. Pulls from the shared BlockReader lazily, `BODY_CHUNK` bytes at a time, so a 20 MB entry is never buffered in full. */
class EntryBodyStream extends Readable {
  private remaining: number;
  private readonly reader: BlockReader;

  constructor(reader: BlockReader, size: number) {
    super();
    this.reader = reader;
    this.remaining = size;
  }

  override _read(): void {
    if (this.remaining <= 0) {
      this.push(null);
      return;
    }
    const want = Math.min(this.remaining, BODY_CHUNK);
    this.reader
      .readExact(want)
      .then((chunk) => {
        this.remaining -= chunk.length;
        this.push(chunk);
      })
      .catch((err: Error) => {
        this.destroy(err);
      });
  }
}

function whenEnded(stream: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
  });
}

/**
 * Reads a ustar archive from `input`, calling `onEntry(path, size, body)` for
 * each regular file in order. Directory entries are skipped. Any other entry
 * type (symlink, hardlink, device, fifo, pax header, ...) throws, because
 * this writer never produces one and silently skipping it would drop content
 * from a backup without saying so.
 *
 * Backpressure: `readTar` does not read past an entry's body until that
 * body's Readable has emitted 'end' — so a slow or partial consumer of one
 * entry stalls the whole archive rather than letting the reader buffer
 * ahead.
 */
export async function readTar(
  input: Readable,
  onEntry: (path: string, size: number, body: Readable) => Promise<void>,
): Promise<void> {
  const reader = new BlockReader(input);

  for (;;) {
    const block = await reader.readExact(BLOCK_SIZE);
    if (isZeroBlock(block)) return;

    const header = parseHeader(block);
    validateEntryPath(header.path);

    if (header.typeflag === TYPE_DIRECTORY) {
      if (header.size > 0) await reader.readExact(header.size);
      const pad = padLength(header.size);
      if (pad > 0) await reader.readExact(pad);
      continue;
    }

    if (header.typeflag !== TYPE_REGULAR) {
      throw new Error(`tar: unsupported entry type '${header.typeflag}' for ${header.path}`);
    }

    const body = new EntryBodyStream(reader, header.size);
    const entryDone = onEntry(header.path, header.size, body);
    await Promise.all([entryDone, whenEnded(body)]);

    const pad = padLength(header.size);
    if (pad > 0) await reader.readExact(pad);
  }
}

export const USTAR_MAX_SIZE = MAX_USTAR_SIZE;
