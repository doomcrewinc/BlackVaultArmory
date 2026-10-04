#!/usr/bin/env node
// Key rotation CLI — run with the app STOPPED (field-encryption spec,
// docs/superpowers/specs/2026-09-30-field-encryption-design.md §3 "Rotation").
//
// In ONE transaction (SQLite's connection_limit=1 allows no second
// connection, so everything below runs on the single transaction client):
//   - re-encrypts every registered field (src/lib/encryption/fields.ts,
//     mirrored below) under the new key, decrypting it with the old key
//     first — the stored ciphertext for every "date"/"number" field is
//     itself just a string (an ISO date or a JSON number, per
//     src/lib/encryption/extension.ts's serialize()); rotation never needs
//     to parse it back to a Date/number, only move the same plaintext
//     string to a new envelope;
//   - recomputes every serialNumberHash with the new key's index subkey;
//   - replaces AppSettings.encryptionKeyCheck and sets
//     AppSettings.encryptionCompactionPending;
//   - writes one KEY_ROTATED audit event.
// After the commit it compacts the database (VACUUM on
// SQLite, VACUUM FULL + ANALYZE on PostgreSQL, src/lib/encryption/compaction.mjs)
// so the OLD-key ciphertext does not linger in free space, then clears the
// marker. Best-effort: a failure is a warning (exit stays 0) and the app's
// next start retries it, because the marker is still set.
// A failure anywhere rolls the whole transaction back: no row and no key
// file changes. The script itself never touches the key files on disk —
// that is rotate-key.sh/.bat's job (step 6 of the spec's rotation list).
//
// Uploaded files (docs/superpowers/specs/2026-10-01-encrypted-files-design.md
// §3 "Rotation"). Every BVF1 file under the uploads root that is under the OLD
// key is re-encrypted under the NEW key around that one transaction:
//   1. Stage (before the transaction): each such file is decrypted and
//      re-encrypted into `<name>.rot`, written atomically (temp
//      `<name>.rot.<8hex>.tmp`, mode 0600, fsync, rename, dir fsync). The AAD
//      is the ORIGINAL file's basename, never `<name>.rot`, so the staged copy
//      decrypts under the name it is about to take. Originals are not touched.
//      A BVF1 file under neither key (or with a damaged header), a symlinked
//      folder, or a leftover `.rot` under the OLD key refuses up front (exit 3).
//   2. The database transaction, unchanged.
//   3. Finalise (only after the commit): each `.rot` is renamed over its
//      original, then each directory is fsynced. A failure here is a warning
//      (exit stays 0: the rotation has committed): src/lib/files/startup.ts renames any `.rot`
//      under the current key into place on the app's next start.
//   If the run fails BEFORE the commit, every `.rot` this run staged is
//   deleted (its original is untouched, so it is never the only copy). A crash
//   before the commit leaves `.rot` files under a key that is not current;
//   startup deletes those. A crash after the commit leaves them under the
//   current key; startup finishes them. Either way no file is ever unreadable.
//   Files are processed one at a time, whole-file in memory (uploads are capped
//   at about 20 MB each).
//
// Usage: node scripts/rotate-encryption-key.mjs --old-key-file <path> --new-key-file <path>
//   exit 0  success — one line naming the old/new key ids (never the keys) and row counts.
//           Exits 0 IFF the transaction committed: a failure AFTER that
//           point (closing the DB connection, a broken stdout pipe) is printed as a
//           warning, never turns a committed rotation into a non-zero exit — the wrapper's
//           --probe mode, not this exit code, is what tells a caller "did it commit?" when
//           something fails around the edges of a run.
//   exit 1  a failure BEFORE commit — one line on stderr; nothing changed
//   exit 2  usage error
//   exit 3  refused UP FRONT, before any transaction opened: the
//           database has no key check, or --old-key-file does not open it (it is not
//           this database's key), or an uploaded file is under neither key,
//           has a damaged header, sits behind a symlinked folder, or a leftover .rot is
//           under the old key. Nothing changed and nothing could have; the wrappers
//           skip the probe and print the reason this script gave.
//
// Probe mode: node scripts/rotate-encryption-key.mjs --probe --old-key-file <path> --new-key-file <path>
//   Read-only. Prints one of OLD, NEW or NEITHER (which key currently opens
//   AppSettings.encryptionKeyCheck) as its FIRST line and exits 0. It prints a
//   SECOND line, `FILES old=<n> new=<n> rot=<n>`: uploaded files under the old key,
//   under the new key, and staged `.rot` files. The first line is unchanged, and the
//   wrappers read only the first line as the answer. If the files cannot be counted
//   the second line is left out (a warning goes to stderr AFTER the answer line). Exits non-zero (nothing printed on
//   stdout) when it cannot tell — DB unreachable, no key check row, or a key file itself
//   unreadable. For the wrappers to use after any non-zero exit from a rotation run, to
//   tell a committed rotation (now reads as NEW) from one that never took effect (OLD)
//   from a state nobody can vouch for (NEITHER, or the probe itself failing).
//
// Plain JS (no ts-node in the runner image), so it cannot import the TS
// helpers directly, exactly like scripts/admin-reset-link.mjs. It imports
// the ONLY crypto module, src/lib/encryption/core.mjs, directly — see that
// file's header — and MIRRORS the few TS pieces it needs, each commented
// with its source of truth:
//   - the encrypted-field registry: src/lib/encryption/fields.ts
//     (ENCRYPTED_FIELDS). scripts/rotate-encryption-key.test.ts asserts the
//     two lists are identical, so they cannot silently drift.
//   - the key-check constants and AppSettings row id: src/lib/encryption/startup.ts
//   - the audit-event row shape: src/lib/audit/record.ts's writeAuditEvent
//   - Prisma client selection: src/lib/prisma.ts (loadPrismaClient) via
//     createRequire, same as scripts/admin-reset-link.mjs
//   - the uploads root (uploadsRoot) and the atomic write
//     (writeAtomic) from src/lib/files/storage.ts — the root has an equality
//     test in scripts/rotate-encryption-key.test.ts — and the folder walk
//     plus `.rot` naming from src/lib/files/startup.ts, so this script and
//     the app's startup agree on which files exist and how staging is named.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promises as fsp, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  parseKeyHex, deriveKeys, encryptValue, decryptValue, fingerprint, EncryptionKeyError,
  encryptFile, decryptFile, fileKeyId, isEncryptedFile,
} from "../src/lib/encryption/core.mjs";
import { clearCompactionPending, compactDatabase } from "../src/lib/encryption/compaction.mjs";

