import { createDecipheriv } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  decryptValue, encryptValue, envelopeKeyId, fingerprint, isEncrypted, EncryptionKeyError, type FieldKeys,
} from "./core.mjs";
import { aadFor, ENCRYPTED_FIELDS, encryptedFieldsFor, type EncryptedFieldDescriptor } from "./fields";
import { encodeForStorage, parsePlaintextValue } from "./extension";
import { getFieldKeys } from "./keys";
import { SYSTEM_ACTOR } from "../audit/context";
import { writeAuditEvent } from "../audit/record";
import { redactStoredChanges } from "../audit/redact";
import { isValidTimeZone, normalizeInstant } from "../date-migration";

/**
 * Startup steps for field encryption at rest
 * (docs/superpowers/specs/2026-09-30-field-encryption-design.md §2, "Startup
 * sequence"), run by src/instrumentation.ts before the app serves:
 *
 * 1. assertEncryptionKey: load the key and verify it (read-only).
 * 2. runEncryptionMigration: encrypt every pre-encryption value, once, in one
 *    transaction.
 *
 * Both take a RAW client (createRawPrismaClient in src/lib/prisma.ts, ruling
 * R1): they read and write the stored form itself, which the app client's
 * extension would refuse (strict reads) or re-encrypt. Every failure throws —
 * the caller refuses to start.
 *
 * Imports stay relative (no `@/`): scripts load this under plain ts-node.
 */

const KEY_CHECK_PLAINTEXT = "blackvault-key-check";
const KEY_CHECK_AAD = "AppSettings.encryptionKeyCheck";
const SETTINGS_ID = "singleton";
const LEGACY_PREFIX = "enc:";

type Row = Record<string, unknown> & { id: string };
type Delegate = {
  findFirst(args: unknown): Promise<Row | null>;
  findMany(args: unknown): Promise<Row[]>;
  update(args: unknown): Promise<unknown>;
};
type RawClient = PrismaClient;
type AuditDelegate = Delegate & { create(args: unknown): Promise<unknown> };
type RawTx = Record<string, Delegate> & { auditEvent: AuditDelegate };

function delegateOf(client: unknown, d: Pick<EncryptedFieldDescriptor, "delegate">): Delegate {
  return (client as Record<string, Delegate>)[d.delegate];
}

/** The models that hold an encrypted field, in registry order, with their fields. */
const ENCRYPTED_MODELS: ReadonlyArray<{ model: string; delegate: string; fields: ReadonlyArray<EncryptedFieldDescriptor> }> = [
  ...new Set(ENCRYPTED_FIELDS.map((f) => f.model)),
].map((model) => {
  const fields = encryptedFieldsFor(model);
  return { model, delegate: fields[0].delegate, fields };
});

// ─── Errors ─────────────────────────────────────────────────────

/**
 * A row the encryption migration could not convert. The whole migration has
 * been rolled back; the message names the row and field and how to fix it.
 */
export class EncryptionMigrationError extends Error {
  readonly model: string | null;
  readonly id: string | null;
  readonly field: string | null;

  constructor(message: string, where: { model?: string; id?: string; field?: string } = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "EncryptionMigrationError";
    this.model = where.model ?? null;
    this.id = where.id ?? null;
    this.field = where.field ?? null;
  }
}

/** A legacy `enc:` value that cannot be read: VAULT_ENCRYPTION_KEY missing, invalid or wrong, or the value damaged. */
export class LegacyDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyDecryptError";
  }
}

// ─── Legacy `enc:` values ───────────────────────────────────────

/**
 * Decrypts a pre-V1 `enc:<iv b64>:<ciphertext b64>:<tag b64>` value
 * (AES-256-GCM under the hex key in VAULT_ENCRYPTION_KEY) — a port of
 * decryptField in src/lib/crypto.ts, which that module returned as
 * "[unreadable — wrong key?]" on failure. This throws instead: the migration
 * must never encrypt an error string as if it were the serial.
 */
