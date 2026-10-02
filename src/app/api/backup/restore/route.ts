import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/server/auth";
import { withoutRowAudit } from "@/lib/audit/context";
import { recordEventBestEffort } from "@/lib/audit/events";
import { runConfiguredDateMigration } from "@/lib/date-migration";
import { BACKUP_MODELS, REQUIRED_BACKUP_KEYS } from "@/lib/backup/models";
import {
  isKnownNfaClass,
  normalizeAccessoryNfaFields,
  normalizeFirearmNfaFields,
} from "@/lib/nfa";
import { normalizeGearArmorFields } from "@/lib/gear";
import { openBackup, SealError } from "@/lib/encryption/core.mjs";
import { ENCRYPTED_FIELDS, encryptedFieldsFor } from "@/lib/encryption/fields";
import { configuredZone, decryptLegacyEnc, LegacyDecryptError, normalizeLegacyNfaDate } from "@/lib/encryption/startup";

type WriteDelegate = {
  deleteMany: () => Promise<unknown>;
  createMany: (args: { data: unknown[] }) => Promise<unknown>;
};

type BackupBody = { meta: { version: string } } & Record<string, unknown>;

/**
 * A backup needs `meta.version` and all 12 v1.0 keys as arrays. Only keys added
 * after v1.0 (maintenanceLogs, batteryChangeLogs, dateNormalizationAudits) may be
 * missing; they restore as empty. Any registered key that is present must be an
 * array. Restore replaces every table, so a partial payload must never pass.
 */
function isValidBackup(body: unknown): body is BackupBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (!b.meta || typeof (b.meta as Record<string, unknown>).version !== "string") return false;
  if (!REQUIRED_BACKUP_KEYS.every((key) => Array.isArray(b[key]))) return false;
  return BACKUP_MODELS.every(({ key }) => b[key] === undefined || Array.isArray(b[key]));
}