const require = createRequire(import.meta.url);

// Mirrors ENCRYPTED_FIELDS in src/lib/encryption/fields.ts (D1) exactly,
// field for field and in the same order. `kind` is carried only so the
// equality test can compare the two lists as-is; rotation itself never
// needs it (see the header comment above).
export const ENCRYPTED_FIELDS = [
  { model: "Firearm", delegate: "firearm", field: "serialNumber", kind: "string", fingerprint: true },
  { model: "Firearm", delegate: "firearm", field: "nfaControlNumber", kind: "string" },
  { model: "Firearm", delegate: "firearm", field: "nfaRegisteredTo", kind: "string" },
  { model: "Firearm", delegate: "firearm", field: "nfaTransferMethod", kind: "string" },
  { model: "Firearm", delegate: "firearm", field: "nfaApprovalDate", kind: "date" },
  { model: "Firearm", delegate: "firearm", field: "nfaTaxPaid", kind: "number" },
  { model: "Accessory", delegate: "accessory", field: "serialNumber", kind: "string", fingerprint: true },
  { model: "Accessory", delegate: "accessory", field: "nfaControlNumber", kind: "string" },
  { model: "Accessory", delegate: "accessory", field: "nfaRegisteredTo", kind: "string" },
  { model: "Accessory", delegate: "accessory", field: "nfaTransferMethod", kind: "string" },
  { model: "Accessory", delegate: "accessory", field: "nfaApprovalDate", kind: "date" },
  { model: "Accessory", delegate: "accessory", field: "nfaTaxPaid", kind: "number" },
  { model: "Gear", delegate: "gear", field: "serialNumber", kind: "string", fingerprint: true },
];