export function decryptLegacyEnc(stored: string, env: Record<string, string | undefined> = process.env): string {
  if (!stored.startsWith(LEGACY_PREFIX)) throw new LegacyDecryptError("Not a legacy enc: value.");
  const hex = (env.VAULT_ENCRYPTION_KEY ?? "").trim();
  if (!hex) {
    throw new LegacyDecryptError("VAULT_ENCRYPTION_KEY is not set; it is needed to read this legacy enc: value.");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new LegacyDecryptError("VAULT_ENCRYPTION_KEY is invalid: it must be 64 hex characters.");
  }
  const parts = stored.slice(LEGACY_PREFIX.length).split(":");
  if (parts.length !== 3) throw new LegacyDecryptError("The legacy enc: value is malformed.");
  const [ivB64, ctB64, tagB64] = parts;
  const tag = Buffer.from(tagB64, "base64");
  if (tag.length !== 16) throw new LegacyDecryptError("The legacy enc: value is malformed (tag length).");
  try {
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hex, "hex"), Buffer.from(ivB64, "base64"), {
      authTagLength: 16,
    });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new LegacyDecryptError("VAULT_ENCRYPTION_KEY is wrong, or the legacy enc: value is damaged.");
  }
}

// ─── Key check ──────────────────────────────────────────────────

/** Every stored `bv2:` value of every registered field, with the AAD it was sealed under. Read-only. */
async function encryptedValues(raw: RawClient): Promise<Array<{ aad: string; stored: string }>> {
  const out: Array<{ aad: string; stored: string }> = [];
  for (const d of ENCRYPTED_FIELDS) {
    const rows = await delegateOf(raw, d).findMany({
      where: { [d.field]: { startsWith: "bv2:" } },
      select: { [d.field]: true },
    });
    for (const r of rows) out.push({ aad: aadFor(d.model, d.field), stored: String(r[d.field]) });
  }
  return out;
}

/** The key id a `bv2:` value names, or null when it is malformed. */
function idOf(stored: string): string | null {
  try {
    return envelopeKeyId(stored);
  } catch {
    return null;
  }
}

/**
 * The key id this database is already encrypted with — from the key check,
 * else the first `bv2:` value — or null for a database with no encrypted
 * data. Read-only (used to word KEY_MISSING).
 */
async function existingKeyId(raw: RawClient): Promise<string | null> {
  const settings = await raw.appSettings.findUnique({ where: { id: SETTINGS_ID }, select: { encryptionKeyCheck: true } });
  const fromCheck = settings?.encryptionKeyCheck ? idOf(settings.encryptionKeyCheck) : null;
  if (fromCheck) return fromCheck;
  for (const d of ENCRYPTED_FIELDS) {
    const hit = await delegateOf(raw, d).findFirst({
      where: { [d.field]: { startsWith: "bv2:" } },
      select: { [d.field]: true },
    });
    const id = hit ? idOf(String(hit[d.field])) : null;
    if (id) return id;
  }
  return null;
}

/** Loads the key; on KEY_MISSING against an already-encrypted database, says to restore the original key instead of generating one. */
async function loadKeys(raw: RawClient): Promise<FieldKeys> {
  try {
    return getFieldKeys();
  } catch (e) {
    if (!(e instanceof EncryptionKeyError) || e.code !== "KEY_MISSING") throw e;
    const id = await existingKeyId(raw);
    if (!id) throw e;
    throw new EncryptionKeyError(
      "KEY_MISSING",
      `${e.message.replace(/\s*Generate one with:.*$/, "")} This database is already encrypted: ` +
        `restore the original key file (key id ${id}). Do not generate a new key; it cannot read this data.`,
    );
  }
}

function mismatch(expected: string, provided: string): EncryptionKeyError {
  return new EncryptionKeyError(
    "KEY_MISMATCH",
    `Wrong encryption key: this database was encrypted with key ${expected}, but the provided key is ${provided}. ` +
      "Start with the key this database was encrypted with.",
  );
}