function isRowObject(row: unknown): row is Record<string, unknown> {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

/** `model` -> its backup payload key ("Firearm" -> "firearms"), for the models that hold an encrypted field. */
const ENCRYPTED_MODEL_KEYS: ReadonlyArray<{ model: string; key: string }> = [
  ...new Set(ENCRYPTED_FIELDS.map((f) => f.model)),
].map((model) => ({ model, key: BACKUP_MODELS.find((m) => m.model === model)!.key }));

/**
 * Carry M6 ("Old backups with pre-V1 values"): a backup written before the
 * field-encryption epic can still hold a pre-V1 `enc:...` value (the OLD,
 * now-removed `src/lib/crypto.ts` scheme) in an encrypted field — historically
 * only `serialNumber`. Restore writes go through the app Prisma client
 * (@/lib/prisma), whose encryption extension would otherwise encrypt the
 * literal string `"enc:..."` as if it were the serial. This decrypts every
 * such value with VAULT_ENCRYPTION_KEY FIRST, in place, so the extension then
 * encrypts the real plaintext with the CURRENT key.
 *
 * Mutates `rows` in place. Throws LegacyDecryptError (missing/wrong
 * VAULT_ENCRYPTION_KEY, or a damaged value) before any row is touched by the
 * caller's transaction — the restore must fail clean and change nothing.
 */
function decryptLegacyEncInRows(rows: Record<string, unknown[]>): void {
  for (const { model, key } of ENCRYPTED_MODEL_KEYS) {
    const fields = encryptedFieldsFor(model);
    rows[key] = rows[key].map((row) => {
      if (!isRowObject(row)) return row;
      let out: Record<string, unknown> | null = null;
      for (const d of fields) {
        const value = row[d.field];
        if (typeof value !== "string" || !value.startsWith("enc:")) continue;
        const plain = decryptLegacyEnc(value);
        out = { ...(out ?? row), [d.field]: plain };
      }
      return out ?? row;
    });
  }
}

/**
 * Carry ("DateNormalizationAudit rows"): an old backup can carry
 * DateNormalizationAudit rows the pre-encryption date migration wrote for
 * `nfaApprovalDate` (Firearm/Accessory) — plaintext copies of a column that
 * is now encrypted. The startup encryption migration
 * (src/lib/encryption/startup.ts, runEncryptionMigration) deliberately
 * deletes exactly these rows for the same reason; restore must not bring them
 * back. Rows for every OTHER model/field (e.g. a date-only inventory field)
 * are left alone.
 */
function dropLegacyNfaDateAudits(rows: Record<string, unknown[]>): void {
  const dropped = new Set(
    ENCRYPTED_FIELDS.filter((d) => d.kind === "date").map((d) => `${d.model}:${d.field}`),
  );
  rows.dateNormalizationAudits = (rows.dateNormalizationAudits ?? []).filter((row) => {
    if (!isRowObject(row)) return true;
    return !dropped.has(`${row.model}:${row.field}`);
  });
}

/** The models/keys/fields with a "date"-kind encrypted field (today: just Firearm.nfaApprovalDate and Accessory.nfaApprovalDate). */
const NFA_DATE_FIELDS = ENCRYPTED_FIELDS.filter((d) => d.kind === "date").map((d) => ({
  model: d.model,
  field: d.field,
  key: BACKUP_MODELS.find((m) => m.model === d.model)!.key,
}));

/**
 * Review I1: an old backup's `nfaApprovalDate` can be a legacy instant that
 * is not at UTC midnight (a pre-normalisation value, from before the
 * date-only rule existed). Restoring it used to take the encryption
 * extension's lexical UTC-day read, which silently drops a day in any
 * UTC-ahead zone. This instead applies the exact same rule the startup
 * encryption migration uses (`normalizeLegacyNfaDate`, shared — see its
 * docblock) — the owner's configured zone, defaulting to UTC — BEFORE
 * `normalizeNfaGroups` runs, so the NFA-paperwork normaliser then sees an
 * already-correct value (its own `toDateOnlyUTC` call becomes a no-op).
 *
 * Replaces the row's value with a `Date` object (the app-facing shape for
 * this field) only when present and in a recognised form; `null`/`undefined`
 * and anything already a non-string-non-number (shouldn't occur from JSON,
 * handled defensively) pass through untouched.
 */
async function normalizeLegacyNfaDatesInRows(rows: Record<string, unknown[]>): Promise<void> {
  const zone = await configuredZone(prisma);
  for (const { model, field, key } of NFA_DATE_FIELDS) {
    rows[key] = rows[key].map((row) => {
      if (!isRowObject(row)) return row;
      const value = row[field];
      if (value === null || value === undefined) return row;
      if (typeof value !== "string" && typeof value !== "number") return row;
      return { ...row, [field]: normalizeLegacyNfaDate(model, field, value, zone) };
    });
  }
}

/**
 * Detects the sealed-restore shape on `sealed` alone (review M7): requiring
 * `passphrase` too meant `{ sealed }` with no passphrase fell through to the
 * plain-backup path and failed as "Invalid backup file…" — a sealed envelope
 * is never a valid PLAIN backup body, so that was always a misleading error.
 * The passphrase-presence check right below gives the specific message.
 */
function isSealedRequest(body: unknown): body is { sealed: unknown; passphrase?: unknown } {
  return typeof body === "object" && body !== null && !Array.isArray(body) && "sealed" in body;
}

/**
 * Re-derives the NFA group on the firearm and accessory rows of a backup.
 *
 * The spec requires the clearing rules to hold "however the write arrives",
 * and restore is a write path: it hands uploaded JSON straight to createMany
 * with no per-row validation beyond "is it an array". So a hand-edited or
 * foreign backup carrying
 * `{ nfaClass: "NONE", nfaTransferMethod: "FORM_4", nfaControlNumber: "12345" }`
 * restored exactly that, and the row then showed a full NFA card on
 * /vault/[id] and exported paperwork under a Title I platform.
 *
 * Running the same normalizers the write routes use makes the rules hold by
 * construction rather than by trusting the file. Only the NFA group is
 * touched; every other column is copied verbatim, because a restore is meant
 * to be faithful and the rows it replaces came from a database these routes
 * kept consistent.
 *
 * The SQLite→Postgres migrator deliberately does NOT do this: a faithful
 * whole-row copy is its entire job, and it verifies the rows it wrote.
 *
 * A firearm whose stored class is not one THIS BUILD KNOWS is passed through
 * untouched, class and paperwork alike. Normalizing it would coerce the class
 * to NONE and take mgRegistry and all five paperwork columns with it —
 * silently, on a data-recovery path, which is exactly the outcome the write
 * routes now answer 400 for rather than perform. And it is not a
 * hand-edited-file scenario: a backup written by a later build that added an
 * NFA class is the case src/lib/categories.ts's catch-all section documents
 * and deliberately accommodates ("a backup written by a later version that
 * added a class this build lacks"). Phase 1 chose "visible in the wrong-ish
 * place" over "silently altered"; restore now agrees with it. Backups whose
 * classes this build understands are still normalized, which is the hole this
 * function was written to close.
 */
function normalizeNfaGroups(rows: Record<string, unknown[]>): void {
  rows.firearms = rows.firearms.map((row) => {
    if (!isRowObject(row)) return row;
    const classIsPresent = row.nfaClass !== undefined && row.nfaClass !== null;
    if (classIsPresent && !isKnownNfaClass(row.nfaClass)) return row;
    return { ...row, ...normalizeFirearmNfaFields(row) };
  });
  rows.accessories = rows.accessories.map((row) =>
    isRowObject(row)
      ? { ...row, ...normalizeAccessoryNfaFields(row.type, row) }
      : row
  );
}

/**
 * Re-derives the armor group (`protectionLevel`, `armorSize`) on the gear rows
 * of a backup, for the same reason and by the same rule as normalizeNfaGroups
 * above: restore is an unvalidated write path, and the clearing rules have to
 * hold however the write arrives. Without this, a hand-edited backup restores
 * `{ category: "KNIFE", protectionLevel: "IV" }` — invisible on the detail
 * page, which gates the cells on the category, and PRINTED by the full-armory
 * export, which deliberately does not.
 *
 * `body: {}` means "change nothing, just re-decide": the merged category is
 * the row's own stored category, so this only ever clears, never writes a
 * rating the file did not carry.
 *
 * WHO decides "this build does not understand this category" is
 * normalizeGearArmorFields, not this function. Its gate already passes an
 * unrecognised category through untouched, and that single judgement is the
 * one the write routes use, so restore cannot drift into a second, stricter
 * copy of the rule — the mistake an earlier phase of this epic made with the
 * NFA class, silently declassifying firearms whose class came from a later
 * build. A non-string category is likewise handed back unchanged: it is not
 * something this build can judge either.
 */
function normalizeGearArmorGroups(rows: Record<string, unknown[]>): void {
  rows.gear = rows.gear.map((row) => {
    if (!isRowObject(row) || typeof row.category !== "string") return row;
    return {
      ...row,
      ...normalizeGearArmorFields({
        existing: {
          category: row.category,
          protectionLevel:
            typeof row.protectionLevel === "string" ? row.protectionLevel : null,
          armorSize: typeof row.armorSize === "string" ? row.armorSize : null,
        },
        body: {},
      }),
    };
  });
}

/** Longest file name recorded, in characters (code points). Typical filesystem limit. */
const MAX_BACKUP_FILENAME = 255;

/**
 * The backup file name for the RESTORE event (spec §Restore), from the
 * client-supplied `X-Backup-Filename` header. The header is UNTRUSTED: it is
 * URI-decoded (malformed → ignored), reduced to its basename (a client could
 * send a full path), stripped of C0/C1 control characters (no CR/LF or
 * terminal escapes in the log or the CSV), trimmed and capped at 255
 * characters. `undefined` when the header is absent (API callers, older
 * clients) or nothing usable remains; the restore itself never depends on it.
 */
function backupFileName(request: NextRequest): string | undefined {
  const raw = request.headers.get("x-backup-filename");
  if (raw === null) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // C0/C1 controls, plus Unicode format and line/paragraph separators
  // (e.g. U+202E right-to-left override) that would make the name display
  // misleadingly in the log and the CSV.
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  const base = cleaned.split(/[\\/]/).pop() ?? "";
  const capped = Array.from(base.trim()).slice(0, MAX_BACKUP_FILENAME).join("").trim();
  return capped === "" ? undefined : capped;
}

/**
 * Review round 2, M2 follow-up: the original `/^P2\d{3}$/` match was too
 * broad. It also matched P2024 (timed out fetching a connection from the
 * pool), P2028 (a transaction API error — e.g. the transaction already
 * closed) and P2034 (a transaction failed due to a write conflict or
 * deadlock, safe to retry) — none of those are about the uploaded FILE's
 * content, and calling them 400 would misreport a real infrastructure
 * problem as "your backup file is bad."
 *
 * This is an explicit ALLOW-list instead: only Prisma Client error codes
 * that mean "the data itself doesn't fit the schema" (Prisma 5.22 error
 * reference, https://www.prisma.io/docs/orm/reference/error-reference).
 * Restore only ever calls `deleteMany`/`createMany` with no relational
 * connects or raw queries, so not every content code below is reachable in
 * practice today, but each is still a genuine "bad data" code, never an
 * infra one, so including it is safe:
 *
 * - P2000  The provided value for a column is too long for the column's type.
 * - P2001  The record searched for does not exist (a `where` target is missing).
 * - P2002  Unique constraint failed (e.g. a duplicate serial's fingerprint).
 * - P2003  Foreign key constraint failed on a field.
 * - P2004  A constraint failed on the database.
 * - P2005  The stored value is invalid for the field's type.
 * - P2006  The provided value is not valid for the field.
 * - P2007  Data validation error.
 * - P2011  Null constraint violation on a field.
 * - P2012  Missing a required value.
 * - P2013  Missing a required argument.
 * - P2014  The change would violate a required relation between two records.
 * - P2019  Input error (a nested write's input doesn't satisfy a constraint).
 * - P2020  Value out of range for the field's type.
 *
 * Deliberately EXCLUDED: P2008/P2009/P2010/P2016 (query building/parsing —
 * a bug, not file content), P2015/P2017/P2018 (relation lookups — restore
 * does no relational connects), P2021/P2022 (schema/column mismatch — a
 * real schema-drift bug), P2024/P2028/P2034 (connection pool timeout,
 * transaction API error, write conflict — infrastructure, not content; the
 * review's own example, P2028, is proven to stay 500 below), P2025 (a record
 * an update/delete/connect depends on was not found — restore only calls
 * deleteMany and createMany, which never raise it, so it could only mean a
 * concurrent change or a bug, never file content), and anything outside
 * P2xxx entirely.
 */
const RESTORE_CONTENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "P2000", "P2001", "P2002", "P2003", "P2004", "P2005", "P2006", "P2007",
  "P2011", "P2012", "P2013", "P2014", "P2019", "P2020",
]);

