import { Readable, Writable } from "node:stream";

/**
 * A minimal POSIX ustar tar writer and reader, with no dependency beyond
 * node:stream.
 *
 * Why hand-rolled: the full backup's plaintext stream (db.json, then every
 * decrypted upload under files/, then manifest.json LAST — controller ruling
 * for fix round 1, so the engine can hash files while streaming them and
 * record files that vanish mid-run in `skipped`) is piped straight into the
 * BVB1 sealer
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
 *   emit directory entries; we skip them, and reject one with a body) and
 *   rejects every other type
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

/**
 * Whether `filePath` can be written as a ustar entry at all: it fits the
 * 100-byte name field, or it can be split at a "/" into a prefix of at most
 * 155 bytes and a name of at most 100 (lengths in UTF-8 bytes). The name
 * rule of a full backup (./entry-names.ts) asks this, so that a path that
 * does not fit is left out and reported instead of failing the whole run.
 */
export function fitsUstarPath(filePath: string): boolean {
  try {
    splitUstarPath(filePath);
    return true;
  } catch {
    return false;
  }
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
 * Streams `source` into `dest` (without ending it), enforcing the declared
 * `size` as it goes. Uses async iteration + an awaited write per chunk, so at
 * most one chunk is held at a time regardless of the source's total size.
 *
 * A chunk that would take the running total past `size` is rejected BEFORE
 * it is written (review I3), so a file that grows mid-backup is caught on
 * the chunk that overruns, not after streaming every extra byte. Throwing
 * out of the `for await` destroys the source. A source that ends short is
 * rejected after its end.
 */
async function pipeExact(source: Readable, dest: Writable, size: number, path: string): Promise<void> {
  let total = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    if (total + chunk.length > size) {
      throw new Error(`tar: ${path} produced more than the declared ${size} bytes`);
    }
    total += chunk.length;
    await writeAsync(dest, chunk);
  }
  if (total !== size) {
    throw new Error(`tar: ${path} declared ${size} bytes but the source produced ${total}`);
  }
}

/**
 * Writes a ustar archive to `out`. Call `addFile`/`addBuffer` for each entry
 * in order, one at a time, then `finish()` exactly once.
 *
 * Failed state (review I3): ANY `addFile` error — a bad path or size, a source
 * that is short or long, a write error — leaves the writer failed, because by
 * then a header and part of a body may already be in `out` and the archive is
 * misaligned. Every later `addFile`/`addBuffer`/`finish` rejects, so a caller
 * cannot catch the error, carry on, and ship a corrupt archive. A caller that
 * wants to skip a file (e.g. one that vanished mid-run) must decide that
 * BEFORE calling `addFile` — open the file and know its size first.
 */
export class TarWriter {
  private readonly out: Writable;
  private finished = false;
  private busy = false;
  private failure: Error | null = null;

  constructor(out: Writable) {
    this.out = out;
  }

  private assertUsable(): void {
    if (this.failure) {
      throw new Error(`tar: writer is in a failed state after an earlier error (${this.failure.message})`);
    }
    if (this.busy) throw new Error("tar: addFile/finish called while another entry is still being written");
  }