/**
 * Steps 1 + 2 of the startup sequence. READ-ONLY: the key check itself is
 * created inside the encryption migration's transaction
 * (runEncryptionMigration), so it can never exist unless encryption
 * succeeded with that key.
 *
 * Loads the key (EncryptionKeyError KEY_MISSING / KEY_INVALID / KEY_CONFLICT
 * from core.mjs), then:
 * - a key check that does not open with this key: KEY_MISMATCH, naming the
 *   expected and the provided key id;
 * - no key check, and `bv2:` values exist (e.g. a database filled by
 *   `prisma db seed` before its first start):
 *   - any value under another key id: KEY_MISMATCH naming that id;
 *   - else one of them decrypts with this key: the key is proven, and the
 *     migration creates the check (self-heal);
 *   - else nothing can be verified: KEY_CHECK_LOST.
 */
export async function assertEncryptionKey(raw: RawClient): Promise<void> {
  const keys = await loadKeys(raw);
  const settings = await raw.appSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { encryptionKeyCheck: true },
  });
  const check = settings?.encryptionKeyCheck ?? null;

  if (check !== null) {
    try {
      if (decryptValue(keys, KEY_CHECK_AAD, check) === KEY_CHECK_PLAINTEXT) return;
    } catch {
      // Falls through to the mismatch error below.
    }
    throw mismatch(idOf(check) ?? "unknown", keys.id);
  }

  const values = await encryptedValues(raw);
  if (values.length === 0) return;
  const foreign = values.map((v) => idOf(v.stored)).find((id) => id !== null && id !== keys.id);
  if (foreign) throw mismatch(foreign, keys.id);
  for (const v of values) {
    try {
      decryptValue(keys, v.aad, v.stored);
      return; // proven; the migration recreates the check
    } catch {
      // try the next one
    }
  }
  throw new EncryptionKeyError(
    "KEY_CHECK_LOST",
    `The encryption key check (AppSettings.encryptionKeyCheck) is missing, and none of the database's encrypted ` +
      `values can be read with the provided key (${keys.id}). Refusing to start: start with the key this database ` +
      "was encrypted with, or restore the pre-upgrade database snapshot in backups/.",
  );
}

// ─── Encryption migration ───────────────────────────────────────

/**
 * A pre-encryption `nfaApprovalDate` value (fields.ts P3 forms: an ISO
 * string, an epoch-ms string, or a bare number), parsed and — if it is a
 * legacy instant NOT at UTC midnight — corrected to its calendar day in
 * `zone`: the rule `runLegacyDateMigration` would have applied, except the
 * date migration skips the encrypted NFA fields (src/lib/date-migration.ts).
 *
 * THE ONE place this rule lives (review I1): both the startup encryption
 * migration (`plaintextOf`, below) and the restore route's carry for the
 * same values arriving in an old backup call this function, rather than
 * each keeping its own copy of the midnight check — restore had drifted
 * from this exact rule once already (it used the field-encryption
 * extension's lexical UTC-day read instead, which ignores the owner's
 * zone for a non-midnight legacy instant).
 */
export function normalizeLegacyNfaDate(model: string, field: string, stored: string | number, zone: string): Date {
  const value = parsePlaintextValue(model, field, stored);
  if (!(value instanceof Date)) {
    // Only ever called for the "date" kind field (nfaApprovalDate); a
    // registry/caller bug, not reachable for real backup data.
    throw new TypeError(`${model}.${field} did not parse to a date`);
  }
  return value.getTime() % 86_400_000 !== 0 ? normalizeInstant(value, zone) : value;
}

/** The application value of one pre-encryption stored value, or a thrown error naming why it is unreadable. */
function plaintextOf(d: EncryptedFieldDescriptor, stored: string | number, zone: string): string | Date | number {
  const text = typeof stored === "string" && stored.startsWith(LEGACY_PREFIX) ? decryptLegacyEnc(stored) : stored;
  if (d.kind === "date") return normalizeLegacyNfaDate(d.model, d.field, text, zone);
  return parsePlaintextValue(d.model, d.field, text);
}

/**
 * A client with the minimal shape this needs to read `AppSettings.timezone`
 * — structurally satisfied by both the raw client (this module's own
 * `RawClient`) and the app client the restore route uses, so the two can
 * share this instead of each keeping their own copy of "read the configured
 * zone, default to UTC".
 */
