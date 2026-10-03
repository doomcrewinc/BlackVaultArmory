import { promises as fsp } from "node:fs";
import path from "node:path";
import { decryptFile, deriveKeys, encryptFile, fileKeyId, isEncryptedFile, parseKeyHex, type FieldKeys } from "../encryption/core.mjs";
import { getFieldKeys } from "../encryption/keys";
import { uploadsRoot, writeAtomic } from "./storage";
import { listUploads } from "./upload-walk";

/**
 * `reencrypt-files` (full-backups spec §3,
 * docs/superpowers/specs/2026-10-02-full-backups-design.md): the recovery
 * tool for an uploads folder whose files are encrypted under an OLD key —
 * a folder copied from another machine, for example — when that old key is
 * at hand. Every such file is decrypted with the old key and re-encrypted
 * under the install's CURRENT key, in place.
 *
 * Run by scripts/entry/reencrypt-files.ts (bundled to
 * dist/scripts/reencrypt-files.mjs), which reencrypt-files.sh / .bat start
 * in a one-off container while the app is stopped.
 *
 * WHICH FILES. Exactly the files a full backup holds (./upload-walk.ts):
 * every regular file under `<uploads>/images` and `<uploads>/documents`.
 * Hidden entries (so `.pre-encryption-*`, `.restore-*`, `.pre-restore-*`),
 * `*.tmp`, `*.rot` and symbolic links are never read and never written.
 *
 * PER FILE, by the key id in its BVF1 header:
 *   the old key      decrypt with the old key, encrypt under the current
 *                    key, replace the file with writeAtomic, then read it
 *                    back and check it decrypts under the current key;
 *   the current key  skipped (this is what makes a second run a no-op);
 *   any other key, or a damaged BVF1 header
 *                    left untouched, counted as `unknownKey`, one WARNING;
 *   not BVF1         left untouched, counted as `notEncrypted`.
 *
 * FAILURES.
 * - An old-key file that does not decrypt (damaged, or renamed: the file
 *   name is part of what is authenticated) is left untouched, reported, and
 *   counted as `failed`; the run goes on with the next file, so that one bad
 *   file cannot keep every file after it from being recovered.
 * - A file that cannot be read or written (a full disk, permissions) stops
 *   the run: ReencryptError, with the counts so far (`stopped` is 1).
 * In both cases every file is whole — its original bytes, or the complete
 * new ones: writeAtomic writes a temp file and renames it over the original.
 * Running the tool again continues with the files still under the old key.
 * - ONE path is different. After a file has been replaced it is read back
 *   and decrypted with the current key. If THAT fails, the original is
 *   already gone (the rename has happened), so nothing here can put it
 *   back: the run stops and says that this one file was replaced but could
 *   not be confirmed, and to check it. It is counted as `reencrypted` — on
 *   disk it is the new file — never as "left as it was". The bytes written
 *   had been checked in memory (they decrypt to the original) before the
 *   write, so this means the disk or the filesystem returned something else.
 *
 * It never deletes a file, and it knows nothing about key FILES: the caller
 * hands it the old key's text.
 *
 * All crypto is in ../encryption/core.mjs. fsp.* is always called through
 * the imported namespace object so tests can `vi.spyOn(fsp, …)` (same rule
 * as ./storage.ts). Imports stay relative, as in ./storage.ts.
 */

export interface ReencryptCounts {
  /** Were under the old key; now under the current key. */
  reencrypted: number;
  /** Already under the current key: skipped. */
  alreadyCurrent: number;
  /** BVF1 under some other key, or with a damaged header: left untouched. */
  unknownKey: number;
  /** Not a BVF1 file: left untouched. */
  notEncrypted: number;
  /** Under the old key, but could not be re-encrypted: left untouched. */
  failed: number;
  /**
   * 1 when the run stopped before it had gone through every file (an I/O
   * error, or a re-encrypted file that could not be confirmed): the other
   * counts then cover only the files reached. 0 when every file was looked at.
   */
  stopped: number;
}

