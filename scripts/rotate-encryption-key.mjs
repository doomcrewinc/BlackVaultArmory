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
// After the commit it compacts the database (final review F1: VACUUM on
// SQLite, VACUUM FULL + ANALYZE on PostgreSQL, src/lib/encryption/compaction.mjs)
// so the OLD-key ciphertext does not linger in free space, then clears the
// marker. Best-effort: a failure is a warning (exit stays 0) and the app's
// next start retries it, because the marker is still set.
// A failure anywhere rolls the whole transaction back: no row and no key
// file changes. The script itself never touches the key files on disk —
// that is rotate-key.sh/.bat's job (step 6 of the spec's rotation list).
//
// Usage: node scripts/rotate-encryption-key.mjs --old-key-file <path> --new-key-file <path>
//   exit 0  success — one line naming the old/new key ids (never the keys) and row counts.
//           Exits 0 IFF the transaction committed (fix round 1, C1): a failure AFTER that
//           point (closing the DB connection, a broken stdout pipe) is printed as a
//           warning, never turns a committed rotation into a non-zero exit — the wrapper's
//           --probe mode, not this exit code, is what tells a caller "did it commit?" when
//           something fails around the edges of a run.
//   exit 1  refusal, or a failure BEFORE commit — one line on stderr; nothing changed
//   exit 2  usage error
//
// Probe mode: node scripts/rotate-encryption-key.mjs --probe --old-key-file <path> --new-key-file <path>
//   Read-only. Prints exactly one of OLD, NEW or NEITHER (which key currently opens
//   AppSettings.encryptionKeyCheck) and exits 0. Exits non-zero (nothing printed on
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

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseKeyHex, deriveKeys, encryptValue, decryptValue, fingerprint, EncryptionKeyError,
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

/** A row this script could not rotate — names the model, id and field, so an admin can find it (fix round 1, M4). */
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
 * `updatedAt` is written back unchanged (fix round 1, I4) — rotating a row's
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
 * Final review F1: erases the OLD-key ciphertext the rotation left in the
 * database's free space, then clears AppSettings.encryptionCompactionPending.
 * Runs only after the commit, and NEVER fails the run (C1 ruling): any error
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
 * "OLD", "NEW" or "NEITHER" — or throws when it cannot tell (fix round 1,
 * C1). Opens and closes its own Prisma client; never writes.
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
 * Does the rotation. Exits 0 IFF `raw.$transaction` resolves (fix round 1,
 * C1): `committed` is set the instant that happens, and every statement
 * after it — printing the summary, `$disconnect` — is not allowed to flip
 * `process.exitCode` away from its 0 default; a failure there is logged as
 * a warning instead. This is what makes the reviewer's injection (making
 * $disconnect throw right after a real commit) exit 0 instead of 1.
 */
async function rotate(oldKeys, newKeys) {
  const PrismaClient = loadPrismaClient();
  const raw = new PrismaClient();
  let committed = false;
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
      throw new RotationError(
        "No encryption key check found (AppSettings.encryptionKeyCheck is empty); refusing to rotate. " +
          "Has BlackVault been started at least once with a key?",
      );
    }
    if (!opensKeyCheck(oldKeys, check)) {
      throw new RotationError(
        "The old key does not match this database's encryption key check; refusing to rotate. Nothing was changed.",
      );
    }

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
          changes: JSON.stringify({ from: oldKeys.id, to: newKeys.id, counts: out }),
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
    await compactAfterRotation(raw);
  } catch (e) {
    if (committed) {
      console.error(`Warning: rotation committed, but a post-commit step failed: ${describeFailure(e)}`);
    } else {
      console.error(describeFailure(e));
      process.exitCode = 1;
    }
  } finally {
    try {
      await raw.$disconnect();
    } catch (e) {
      if (committed) {
        console.error(`Warning: rotation committed, but disconnecting from the database afterwards failed: ${describeFailure(e)}`);
      } else {
        console.error(describeFailure(e));
        process.exitCode = 1;
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
    try {
      console.log(await runProbe(oldKeys, newKeys));
      process.exitCode = 0;
    } catch (e) {
      console.error(describeFailure(e));
      process.exitCode = 1;
    }
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