type ZoneReader = { appSettings: { findUnique(args: unknown): Promise<{ timezone: string | null } | null> } };

/** The configured zone for date normalisation: AppSettings.timezone when valid, else UTC. */
export async function configuredZone(tx: ZoneReader): Promise<string> {
  const settings = await tx.appSettings.findUnique({ where: { id: SETTINGS_ID }, select: { timezone: true } });
  const zone = settings?.timezone;
  return zone && isValidTimeZone(zone) ? zone : "UTC";
}

/** Converts one row: the `update` data for its pre-encryption fields, or null when it has none. */
function encryptRow(model: string, fields: ReadonlyArray<EncryptedFieldDescriptor>, row: Row, zone: string) {
  const data: Record<string, string | null> = {};
  for (const d of fields) {
    const stored = row[d.field];
    if (stored === null || stored === undefined || isEncrypted(stored)) continue;
    let value: string | Date | number;
    try {
      value = plaintextOf(d, stored as string | number, zone);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const hint =
        e instanceof LegacyDecryptError
          ? " Set VAULT_ENCRYPTION_KEY to the key the pre-V1 build used, then start again."
          : " Correct the value, then start again.";
      throw new EncryptionMigrationError(
        `Cannot encrypt ${model}.${d.field} for id ${row.id}: ${reason}${hint}`,
        { model, id: row.id, field: d.field },
        e,
      );
    }
    data[d.field] = encodeForStorage(model, d.field, value);
    if (d.fingerprint) data.serialNumberHash = fingerprint(getFieldKeys(), value as string);
  }
  return Object.keys(data).length ? data : null;
}

/**
 * Firearm serials are unique (by fingerprint). Two legacy `enc:` values have
 * different ciphertext for the same serial, so the old unique index never
 * saw such a pair; it surfaces here. Refuses naming both rows (never the
 * serial itself), before anything is written.
 */
function assertNoDuplicateSerial(rows: Row[], updates: Array<{ row: Row; data: Record<string, string | null> }>) {
  const newHash = new Map(updates.filter((u) => "serialNumberHash" in u.data).map((u) => [u.row.id, u.data.serialNumberHash]));
  const owner = new Map<string, string>();
  for (const row of rows) {
    const hash = newHash.has(row.id) ? newHash.get(row.id) : (row.serialNumberHash as string | null);
    if (!hash) continue;
    const first = owner.get(hash);
    if (first) {
      throw new EncryptionMigrationError(
        `Firearms ${first} and ${row.id} have the same serial number once their legacy encrypted serials are read, ` +
          "and serial numbers must be unique. Refusing to start: run the previous BlackVault version, edit the serial " +
          "of one of them or remove the duplicate, then upgrade again.",
        { model: "Firearm", id: row.id, field: "serialNumber" },
      );
    }
    owner.set(hash, row.id);
  }
}

// ─── Audit-log scrub (Task 4b) ───────────────────────────────────

/** Rows per page when scanning AuditEvent — bounds memory; connection_limit=1 bounds itself (one tx, one connection). */
const AUDIT_SCRUB_PAGE = 500;

/**
 * Scrubs plaintext NFA values out of existing AuditEvent rows (spec 2b
 * predates the NFA fields' redaction, so rows written before this branch may
 * still hold them in `changes`). Runs inside the SAME transaction as the
 * encryption migration, on the raw client: the app client's audit extension
 * makes AuditEvent append-only (src/lib/audit/extension.ts), and that guard
 * must stay for ordinary application code — only this one-time startup step,
 * on the unextended raw client, may rewrite an AuditEvent row.
 *
 * Pages through the table by id (never loads it all into memory at once),
 * re-serialising each row's `changes` with `redactStoredChanges` in the exact
 * format `writeAuditEvent` writes it (`JSON.stringify`), and updates only
 * rows whose serialised result differs from what is stored — so a row with
 * nothing sensitive (LOGIN, a plain CREATE, `changes: null`) is never
 * touched, and a second run touches nothing. Returns the number of rows
 * changed.
 */