/**
 * ok       at least one file was under the old key and every such file was re-encrypted;
 * nothing  no file is under the old key (nothing was changed);
 * failed   at least one old-key file could not be re-encrypted.
 */
export type ReencryptOutcome = "ok" | "nothing" | "failed";

export interface ReencryptResult {
  outcome: ReencryptOutcome;
  counts: ReencryptCounts;
  /** One line per old-key file that could not be re-encrypted. */
  failures: string[];
}

/** The old key cannot be used: nothing was read or changed. */
export class ReencryptKeyError extends Error {
  readonly code: "KEY_FILE_INVALID" | "SAME_KEY";
  constructor(code: "KEY_FILE_INVALID" | "SAME_KEY", message: string) {
    super(message);
    this.name = "ReencryptKeyError";
    this.code = code;
  }
}

/** The run stopped part-way; `counts` is what had been done. */
export class ReencryptError extends Error {
  readonly counts: ReencryptCounts;
  constructor(message: string, counts: ReencryptCounts, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ReencryptError";
    this.counts = counts;
  }
}

const codeOf = (e: unknown): string =>
  (typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" && (e as { code: string }).code) ||
  (e instanceof Error ? e.message : String(e));

/**
 * The old key from the text of its key file: the same format as the
 * install's own key file (64 hex characters; a byte-order mark and
 * surrounding whitespace are ignored), parsed by the core's parseKeyHex.
 * The text is never echoed in the error.
 */
export function parseOldKey(text: string): FieldKeys {
  try {
    return deriveKeys(parseKeyHex(text));
  } catch {
    throw new ReencryptKeyError(
      "KEY_FILE_INVALID",
      "The old key file does not hold an encryption key: it must be 64 hex characters, like secrets/blackvault_encryption_key. Nothing was changed.",
    );
  }
}

const STATUS: Record<ReencryptOutcome, string> = { ok: "OK", nothing: "NOTHING", failed: "FAILED" };

/**
 * The one line the CLI prints on standard output:
 *   BLACKVAULT_REENCRYPT_<OK|NOTHING|FAILED> reencrypted=<n> already_current=<n> unknown_key=<n> not_encrypted=<n> failed=<n> stopped=<0|1>
 */
export function summaryLine(r: Pick<ReencryptResult, "outcome" | "counts">): string {
  const c = r.counts;
  return `BLACKVAULT_REENCRYPT_${STATUS[r.outcome]} reencrypted=${c.reencrypted} already_current=${c.alreadyCurrent} unknown_key=${c.unknownKey} not_encrypted=${c.notEncrypted} failed=${c.failed} stopped=${c.stopped}`;
}

export interface ReencryptOptions {
  /** The key the files are under (parseOldKey). */
  oldKeys: FieldKeys;
  /** The install's current key. Default: the app's own (getFieldKeys). */
  currentKeys?: FieldKeys;
  /** The uploads root. Default: uploadsRoot(). */
  root?: string;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** A progress line every this many re-encrypted files (each one is fsynced). */
export const REENCRYPT_PROGRESS_EVERY = 250;

export async function reencryptFiles(opts: ReencryptOptions): Promise<ReencryptResult> {
  const oldKeys = opts.oldKeys;
  const current = opts.currentKeys ?? getFieldKeys();
  const log = opts.log ?? ((line: string) => console.error(line));
  const warn = opts.warn ?? ((line: string) => console.error(line));
  if (oldKeys.id === current.id) {
    throw new ReencryptKeyError(
      "SAME_KEY",
      `The old key file holds this install's CURRENT key (key id ${current.id}), so there is nothing to re-encrypt. Give the key the files were encrypted with. Nothing was changed.`,
    );
  }
  const root = opts.root ?? uploadsRoot();
  const counts: ReencryptCounts = { reencrypted: 0, alreadyCurrent: 0, unknownKey: 0, notEncrypted: 0, failed: 0, stopped: 0 };
  const failures: string[] = [];
  // The run stops at a file that was NOT changed (it could not be read, re-encrypted or written).
  const stop = (rel: string, what: string, e: unknown): ReencryptError => {
    counts.failed++;
    counts.stopped = 1;
    return new ReencryptError(
      `Could not ${what} ${rel} (${codeOf(e)}); it was left as it was. ${counts.reencrypted} ${counts.reencrypted === 1 ? "file was" : "files were"} re-encrypted before that. ` +
        "Every file is whole, under the old key or the current one. Free disk space or fix the uploads folder's permissions, then run this again: it continues with the files still under the old key.",
      counts,
      e,
    );
  };

  for (const entry of await listUploads(root)) {
    const rel = path.relative(root, entry.abs).split(path.sep).join("/");
    const name = path.basename(entry.abs);
    let stored: Buffer;
    try {
      stored = await fsp.readFile(entry.abs);
    } catch (e) {
      throw stop(rel, "read", e);
    }
    if (!isEncryptedFile(stored)) {
      counts.notEncrypted++;
      continue;
    }
    let id: string;
    try {
      id = fileKeyId(stored);
    } catch {
      counts.unknownKey++;
      warn(`WARNING: ${rel} starts like an encrypted file but its header is damaged; it was left as it is.`);
      continue;
    }
    if (id === current.id) {
      counts.alreadyCurrent++;
      continue;
    }
    if (id !== oldKeys.id) {
      counts.unknownKey++;
      warn(`WARNING: ${rel} is encrypted with key ${id}, which is neither the old key (${oldKeys.id}) nor the current key (${current.id}); it was left as it is.`);
      continue;
    }

    let plaintext: Buffer;
    try {
      plaintext = decryptFile(oldKeys, name, stored);
    } catch (e) {
      counts.failed++;
      const why = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "the file is damaged, or was renamed after it was encrypted";
      failures.push(`${rel} is under the old key but could not be decrypted with it (${why}); it was left as it is.`);
      continue;
    }
    const replacement = encryptFile(current, name, plaintext);
    // Never install bytes that do not decrypt back to the original.
    if (!decryptFile(current, name, replacement).equals(plaintext)) throw stop(rel, "re-encrypt", new Error("round-trip check failed"));
    try {
      await writeAtomic(entry.abs, replacement);
    } catch (e) {
      throw stop(rel, "write", e);
    }
    // The file on disk is now the re-encrypted one: the rename has happened.
    counts.reencrypted++;
    // Confirm it reads under the current key. If it does not, the original is
    // already gone, so this is NOT "left as it was": say exactly what happened.
    try {
      if (!decryptFile(current, name, await fsp.readFile(entry.abs)).equals(plaintext)) throw new Error("the file read back differs from what was written");
    } catch (e) {
      counts.stopped = 1;
      throw new ReencryptError(
        `${rel} was replaced with its re-encrypted copy, but it could not be confirmed: reading it back failed (${codeOf(e)}). ` +
          "Check this file once BlackVault runs; if it does not open, put it back from your copy of the uploads folder or from a backup. " +
          `The run stopped here, after ${counts.reencrypted} ${counts.reencrypted === 1 ? "file" : "files"} (this one included). ` +
          "Every OTHER file is whole, under the old key or the current one; run this again to continue with the files still under the old key.",
        counts,
        e,
      );
    }
    if (counts.reencrypted % REENCRYPT_PROGRESS_EVERY === 0) log(`reencrypt-files: re-encrypted ${counts.reencrypted} files so far`);
  }

  if (counts.unknownKey > 0) {
    warn(
      `WARNING: ${counts.unknownKey} ${counts.unknownKey === 1 ? "file is" : "files are"} encrypted with a key that is neither the old key nor the current one (or ${counts.unknownKey === 1 ? "has" : "have"} a damaged header). ` +
        "BlackVault refuses to start while such a file is in the uploads folder: move it out, or run this again with the key that encrypted it.",
    );
  }
  const outcome: ReencryptOutcome = counts.failed > 0 ? "failed" : counts.reencrypted > 0 ? "ok" : "nothing";
  return { outcome, counts, failures };
}
