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
//   - replaces AppSettings.encryptionKeyCheck;
//   - writes one KEY_ROTATED audit event.
// A failure anywhere rolls the whole transaction back: no row and no key
// file changes. The script itself never touches the key files on disk —
// that is rotate-key.sh/.bat's job (step 6 of the spec's rotation list).
//
// Usage: node scripts/rotate-encryption-key.mjs --old-key-file <path> --new-key-file <path>
//   exit 0  success — one line naming the old/new key ids (never the keys) and row counts
//   exit 1  refusal or failure — one line on stderr; nothing changed
//   exit 2  usage error
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
  console.error("Usage: node scripts/rotate-encryption-key.mjs --old-key-file <path> --new-key-file <path>");
}

function parseArgs(argv) {
  let oldKeyFile;
  let newKeyFile;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--old-key-file") oldKeyFile = argv[++i];
    else if (a === "--new-key-file") newKeyFile = argv[++i];
    else return null;
  }
  if (!oldKeyFile || !newKeyFile) return null;
  return { oldKeyFile, newKeyFile };
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

/**
 * Re-encrypts every registered field of one model under the new key,
 * paging through the table by id (never loading it whole), and returns the
 * number of rows that had at least one field changed. Runs entirely on `tx`.
 *
 * decryptValue throws EncryptionKeyError (KEY_MISMATCH if the row's key id
 * is not the old key's, MALFORMED if it is not bv2: ciphertext at all) —
 * left to propagate so the whole transaction rolls back: a row rotation
 * cannot partially succeed.
 */
async function rotateModel(tx, model, delegate, fields, oldKeys, newKeys) {
  const hasFingerprint = fields.some((f) => f.fingerprint);
  const select = {
    id: true,
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
        const plaintext = decryptValue(oldKeys, aad, stored);
        data[f.field] = encryptValue(newKeys, aad, plaintext);
        if (f.fingerprint) data.serialNumberHash = fingerprint(newKeys, plaintext);
      }
      if (Object.keys(data).length > 0) {
        await tx[delegate].update({ where: { id: row.id }, data });
        updated++;
      }
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE_SIZE) break;
  }
  return updated;
}

/** One line describing any failure — never the key material, never a stack trace (callers of this CLI see one line). */
function describeFailure(e) {
  const message = e instanceof Error ? e.message : String(e);
  return message.replace(/\s+/g, " ");
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

  const PrismaClient = loadPrismaClient();
  const raw = new PrismaClient();
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
    let opensWithOldKey;
    try {
      opensWithOldKey = decryptValue(oldKeys, KEY_CHECK_AAD, check) === KEY_CHECK_PLAINTEXT;
    } catch {
      opensWithOldKey = false;
    }
    if (!opensWithOldKey) {
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
      await tx.appSettings.update({ where: { id: SETTINGS_ID }, data: { encryptionKeyCheck: newCheck } });

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

    const summary = Object.entries(counts).map(([m, n]) => `${m} ${n}`).join(", ");
    console.log(`Rotated encryption key ${oldKeys.id} -> ${newKeys.id} (${summary}).`);
  } catch (e) {
    console.error(describeFailure(e));
    process.exitCode = 1;
  } finally {
    await raw.$disconnect();
  }
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