async function scrubAuditEvents(tx: RawTx): Promise<number> {
  let scrubbed = 0;
  let cursor: string | undefined;

  for (;;) {
    const rows: Array<{ id: string; changes: string | null }> = (await tx.auditEvent.findMany({
      where: { changes: { not: null } },
      select: { id: true, changes: true },
      orderBy: { id: "asc" },
      take: AUDIT_SCRUB_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })) as unknown as Array<{ id: string; changes: string | null }>;
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.changes === null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.changes);
      } catch {
        continue; // not JSON (should not happen: writeAuditEvent always JSON.stringifies); leave it alone
      }
      const serialised = JSON.stringify(redactStoredChanges(parsed));
      if (serialised !== row.changes) {
        await tx.auditEvent.update({ where: { id: row.id }, data: { changes: serialised } });
        scrubbed++;
      }
    }

    cursor = rows[rows.length - 1].id;
    if (rows.length < AUDIT_SCRUB_PAGE) break;
  }

  return scrubbed;
}

/** Long enough for a large inventory on slow storage; the server is not serving yet. */
const MIGRATION_TX = { maxWait: 10_000, timeout: 600_000 } as const;

/**
 * Step 4 of the startup sequence: encrypts every registered field that is
 * non-null and not yet `bv2:`, fills `serialNumberHash`, and writes one
 * ENCRYPTION_ENABLED audit event (actor `system`, `changes: { counts, keyId }`)
 * when anything changed — all in ONE transaction on the raw client, so any
 * failure leaves every row as it was. Legacy `enc:` values are decrypted with
 * VAULT_ENCRYPTION_KEY first.
 *
 * In the same transaction it creates the key check when absent (never
 * before: a failed first run must not pin the database to its key), and
 * deletes DateNormalizationAudit rows for the encrypted NFA dates (plaintext
 * copies). A duplicate firearm serial is refused before any write.
 *
 * Idempotent: a second run finds nothing to convert and writes nothing.
 *
 * Afterwards it asserts that every row with a serial has a fingerprint (carry
 * M4: a NULL `serialNumberHash` bypasses the duplicate-serial unique index and
 * makes the serial unfindable); if not, it throws and the transaction rolls
 * back.
 *
 * Uses only the transaction client while the transaction is open: on SQLite
 * `connection_limit=1` a second connection would wait on the write lock.
 */