/** The models that hold an encrypted field, in registry order, with their fields — mirrors startup.ts's ENCRYPTED_MODELS. */
const MODELS = [...new Set(ENCRYPTED_FIELDS.map((f) => f.model))].map((model) => {
  const fields = ENCRYPTED_FIELDS.filter((f) => f.model === model);
  return { model, delegate: fields[0].delegate, fields };
});

// Mirrors src/lib/encryption/fields.ts's aadFor exactly: the AAD is model+field, never the key.
function aadFor(model, field) {
  return `${model}.${field}`;
}

// Mirrors the key-check constants in src/lib/encryption/startup.ts exactly.
const KEY_CHECK_AAD = "AppSettings.encryptionKeyCheck";
const KEY_CHECK_PLAINTEXT = "blackvault-key-check";
const SETTINGS_ID = "singleton";

// Rows read per page per model — bounds memory on a large inventory; never
// loads a whole table at once. SQLite's connection_limit=1 still means one
// connection, so this stays entirely on the transaction client.
const PAGE_SIZE = 500;

// Long enough for a large inventory on slow storage; the server is stopped
// while this runs. Mirrors startup.ts's MIGRATION_TX.
const ROTATION_TX = { maxWait: 10_000, timeout: 600_000 };

function usage() {
  console.error(
    "Usage: node scripts/rotate-encryption-key.mjs [--probe] --old-key-file <path> --new-key-file <path>",
  );
}

function parseArgs(argv) {
  let oldKeyFile;
  let newKeyFile;
  let probe = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--old-key-file") oldKeyFile = argv[++i];
    else if (a === "--new-key-file") newKeyFile = argv[++i];
    else if (a === "--probe") probe = true;
    else return null;
  }
  if (!oldKeyFile || !newKeyFile) return null;
  return { oldKeyFile, newKeyFile, probe };
}

/** Reads a key file into derived FieldKeys, or throws RotationError with a one-line, key-free message. */
function readKeyFile(label, filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (e) {
    throw new RotationError(`Cannot read ${label} ${filePath}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  try {
    return deriveKeys(parseKeyHex(text));
  } catch (e) {
    throw new RotationError(e instanceof EncryptionKeyError ? `${label}: ${e.message}` : String(e));
  }
}

class RotationError extends Error {}

/** A refusal raised before the rotation transaction opens: exit 3. */
class RotationRefusedError extends RotationError {}

// Mirrors resolveProvider in src/lib/db/provider.ts exactly.
function resolveProvider(rawProvider, databaseUrl) {
  const explicit = (rawProvider ?? "").trim().toLowerCase();
  if (explicit) return explicit === "sqlite" ? "sqlite" : "postgres";
  return (databaseUrl ?? "").trim().toLowerCase().startsWith("file:") ? "sqlite" : "postgres";
}

// Mirrors loadPrismaClient in src/lib/prisma.ts exactly.
function loadPrismaClient() {
  if (resolveProvider(process.env.DB_PROVIDER, process.env.DATABASE_URL) === "sqlite") {
    return require(".prisma/client-sqlite").PrismaClient;
  }
  return require("@prisma/client").PrismaClient;
}

/** A row this script could not rotate — names the model, id and field, so an admin can find it. */
class RotationFieldError extends Error {
  constructor(model, id, field, cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot rotate ${model}.${field} for id ${id}: ${reason}`, { cause });
    this.name = "RotationFieldError";
  }
}

/**
 * Re-encrypts every registered field of one model under the new key,
 * paging through the table by id (never loading it whole), and returns the
 * number of rows that had at least one field changed. Runs entirely on `tx`.
 *
 * decryptValue throws EncryptionKeyError (KEY_MISMATCH if the row's key id
 * is not the old key's, MALFORMED if it is not bv2: ciphertext at all) —
 * wrapped as RotationFieldError (naming the row) and left to propagate, so
 * the whole transaction rolls back: a row rotation cannot partially succeed.
 *
 * `updatedAt` is written back unchanged — rotating a row's
 * encryption is not an edit, the same rule src/lib/encryption/startup.ts's
 * encryption migration follows for the same reason ("recently updated"
 * lists must not all jump to the rotation time).
 */