/**
 * Whether `error` is a CONTENT problem with the uploaded file — a duplicate
 * serial, a wrong type on a column, a non-string serial (review M2) — rather
 * than a genuine server fault. These shapes are everything the write
 * transaction below can throw for bad file content:
 * - our own `TypeError` (the encryption extension's `serialize()`, or
 *   `normalizeLegacyNfaDate` above, both throw a templated TypeError for a
 *   value of the wrong shape);
 * - `PrismaClientValidationError` (a non-encrypted column typed wrong —
 *   `.name` only, duck-typed like the code check below: the SQLite and
 *   Postgres clients each ship their own error classes, so `instanceof`
 *   against one would miss the other);
 * - a Prisma "known request" error whose `.code` is in the allow-list above
 *   (the pattern `@/lib/auth/route-helpers.ts`'s `isUniqueViolation`
 *   already uses for P2002 alone, generalised here to the rest of the
 *   content-error family — and ONLY that family).
 * Anything else (a real outage, a timeout, a bug) is left to stay a 500.
 */
function isRestoreContentError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== "object" || error === null) return false;
  const e = error as { name?: unknown; code?: unknown };
  if (e.name === "PrismaClientValidationError") return true;
  return typeof e.code === "string" && RESTORE_CONTENT_ERROR_CODES.has(e.code);
}