export async function runEncryptionMigration(raw: RawClient): Promise<{ counts: Record<string, number> }> {
  const keys = getFieldKeys();
  return raw.$transaction(async (txClient) => {
    const tx = txClient as unknown as RawClient & RawTx;
    const zone = await configuredZone(tx);
    const counts: Record<string, number> = {};

    for (const { model, fields } of ENCRYPTED_MODELS) {
      const hasFingerprint = fields.some((d) => d.fingerprint);
      const select = Object.fromEntries([
        ["id", true],
        ["updatedAt", true],
        ...(hasFingerprint ? [["serialNumberHash", true]] : []),
        ...fields.map((d) => [d.field, true]),
      ]);
      const rows = await delegateOf(tx, fields[0]).findMany({ select, orderBy: { id: "asc" } });

      // Convert everything first, write after: a duplicate serial is found
      // before any write, not as a unique-index error halfway through.
      const updates: Array<{ row: Row; data: Record<string, string | null> }> = [];
      for (const row of rows) {
        const data = encryptRow(model, fields, row, zone);
        if (data) updates.push({ row, data });
      }
      if (model === "Firearm") assertNoDuplicateSerial(rows, updates);

      for (const { row, data } of updates) {
        try {
          // updatedAt kept: encrypting a row is not an edit, and "recently
          // updated" lists must not all jump to the upgrade time.
          await delegateOf(tx, fields[0]).update({ where: { id: row.id }, data: { ...data, updatedAt: row.updatedAt } });
        } catch (e) {
          throw new EncryptionMigrationError(
            `Cannot store the encrypted values of ${model} id ${row.id}: ${e instanceof Error ? e.message : String(e)}`,
            { model, id: row.id },
            e,
          );
        }
      }
      counts[model] = updates.length;
    }

    for (const { model, fields } of ENCRYPTED_MODELS) {
      if (!fields.some((d) => d.fingerprint)) continue;
      // Filtered here, not in `where`: Firearm.serialNumber is required, and
      // Prisma rejects `{ not: null }` on a required field.
      const missing = (
        await delegateOf(tx, fields[0]).findMany({
          where: { serialNumberHash: null },
          select: { id: true, serialNumber: true },
        })
      ).filter((r) => r.serialNumber !== null).length;
      if (missing > 0) {
        throw new EncryptionMigrationError(
          `${missing} ${model} row(s) have a serial number but no fingerprint (serialNumberHash). ` +
            "This indicates a bug. Refusing to start: restore the pre-upgrade database snapshot in backups/ and report it.",
          { model, field: "serialNumberHash" },
        );
      }
    }

    // The key check, created only here — inside the transaction that
    // encrypted the data — so a failed first migration never pins the
    // database to a key nothing was encrypted with (assertEncryptionKey has
    // already proven the key whenever encrypted values exist).
    const settings = await tx.appSettings.findUnique({ where: { id: SETTINGS_ID }, select: { encryptionKeyCheck: true } });
    if (!settings?.encryptionKeyCheck) {
      const created = encryptValue(keys, KEY_CHECK_AAD, KEY_CHECK_PLAINTEXT);
      await tx.appSettings.upsert({
        where: { id: SETTINGS_ID },
        create: { id: SETTINGS_ID, encryptionKeyCheck: created },
        update: { encryptionKeyCheck: created },
      });
    }

    // Earlier date-migration runs recorded NFA approval dates in
    // DateNormalizationAudit's plaintext DateTime columns. Those columns are
    // non-nullable DateTime, so they cannot hold a "[redacted]" marker; the
    // rows are deleted instead. Nothing reads them any more: the date
    // migration skips the encrypted dates.
    await tx.dateNormalizationAudit.deleteMany({
      where: { OR: ENCRYPTED_FIELDS.filter((d) => d.kind === "date").map((d) => ({ model: d.model, field: d.field })) },
    });

    // Task 4b: scrub plaintext NFA values out of existing audit entries.
    // Unconditional — this must happen even when there is no plaintext
    // inventory left to encrypt (an already-encrypted database can still
    // hold pre-redaction audit rows from spec 2b).
    const scrubbedAuditRows = await scrubAuditEvents(tx);

    if (Object.values(counts).some((n) => n > 0) || scrubbedAuditRows > 0) {
      await writeAuditEvent(tx, {
        action: "ENCRYPTION_ENABLED",
        actor: SYSTEM_ACTOR,
        changes: { counts, keyId: keys.id, scrubbedAuditRows },
      });
    }
    return { counts };
  }, MIGRATION_TX);
}

// ─── The startup hook ───────────────────────────────────────────

/**
 * The encryption part of src/instrumentation.ts's register(): opens a raw
 * client, checks the key, runs the migration, and closes the client (so no
 * extra connection outlives startup). Throws on any failure; the caller
 * refuses to start.
 */
export async function runEncryptionStartup(): Promise<{ counts: Record<string, number> }> {
  const { createRawPrismaClient } = await import("../prisma");
  const raw = createRawPrismaClient();
  try {
    await assertEncryptionKey(raw);
    const result = await runEncryptionMigration(raw);
    const changed = Object.entries(result.counts).filter(([, n]) => n > 0);
    if (changed.length) {
      console.log(`[encryption] Encrypted existing data: ${changed.map(([m, n]) => `${m} ${n}`).join(", ")}`);
    }
    return result;
  } finally {
    await raw.$disconnect();
  }
}

/** One log line for a startup failure: the error's own message (EncryptionKeyError / EncryptionMigrationError carry a fix hint). */
export function startupFailureLine(error: unknown): string {
  if (error instanceof EncryptionKeyError || error instanceof EncryptionMigrationError) {
    return `[encryption] ${error.message}`.replace(/\s+/g, " ");
  }
  const message = error instanceof Error ? error.message : String(error);
  return `[encryption] Startup failed, refusing to start: ${message} — fix the cause and start again.`.replace(/\s+/g, " ");
}