async function rotateModel(tx, model, delegate, fields, oldKeys, newKeys) {
  const hasFingerprint = fields.some((f) => f.fingerprint);
  const select = {
    id: true,
    updatedAt: true,
    ...(hasFingerprint ? { serialNumberHash: true } : {}),
    ...Object.fromEntries(fields.map((f) => [f.field, true])),
  };

  let cursor;
  let updated = 0;
  for (;;) {
    const rows = await tx[delegate].findMany({
      select,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      const data = {};
      for (const f of fields) {
        const stored = row[f.field];
        if (stored === null || stored === undefined) continue;
        const aad = aadFor(f.model, f.field);
        let plaintext;
        try {
          plaintext = decryptValue(oldKeys, aad, stored);
        } catch (e) {
          throw new RotationFieldError(model, row.id, f.field, e);
        }
        data[f.field] = encryptValue(newKeys, aad, plaintext);
        if (f.fingerprint) data.serialNumberHash = fingerprint(newKeys, plaintext);
      }
      if (Object.keys(data).length > 0) {
        await tx[delegate].update({ where: { id: row.id }, data: { ...data, updatedAt: row.updatedAt } });
        updated++;
      }
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return updated;
}

/**
 * Erases the OLD-key ciphertext the rotation left in the
 * database's free space, then clears AppSettings.encryptionCompactionPending.
 * Runs only after the commit, and NEVER fails the run (a committed rotation exits 0): any error
 * is a warning, and the still-set marker makes the app's next start retry.
 */
async function compactAfterRotation(raw) {
  try {
    const result = await compactDatabase(raw, resolveProvider(process.env.DB_PROVIDER, process.env.DATABASE_URL));
    await clearCompactionPending(raw);
    console.log("Compacted the database (removed old-key ciphertext from free space).");
    if (!result.statisticsCompacted) {
      console.error(
        "Warning: PostgreSQL did not let this database role rewrite pg_statistic; run VACUUM FULL pg_statistic as a superuser.",
      );
    }
  } catch (e) {
    console.error(
      `Warning: rotation committed, but compacting the database failed: ${describeFailure(e)}. ` +
        "Old-key ciphertext may remain in free space; BlackVault retries the compaction on its next start.",
    );
  }
}

// ─── Uploaded files ────────────────────────────────────────────────
// fsp.* is always called through the imported namespace object (never
// destructured), same rule as src/lib/files/storage.ts, so the test fixtures
// (scripts/rotate-encryption-key.*.preload.cjs) can patch it.

/** Mirrors uploadsRoot in src/lib/files/storage.ts exactly: `IMAGE_UPLOAD_DIR` when set, else `<cwd>/uploads`. */
export function uploadsRoot(env = process.env) {
  return env.IMAGE_UPLOAD_DIR ? path.resolve(env.IMAGE_UPLOAD_DIR) : path.join(process.cwd(), "uploads");
}

/** Mirrors DIR_FSYNC_TOLERATED_CODES in src/lib/files/storage.ts. */
const DIR_FSYNC_TOLERATED_CODES = new Set(["EPERM", "EISDIR", "EINVAL"]);

/** Header bytes needed to classify a file — mirrors CLASSIFY_BYTES in src/lib/files/startup.ts. */
const CLASSIFY_BYTES = 41;

const ROT_SUFFIX = ".rot";

/** Mirrors writeFull in src/lib/files/storage.ts: loops on short writes; no forward progress throws. */
async function writeFull(handle, bytes) {
  let written = 0;
  while (written < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, written, bytes.length - written);
    if (bytesWritten <= 0) throw new Error("writeAtomic: write() made no forward progress (0 bytes written)");
    written += bytesWritten;
  }
}

async function syncDir(dir) {
  try {
    const dirHandle = await fsp.open(dir, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch (e) {
    if (!e?.code || !DIR_FSYNC_TOLERATED_CODES.has(e.code)) throw e;
  }
}

/**
 * Mirrors writeAtomic in src/lib/files/storage.ts exactly: `<absPath>.<8 random
 * hex>.tmp` opened "wx" mode 0600, chmod 0600, full write, fsync, rename, dir
 * fsync. The temp is removed on any failure up to the rename, so a full disk
 * leaves no partial file. For a `.rot` target the temp is
 * `<name>.rot.<8hex>.tmp`, which startup's sweep (/\.[0-9a-f]{8}\.tmp$/) removes.
 */
async function writeAtomic(absPath, bytes) {
  const tmpPath = `${absPath}.${randomBytes(4).toString("hex")}.tmp`;
  const handle = await fsp.open(tmpPath, "wx", 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await writeFull(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }
  try {
    await fsp.rename(tmpPath, absPath);
  } catch (e) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw e;
  }
  await syncDir(path.dirname(absPath));
}

function symlinkedFolderRefusal(abs) {
  return new RotationRefusedError(
    `${abs} is a symbolic link to a folder inside the uploads folder; BlackVault does not follow links there, so the ` +
      "files behind it could not be rotated. Replace the link with a real folder, then rotate again. Nothing was changed.",
  );
}

/**
 * Every regular file under `root` — mirrors walk() in src/lib/files/startup.ts:
 * sorted, never following a symlink, never entering a hidden folder (which
 * includes the `.pre-encryption-*` snapshots). A symlinked folder refuses
 * (exit 3), as it refuses the app's start. A missing root is no files.
 */
async function walkUploads(root) {
  const files = [];
  async function visit(dir, isRoot) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (isRoot && e?.code === "ENOENT") return;
      throw new RotationError(`Cannot read the uploads folder ${dir}: ${e?.code ?? describeFailure(e)}. Nothing was changed.`);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.name.startsWith(".") && !e.isFile()) continue;
      if (e.isSymbolicLink()) {
        let isDir = false;
        try {
          isDir = (await fsp.stat(abs)).isDirectory();
        } catch {
          isDir = false; // dangling: never followed
        }
        if (isDir) throw symlinkedFolderRefusal(abs);
      } else if (e.isDirectory()) await visit(abs, false);
      else if (e.isFile()) files.push({ abs, name: e.name });
    }
  }
  await visit(root, true);
  return files;
}

async function readHead(abs) {
  const handle = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(CLASSIFY_BYTES);
    let got = 0;
    while (got < CLASSIFY_BYTES) {
      const { bytesRead } = await handle.read(buf, got, CLASSIFY_BYTES - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  } finally {
    await handle.close();
  }
}

/** The BVF1 key id of `head`, or null when the header is damaged. */
function keyIdOrNull(head) {
  try {
    return fileKeyId(head);
  } catch {
    return null;
  }
}

/**
 * Classifies every uploaded file. Candidates follow startup.ts's isCandidate:
 * not hidden, not a `.tmp` or `.rot` work file. Plaintext candidates are left
 * alone (the app's startup encrypts them under whatever key is current).
 * `rot` is every non-hidden `.rot` file, with its key id (null if damaged).
 */
async function scanUploads(root, oldKeys, newKeys) {
  const out = { old: [], new: [], neither: [], rot: [] };
  for (const f of await walkUploads(root)) {
    if (f.name.startsWith(".")) continue;
    const isRot = f.name.endsWith(ROT_SUFFIX);
    if (!isRot && f.name.endsWith(".tmp")) continue;
    let head;
    try {
      head = await readHead(f.abs);
    } catch (e) {
      throw new RotationError(`Cannot read the uploaded file ${f.abs}: ${e?.code ?? describeFailure(e)}. Nothing was changed.`);
    }
    if (isRot) {
      out.rot.push({ ...f, keyId: isEncryptedFile(head) ? keyIdOrNull(head) : null });
      continue;
    }
    if (!isEncryptedFile(head)) continue;
    const id = keyIdOrNull(head);
    if (id === oldKeys.id) out.old.push(f);
    else if (id === newKeys.id) out.new.push(f);
    else out.neither.push({ ...f, keyId: id });
  }
  return out;
}

/** The up-front file refusals (exit 3): nothing has been written yet. */
function refuseOnFiles(scan, oldKeys, newKeys) {
  if (scan.neither.length) {
    const first = scan.neither[0];
    const more = scan.neither.length > 1 ? ` (and ${scan.neither.length - 1} more)` : "";
    const what = first.keyId
      ? `is encrypted with key ${first.keyId}, which is neither the old key ${oldKeys.id} nor the new key ${newKeys.id}`
      : "starts like an encrypted file but its header is damaged";
    throw new RotationRefusedError(
      `The uploaded file ${first.abs} ${what}${more}; refusing to rotate. Nothing was changed. ` +
        "Restore it from a backup, or move it out of the uploads folder, then rotate again.",
    );
  }
  const unfinished = scan.rot.find((r) => r.keyId === oldKeys.id);
  if (unfinished) {
    throw new RotationRefusedError(
      `${unfinished.abs} is staging from an earlier key rotation that has not been finished yet; refusing to rotate. ` +
        "Nothing was changed. Start BlackVault once (its startup finishes that rotation), then rotate again.",
    );
  }
}

/**
 * Stage one file: decrypt under the old key, re-encrypt under the new key with
 * the ORIGINAL basename as AAD, prove the result decrypts back to the same
 * bytes, then write `<abs>.rot` atomically. Never touches `abs`.
 */
async function stageFile(f, oldKeys, newKeys) {
  const basename = path.basename(f.abs);
  const rot = `${f.abs}${ROT_SUFFIX}`;
  try {
    const stored = await fsp.readFile(f.abs);
    const plain = decryptFile(oldKeys, basename, stored);
    const staged = encryptFile(newKeys, basename, plain);
    if (!decryptFile(newKeys, basename, staged).equals(plain)) throw new Error("round-trip check failed");
    await writeAtomic(rot, staged);
  } catch (e) {
    throw new RotationError(
      `Cannot stage the re-encrypted copy ${rot} of ${f.abs}: ${e?.code ?? describeFailure(e)}. ` +
        "Nothing was changed (free disk space or fix the folder's permissions, then rotate again).",
    );
  }
  return { abs: f.abs, rot };
}

/** Before-commit failure: delete every `.rot` this run staged. Their originals are untouched, so none is the only copy. */
async function discardStaged(staged) {
  const left = [];
  for (const s of staged) {
    try {
      await fsp.rm(s.rot, { force: true });
    } catch {
      left.push(s.rot);
    }
  }
  if (left.length) {
    console.error(
      `Warning: could not remove ${left.length} staged file(s), e.g. ${left[0]}. They are not used; BlackVault removes them on its next start.`,
    );
  }
}

/**
 * After the commit: each `.rot` over its original, then each folder fsynced.
 * Never throws (a committed rotation exits 0). Anything left is
 * finished by src/lib/files/startup.ts on the app's next start with the new key.
 */
async function finaliseStaged(staged) {
  const dirs = new Set();
  const failed = [];
  for (const s of staged) {
    try {
      await fsp.rename(s.rot, s.abs);
      dirs.add(path.dirname(s.abs));
    } catch (e) {
      failed.push({ s, code: e?.code ?? describeFailure(e) });
    }
  }
  for (const dir of dirs) {
    try {
      await syncDir(dir);
    } catch (e) {
      console.error(`Warning: rotation committed, but syncing the folder ${dir} failed: ${e?.code ?? describeFailure(e)}.`);
    }
  }
  if (failed.length) {
    console.error(
      `Warning: rotation committed, but ${failed.length} re-encrypted file(s) could not be put in place yet ` +
        `(first: ${failed[0].s.rot}: ${failed[0].code}). BlackVault finishes them when it next starts with the new key; ` +
        "do not delete the .rot files.",
    );
  }
  return staged.length - failed.length;
}

/** One line describing any failure — never the key material, never a stack trace (callers of this CLI see one line). */
function describeFailure(e) {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/\s+/g, " ");
}

/** True iff `keys` decrypts `check` to exactly the fixed key-check plaintext. Never throws. */
function opensKeyCheck(keys, check) {
  try {
    return decryptValue(keys, KEY_CHECK_AAD, check) === KEY_CHECK_PLAINTEXT;
  } catch {
    return false;
  }
}

/**
 * Read-only: which key currently opens AppSettings.encryptionKeyCheck —
 * "OLD", "NEW" or "NEITHER" — or throws when it cannot tell.
 * Opens and closes its own Prisma client; never writes.
 */
async function runProbe(oldKeys, newKeys) {
  const PrismaClient = loadPrismaClient();
  const raw = new PrismaClient();
  try {
    const settings = await raw.appSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { encryptionKeyCheck: true },
    });
    const check = settings?.encryptionKeyCheck ?? null;
    if (!check) {
      throw new RotationError("No encryption key check found; cannot determine which key the database is under.");
    }
    if (opensKeyCheck(newKeys, check)) return "NEW";
    if (opensKeyCheck(oldKeys, check)) return "OLD";
    return "NEITHER";
  } finally {
    // A disconnect failure here is not evidence of anything: the probe
    // already has its answer (or already failed) before this runs.
    await raw.$disconnect().catch(() => {});
  }
}