  /**
   * Streams `source` into the archive as `path`, declared as `size` bytes.
   * Never buffers the whole file: the source is piped directly into the
   * underlying stream. A source that overruns `size` is rejected on the
   * overrunning chunk; one that ends short is rejected at its end. Either
   * way the writer enters its failed state (never padded or truncated
   * silently).
   */
  async addFile(path: string, size: number, source: Readable): Promise<void> {
    this.assertUsable();
    if (this.finished) throw new Error("tar: cannot add an entry after finish()");
    this.busy = true;
    try {
      validateEntryPath(path);
      if (!Number.isSafeInteger(size) || size < 0) {
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
      await pipeExact(source, this.out, size, path);
      const pad = padLength(size);
      if (pad > 0) await writeAsync(this.out, Buffer.alloc(pad, 0));
    } catch (err) {
      this.failure = err instanceof Error ? err : new Error(String(err));
      if (!source.destroyed) source.destroy();
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Convenience wrapper over `addFile` for content already in memory. */
  async addBuffer(path: string, buf: Buffer): Promise<void> {
    await this.addFile(path, buf.length, Readable.from(buf, { objectMode: false }));
  }

  /** Writes the two terminating zero blocks. The writer must not be used afterwards. Rejects if the writer is in its failed state. */
  async finish(): Promise<void> {
    this.assertUsable();
    if (this.finished) return;
    this.finished = true;
    await writeAsync(this.out, Buffer.alloc(BLOCK_SIZE * 2, 0));
  }
}

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads a NUL-terminated (and NUL-padded) string field as strict UTF-8.
 * Throws if a non-NUL byte follows the terminator (a malformed or hostile
 * header) or if the bytes are not valid UTF-8 — a lossy decode would map two
 * different byte strings to the same name (both "a�").
 */
function readCString(buf: Buffer, offset: number, len: number): string {
  const field = buf.subarray(offset, offset + len);
  const nul = field.indexOf(0);
  if (nul !== -1) {
    for (let i = nul + 1; i < field.length; i++) {
      if (field[i] !== 0) {
        throw new Error("tar: malformed header field (non-NUL byte after string terminator)");
      }
    }
  }
  try {
    return UTF8_STRICT.decode(nul === -1 ? field : field.subarray(0, nul));
  } catch {
    throw new Error("tar: entry name is not valid UTF-8");
  }
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

function isAllZero(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

/**
 * The one path rule for archive entries, used by the writer, the reader and
 * the manifest (`files[].path`), so nothing downstream (restore, Task 7) has
 * to normalise a path: a path that passes is already canonical.
 *
 * A valid path is non-empty, relative, uses `/` only, and every segment is a
 * non-empty name other than `.` and `..`. That rejects `..` anywhere, a
 * leading `/`, `a//b`, a trailing `/`, `./a`, `a/./b`, `.`, backslashes
 * (`..\..\evil` is a traversal on Windows tools) and NUL bytes. UTF-8
 * validity is enforced where bytes are decoded (`readCString`); a JS string
 * cannot hold invalid UTF-8 except as lone surrogates, rejected here too.
 */
export function validateEntryPath(path: string): void {
  if (path.length === 0) throw new Error("tar: empty entry path");
  if (path.includes("\0")) throw new Error("tar: NUL byte in entry path");
  if (path.includes("\\")) throw new Error(`tar: backslash in entry path: ${path}`);
  if (!path.isWellFormed()) throw new Error("tar: entry path is not valid UTF-8 (lone surrogate)");
  if (path.startsWith("/")) throw new Error(`tar: absolute path in archive: ${path}`);
  for (const segment of path.split("/")) {
    if (segment === "..") throw new Error(`tar: ".." path segment in archive: ${path}`);
    if (segment === ".") throw new Error(`tar: "." path segment in archive: ${path}`);
    if (segment === "") throw new Error(`tar: empty path segment (double or trailing "/") in archive: ${path}`);
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
  const typeflag = block.subarray(FIELD.typeflag, FIELD.typeflag + 1).toString("ascii");

  return { path, size, typeflag: typeflag === "\0" ? TYPE_REGULAR : typeflag };
}

/**
 * A byte queue over a Readable, consumed with the stream's async iterator.
 *
 * Why not `read(n)` + `'readable'` (the first version): attaching a
 * `'readable'` listener while a partial buffer is queued re-emits on the
 * next tick, so waiting for "n bytes" on any multi-chunk async input became a
 * nextTick spin that starved I/O and never received the data (review C1).
 * The async iterator has no such bookkeeping: `next()` resolves with the next
 * chunk, `done` at a clean end, and rejects with the stream's error.
 *
 * Errors are sticky: once a read fails (stream error or unexpected end), every
 * later read rethrows the same error, so a failure seen first by an entry body
 * still surfaces from `readTar`.
 *
 * Memory: holds at most the chunks needed to satisfy the current request plus
 * the unconsumed rest of the last chunk pulled (the opener emits 1 MiB
 * chunks). Body data is handed out as zero-copy subarrays.
 */
class ByteSource {
  private readonly iter: AsyncIterator<unknown>;
  private readonly chunks: Buffer[] = [];
  private head = 0;
  private headOffset = 0;
  private queued = 0;
  private done = false;
  private error: unknown = null;

  constructor(input: Readable) {
    this.iter = input[Symbol.asyncIterator]();
  }

  /** Pulls one chunk. Returns false at a clean end of input. */
  private async pull(): Promise<boolean> {
    if (this.error !== null) throw this.error;
    if (this.done) return false;
    let result: IteratorResult<unknown>;
    try {
      result = await this.iter.next();
    } catch (err) {
      this.error = err;
      throw err;
    }
    if (result.done) {
      this.done = true;
      return false;
    }
    const value = result.value;
    let chunk: Buffer;
    if (Buffer.isBuffer(value)) chunk = value;
    else if (value instanceof Uint8Array) chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else return this.fail(new Error("tar: input stream must yield bytes (Buffer/Uint8Array), not strings or objects"));
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.queued += chunk.length;
    }
    return true;
  }

  private fail(err: Error): never {
    this.error = err;
    throw err;
  }

  private truncated(wanted: number): never {
    return this.fail(new Error(`tar: unexpected end of archive (wanted ${wanted} bytes, got ${this.queued})`));
  }

  /** Removes up to `max` bytes from the front of the first queued chunk (zero-copy). */
  private takeFromHead(max: number): Buffer {
    const chunk = this.chunks[this.head];
    const n = Math.min(max, chunk.length - this.headOffset);
    const out = chunk.subarray(this.headOffset, this.headOffset + n);
    this.headOffset += n;
    this.queued -= n;
    if (this.headOffset === chunk.length) {
      this.head++;
      this.headOffset = 0;
      if (this.head > 64 || this.head === this.chunks.length) {
        this.chunks.splice(0, this.head);
        this.head = 0;
      }
    }
    return out;
  }

  /** Exactly `n` bytes, or throws "unexpected end of archive". Use for headers and padding only (bounded n). */
  async readExact(n: number): Promise<Buffer> {
    if (this.error !== null) throw this.error;
    while (this.queued < n) {
      if (!(await this.pull())) this.truncated(n);
    }
    if (n === 0) return Buffer.alloc(0);
    const first = this.takeFromHead(n);
    if (first.length === n) return first;
    const parts = [first];
    let got = first.length;
    while (got < n) {
      const part = this.takeFromHead(n - got);
      parts.push(part);
      got += part.length;
    }
    return Buffer.concat(parts, n);
  }

  /** Between 1 and `max` bytes (whatever is queued, pulling if nothing is), or throws at end of input. */
  async readSome(max: number): Promise<Buffer> {
    if (this.error !== null) throw this.error;
    while (this.queued === 0) {
      if (!(await this.pull())) this.truncated(max);
    }
    return this.takeFromHead(max);
  }

  /** Discards exactly `n` bytes without buffering them, or throws "unexpected end of archive". */
  async skip(n: number): Promise<void> {
    let left = n;
    while (left > 0) left -= (await this.readSome(left)).length;
  }

  /**
   * Reads the input to its end and checks that every remaining byte is zero.
   * Running to the end is what lets the BVB1 opener's final-chunk and
   * trailing-bytes checks fire before `readTar` resolves.
   */
  async expectZerosToEnd(): Promise<void> {
    for (;;) {
      while (this.queued > 0) {
        if (!isAllZero(this.takeFromHead(this.queued))) {
          this.fail(new Error("tar: trailing non-zero data after the end-of-archive marker"));
        }
      }
      if (!(await this.pull())) return;
    }
  }

  /** Stops consuming the input after a failure: `return()` on a stream iterator destroys the stream. */
  async abandon(): Promise<void> {
    try {
      await this.iter.return?.();
    } catch {
      // The stream already failed; its own error is the one being reported.
    }
  }
}

const BODY_CHUNK = 64 * 1024;

/**
 * The Readable handed to `onEntry`. Pulls from the shared ByteSource lazily,
 * at most `BODY_CHUNK` bytes per `_read`, so a large entry is never buffered
 * in full. `remaining` counts body bytes not yet taken from the source;
 * `inFlight` lets `readTar` wait for an outstanding pull before it takes the
 * source back.
 */
class EntryBodyStream extends Readable {
  remaining: number;
  inFlight: Promise<void> | null = null;
  private readonly source: ByteSource;

  constructor(source: ByteSource, size: number) {
    super();
    this.source = source;
    this.remaining = size;
  }

  override _read(): void {
    if (this.remaining <= 0) {
      this.push(null);
      return;
    }
    this.inFlight = this.source.readSome(Math.min(this.remaining, BODY_CHUNK)).then(
      (chunk) => {
        this.remaining -= chunk.length;
        this.inFlight = null;
        if (!this.destroyed) this.push(chunk);
      },
      (err: Error) => {
        this.inFlight = null;
        this.destroy(err);
      },
    );
  }
}

/**
 * Reads a ustar archive from `input`, calling `onEntry(path, size, body)` for
 * each regular file in order. Directory entries (size 0 only) are skipped.
 * Any other entry type (symlink, hardlink, device, fifo, pax header, ...)
 * throws, because this writer never produces one and silently skipping it
 * would drop content from a backup without saying so.
 *
 * Works for any chunking of `input` (single buffer, fs stream, the BVB1
 * opener's 1 MiB chunks, 1-byte pieces).
 *
 * Rejects (never hangs) on:
 * - a truncated archive ("unexpected end of archive"), anywhere;
 * - a bad header, an unsafe or non-UTF-8 path (`validateEntryPath`), a
 *   duplicate entry name, a directory entry with a body;
 * - a single zero block not followed by a second one, or any non-zero byte
 *   after the two-zero-block end marker. `readTar` reads the input to its
 *   end before resolving, so an error the input raises at its end (the BVB1
 *   opener's missing-final-chunk and trailing-bytes checks) rejects
 *   `readTar` too.
 * On rejection the input stream is destroyed.
 *
 * Body contract (review I1): `body` is only valid until `onEntry`'s promise
 * settles. If `onEntry` resolves without reading the whole body — or
 * destroys it — `readTar` destroys the body and skips the unread rest itself,
 * then continues with the next entry. So a consumer may skip an entry simply
 * by returning. Skipping still reads the bytes (a truncated body still
 * rejects). If `onEntry` rejects, `readTar` rejects with that error.
 *
 * Backpressure: `readTar` does not read past an entry's body until
 * `onEntry` settles, so a slow consumer stalls the archive rather than
 * letting the reader buffer ahead.
 */
export async function readTar(
  input: Readable,
  onEntry: (path: string, size: number, body: Readable) => Promise<void>,
): Promise<void> {
  const source = new ByteSource(input);
  try {
    await readEntries(source, onEntry);
  } catch (err) {
    await source.abandon();
    throw err;
  }
}

async function readEntries(
  source: ByteSource,
  onEntry: (path: string, size: number, body: Readable) => Promise<void>,
): Promise<void> {
  const seen = new Set<string>();

  for (;;) {
    const block = await source.readExact(BLOCK_SIZE);
    if (isAllZero(block)) {
      const second = await source.readExact(BLOCK_SIZE);
      if (!isAllZero(second)) {
        throw new Error("tar: corrupt end-of-archive marker (a zero block not followed by a second zero block)");
      }
      await source.expectZerosToEnd();
      return;
    }

    const header = parseHeader(block);
    const isDirectory = header.typeflag === TYPE_DIRECTORY;
    // Directory entries conventionally end in "/" ("sub/"); that one slash is
    // allowed and stripped. A file entry with a trailing "/" fails the rule.
    const path = isDirectory && header.path.endsWith("/") ? header.path.slice(0, -1) : header.path;
    validateEntryPath(path);
    if (seen.has(path)) throw new Error(`tar: duplicate entry in archive: ${path}`);
    seen.add(path);

    if (isDirectory) {
      if (header.size !== 0) throw new Error(`tar: directory entry ${path} has a non-zero size (${header.size})`);
      continue;
    }

    if (header.typeflag !== TYPE_REGULAR) {
      throw new Error(`tar: unsupported entry type '${header.typeflag}' for ${path}`);
    }

    const body = new EntryBodyStream(source, header.size);
    try {
      await onEntry(path, header.size, body);
    } finally {
      // Take the source back: stop the body pulling, and let any pull already
      // under way land (it updates `remaining`) before reading on.
      if (!body.destroyed) body.destroy();
      await body.inFlight;
    }
    if (body.remaining > 0) await source.skip(body.remaining);

    const pad = padLength(header.size);
    if (pad > 0) await source.readExact(pad);
  }
}

export const USTAR_MAX_SIZE = MAX_USTAR_SIZE;