/**
 * Logs a restore write failure WITHOUT the failing row's data (review M1):
 * error name, code (when present) and which model was being written when it
 * happened — never the error's own `.message` for a `PrismaClientValidationError`,
 * whose message IS the full pretty-printed invocation (every field of every
 * row in the failing write — proven by reproducing it directly against the
 * SQLite client). Every other shape reaching here (our own TypeError, or a
 * PrismaClientKnownRequestError like P2002) has a templated message that
 * names a field or column, never a value, so logging it is safe.
 */
function logRestoreError(error: unknown, model: string | null): void {
  const e = error as { name?: unknown; code?: unknown };
  const name = typeof e?.name === "string" ? e.name : error instanceof Error ? error.constructor.name : typeof error;
  const code = typeof e?.code === "string" ? e.code : undefined;
  const message =
    name === "PrismaClientValidationError"
      ? "(message omitted: a PrismaClientValidationError's message embeds the failing row's full data)"
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`POST /api/backup/restore error: ${name}${code ? ` ${code}` : ""} on ${model ?? "(unknown model)"}: ${message}`);
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Sealed restore (spec §Restore): `{ sealed: <envelope>, passphrase }`. The
  // plain-backup path below is unchanged for everything else, including an
  // old v1.1 (or earlier) file that was never sealed.
  let body: unknown;
  let sealed: boolean;
  if (isSealedRequest(rawBody)) {
    const { sealed: envelope, passphrase } = rawBody;
    if (typeof passphrase !== "string") {
      return NextResponse.json({ error: "Passphrase is required." }, { status: 400 });
    }
    let opened: string;
    try {
      opened = openBackup(passphrase, envelope);
    } catch (error) {
      if (error instanceof SealError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
    try {
      body = JSON.parse(opened);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    sealed = true;
  } else {
    body = rawBody;
    sealed = false;
  }

  if (!isValidBackup(body)) {
    return NextResponse.json(
      { error: "Invalid backup file. Missing required fields or wrong format." },
      { status: 400 }
    );
  }

  const rows: Record<string, unknown[]> = Object.fromEntries(
    BACKUP_MODELS.map(({ key }) => [key, (body[key] as unknown[] | undefined) ?? []])
  );

  // Carry M6: a legacy enc: serial must be decrypted BEFORE anything is
  // written — this throws (and writes nothing) when VAULT_ENCRYPTION_KEY is
  // missing or wrong for a value that needs it.
  try {
    decryptLegacyEncInRows(rows);
  } catch (error) {
    if (error instanceof LegacyDecryptError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  // Review I1: zone-correct a legacy non-midnight NFA date BEFORE the NFA
  // group is (re)normalised below, which reads whatever value is already
  // there. An unparseable date here is a content problem with the file, not
  // a server fault — 400, and nothing has been written yet.
  try {
    await normalizeLegacyNfaDatesInRows(rows);
  } catch (error) {
    if (error instanceof TypeError) {
      return NextResponse.json(
        { error: "Invalid backup file. An NFA approval date could not be read." },
        { status: 400 },
      );
    }
    throw error;
  }

  normalizeNfaGroups(rows);
  normalizeGearArmorGroups(rows);
  dropLegacyNfaDateAudits(rows);

  // Row-level auditing is off for the whole restore — the replace AND the
  // post-restore date migration — or every restored row (and every normalised
  // legacy date) would be logged as the admin's own edit. The restore is
  // recorded as one RESTORE event instead (spike, "Restore: suppression covers
  // the whole handler").
  type RestoreOutcome = { ok: true } | { ok: false; status: 400 | 500; error: string };

  const restored = await withoutRowAudit(async (): Promise<RestoreOutcome> => {
    let failingModel: string | null = null;
    try {
      await prisma.$transaction(
        async (tx) => {
          const delegates = tx as unknown as Record<string, WriteDelegate>;
          // Sequential throughout — SQLite connection_limit=1 deadlocks on Promise.all.
          // Delete children before parents (registry reversed), then insert parent-first.
          // AppSettings is not in the registry, so it is never touched — preserves LAN/path config.
          for (const { delegate } of [...BACKUP_MODELS].reverse()) {
            failingModel = delegate;
            await delegates[delegate].deleteMany();
          }
          for (const { delegate, key } of BACKUP_MODELS) {
            failingModel = delegate;
            if (rows[key].length) await delegates[delegate].createMany({ data: rows[key] });
          }
        },
        { timeout: 30000 }
      );
    } catch (error) {
      logRestoreError(error, failingModel);
      // Review M2: a content problem with the uploaded file (a duplicate
      // serial, a wrong type on a column) is a 400 with a safe, generic
      // message — the transaction already rolled back, same as the 500
      // case, so "nothing was modified" holds either way. Anything else
      // (unclassified) stays a 500: it may be a genuine server fault.
      return isRestoreContentError(error)
        ? {
            ok: false,
            status: 400,
            error: "The backup file's data could not be restored: it does not match what this version of BlackVault expects.",
          }
        : { ok: false, status: 500, error: "Restore failed. Your data has not been modified." };
    }

    // A pre-upgrade backup brings legacy date-only values back; normalize them now
    // rather than at the next restart. The restore has already succeeded, so a
    // migration failure is only logged and never changes the response.
    try {
      await runConfiguredDateMigration("restore");
    } catch (error) {
      console.error("[date-migration] failed after restore:", error);
    }
    return { ok: true };
  });

  if (!restored.ok) {
    return NextResponse.json({ error: restored.error }, { status: restored.status });
  }

  const counts = Object.fromEntries(BACKUP_MODELS.map(({ key }) => [key, rows[key].length]));
  // Written OUTSIDE withoutRowAudit — restore replaces every row and normalises
  // legacy dates under suppression (or every row would get its own entry
  // attributed to the admin); this single event, recorded afterward, IS logged.
  const file = backupFileName(request);
  await recordEventBestEffort(null, {
    action: "RESTORE",
    entityLabel: file ?? "Backup restore",
    changes: file ? { file, counts, sealed } : { counts, sealed },
  });

  return NextResponse.json({
    success: true,
    counts,
  });
}