/**
 * Does the rotation. Exits 0 IFF `raw.$transaction` resolves:
 * `committed` is set the instant that happens, and every statement
 * after it — printing the summary, `$disconnect` — is not allowed to flip
 * `process.exitCode` away from its 0 default; a failure there is logged as
 * a warning instead. So a `$disconnect` that throws right after a real
 * commit still exits 0, not 1.
 */
async function rotate(oldKeys, newKeys) {
  const PrismaClient = loadPrismaClient();
  const raw = new PrismaClient();
  let committed = false;
  /** `{ abs, rot }` for every `.rot` this run wrote. */
  const staged = [];
  try {
    // Refuse before touching anything unless the OLD key opens this
    // database's key check (field-encryption spec §3: "The script refuses
    // to run if the stored key check does not match the current key.").
    const settings = await raw.appSettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { encryptionKeyCheck: true },
    });
    const check = settings?.encryptionKeyCheck ?? null;
    if (!check) {
      throw new RotationRefusedError(
        "No encryption key check found (AppSettings.encryptionKeyCheck is empty); refusing to rotate. " +
          "Has BlackVault been started at least once with a key?",
      );
    }
    if (!opensKeyCheck(oldKeys, check)) {
      throw new RotationRefusedError(
        "The old key does not match this database's encryption key check; refusing to rotate. Nothing was changed.",
      );
    }

    // Files, step 1: classify every uploaded file, refuse up front on one
    // under neither key, then stage the old-key files as `.rot` copies.
    const scan = await scanUploads(uploadsRoot(), oldKeys, newKeys);
    refuseOnFiles(scan, oldKeys, newKeys);
    for (const f of scan.old) staged.push(await stageFile(f, oldKeys, newKeys));

    const counts = await raw.$transaction(async (tx) => {
      const out = {};
      for (const { model, delegate, fields } of MODELS) {
        out[model] = await rotateModel(tx, model, delegate, fields, oldKeys, newKeys);
      }

      const newCheck = encryptValue(newKeys, KEY_CHECK_AAD, KEY_CHECK_PLAINTEXT);
      // encryptionCompactionPending: set in the same transaction, so a
      // compaction that fails below (or never runs) is retried by the app's
      // next start (src/lib/encryption/startup.ts compactIfPending).
      await tx.appSettings.update({
        where: { id: SETTINGS_ID },
        data: { encryptionKeyCheck: newCheck, encryptionCompactionPending: true },
      });

      // KEY_ROTATED, written directly on the raw transaction client — this
      // plain-JS script cannot import src/lib/audit/record.ts's
      // writeAuditEvent, so this mirrors the exact row shape it produces
      // (same column names, same JSON.stringify(changes)), the way
      // scripts/admin-reset-link.mjs writes its own RESET_LINK_ISSUED row.
      // actor is null/"system (key rotation)" per the spec; never the key
      // ids' source key material, only the 8-hex-char key ids (safe to log —
      // see core.mjs: "It is logged and stored; the key itself never is.").
      await tx.auditEvent.create({
        data: {
          actorId: null,
          actorName: "system (key rotation)",
          actorIp: null,
          action: "KEY_ROTATED",
          entityType: null,
          entityId: null,
          entityLabel: null,
          changes: JSON.stringify({ from: oldKeys.id, to: newKeys.id, counts: out, files: staged.length }),
        },
      });

      return out;
    }, ROTATION_TX);
    committed = true; // from here on, a failure is a warning, never exitCode=1.

    const summary = Object.entries(counts).map(([m, n]) => `${m} ${n}`).join(", ");
    try {
      console.log(`Rotated encryption key ${oldKeys.id} -> ${newKeys.id} (${summary}).`);
    } catch (e) {
      console.error(`Warning: rotation committed, but printing the summary failed: ${describeFailure(e)}`);
    }
    // Files, step 3: only now are the staged copies put in place.
    const finalised = await finaliseStaged(staged);
    if (staged.length) {
      try {
        console.log(`Re-encrypted ${finalised} uploaded files under the new key.`);
      } catch {
        // stdout gone: the files are in place; nothing to report it to.
      }
    }
    await compactAfterRotation(raw);
  } catch (e) {
    if (committed) {
      console.error(`Warning: rotation committed, but a post-commit step failed: ${describeFailure(e)}`);
    } else {
      // The transaction did not commit, so the staged copies must go.
      await discardStaged(staged);
      console.error(describeFailure(e));
      process.exitCode = e instanceof RotationRefusedError ? 3 : 1;
    }
  } finally {
    try {
      await raw.$disconnect();
    } catch (e) {
      if (committed) {
        console.error(`Warning: rotation committed, but disconnecting from the database afterwards failed: ${describeFailure(e)}`);
      } else {
        console.error(describeFailure(e));
        if (process.exitCode !== 3) process.exitCode = 1; // an up-front refusal stays a refusal
      }
    }
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    usage();
    process.exitCode = 2;
    return;
  }

  let oldKeys;
  let newKeys;
  try {
    oldKeys = readKeyFile("--old-key-file", parsed.oldKeyFile);
    newKeys = readKeyFile("--new-key-file", parsed.newKeyFile);
  } catch (e) {
    console.error(describeFailure(e));
    process.exitCode = 1;
    return;
  }

  if (parsed.probe) {
    let answer;
    try {
      answer = await runProbe(oldKeys, newKeys);
    } catch (e) {
      console.error(describeFailure(e));
      process.exitCode = 1;
      return;
    }
    // A second line with the file counts. Counted before anything is
    // printed, and any warning goes out only AFTER the answer line, so the
    // answer is always line 1 even when `compose run` merges stderr into a TTY.
    let filesLine = null;
    let filesWarning = null;
    try {
      const scan = await scanUploads(uploadsRoot(), oldKeys, newKeys);
      filesLine = `FILES old=${scan.old.length} new=${scan.new.length} rot=${scan.rot.length}`;
    } catch (e) {
      filesWarning = `Warning: could not count the uploaded files: ${describeFailure(e)}`;
    }
    console.log(answer);
    if (filesLine) console.log(filesLine);
    if (filesWarning) console.error(filesWarning);
    process.exitCode = 0;
    return;
  }

  await rotate(oldKeys, newKeys);
}

// Only run when executed directly (`node scripts/rotate-encryption-key.mjs`),
// never when imported — scripts/rotate-encryption-key.test.ts imports this
// module's ENCRYPTED_FIELDS to assert it matches the real registry, and must
// not trigger a live run (with no --old-key-file/--new-key-file, that would
// just exit 2, but running it as a side effect of an import is still wrong).
// process.argv[1] is whatever path was typed on the command line (often
// relative, e.g. "scripts/rotate-encryption-key.mjs"), while import.meta.url
// is always absolute — path.resolve() against the current cwd is what makes
// the two comparable.
function isDirectRun() {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error(describeFailure(e));
    process.exitCode = 1;
  });
}
