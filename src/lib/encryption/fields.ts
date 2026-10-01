/**
 * The registry of which schema columns are encrypted at rest (field-encryption
 * spec, docs/superpowers/specs/2026-09-30-field-encryption-design.md, D1).
 *
 * This is the one place that lists them. The encryption extension (Task 3)
 * drives its writes/reads off this list, a guard test below confirms every
 * entry is backed by a `String` column in the Prisma schema (ciphertext can
 * only live in a text column), and another guard test fails if any raw SQL
 * anywhere in the app mentions one of these columns (raw SQL bypasses the
 * extension entirely, so it would read/write ciphertext as if it were plain
 * text).
 *
 * `kind` says what the plaintext actually is, independent of the column's SQL
 * type (which is always String once encrypted):
 *   - "string": stored and returned as-is.
 *   - "date":   `nfaApprovalDate`. The column is a type-changed `DateTime` ->
 *               `String` (see the migration). The extension serializes a Date
 *               to an ISO string before encrypting and parses it back on read,
 *               so application code keeps seeing `Date | null` (Task 3).
 *   - "number": `nfaTaxPaid`. Same idea for the type-changed `Float` -> `String`
 *               column: serialized as a JSON number before encrypting, parsed
 *               back to `number | null` on read.
 *
 * `fingerprint: true` marks the one field per model (`serialNumber`) that also
 * gets an HMAC fingerprint column (`serialNumberHash`) so equality lookups
 * keep working without decrypting every row.
 *
 * P3 (SQLite DateTime representation, recorded here per the plan): the real
 * prisma/prisma/dev.db has no NFA firearm, so a scratch copy (never the real
 * file) was seeded with one through the actual SQLite Prisma client — the
 * same writer the app uses — then inspected directly with sqlite3, BEFORE
 * running the 20260930000000_field_encryption migration:
 *
 *   select typeof(nfaApprovalDate), nfaApprovalDate,
 *          typeof(nfaTaxPaid), nfaTaxPaid
 *     from Firearm where nfaApprovalDate is not null;
 *   -- integer|1790380800000|real|200.0
 *
 * i.e. this repo's SQLite writer stores `DateTime` as integer milliseconds
 * since the epoch, not ISO text (confirmed the same for pre-existing rows'
 * `acquisitionDate`), and `Float` as `real`.
 *
 * AFTER running the migration against that same scratch copy (`prisma
 * migrate deploy`, never the real dev.db), the SAME query against the SAME
 * row returns:
 *
 *   text|1790380800000|text|200.0
 *   -- quote(nfaApprovalDate) = '1790380800000' (13-char numeric string)
 *   -- quote(nfaTaxPaid)      = '200.0'
 *
 * The values are NOT byte-identical: SQLite's `ALTER TABLE` on a
 * type-changing column is implemented as a table rebuild (`CREATE
 * new_Firearm (... TEXT ...); INSERT INTO new_Firearm SELECT * FROM
 * Firearm; ...` — see the migration), and that `INSERT` applies the new
 * column's TEXT affinity, coercing the stored INTEGER/REAL to their decimal
 * string form. So on THIS database, after the migration, `nfaApprovalDate`
 * holds the numeric string `"1790380800000"` (epoch milliseconds as text,
 * no decimal point, no ISO formatting), and `nfaTaxPaid` holds `"200.0"`.
 *
 * Task 4's startup encryption migration must therefore accept, for
 * `nfaApprovalDate`: a numeric string of epoch milliseconds (what this
 * database's data actually is, post-migration) and an ISO string (the other
 * case plan note P3 anticipates, e.g. from a differently-written install);
 * and for `nfaTaxPaid`: a numeric string (`"200.0"` here) or a bare number.
 */

export type EncryptedFieldKind = "string" | "date" | "number";

export interface EncryptedFieldDescriptor {
  model: "Firearm" | "Accessory" | "Gear";
  delegate: "firearm" | "accessory" | "gear";
  field: string;
  kind: EncryptedFieldKind;
  fingerprint?: true;
}

/** D1: the exact set of encrypted fields. Nothing else is encrypted. */
export const ENCRYPTED_FIELDS: ReadonlyArray<EncryptedFieldDescriptor> = [
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
] as const;

export function encryptedFieldsFor(model: string): ReadonlyArray<EncryptedFieldDescriptor> {
  return ENCRYPTED_FIELDS.filter((f) => f.model === model);
}

export function isEncryptedField(model: string, field: string): boolean {
  return ENCRYPTED_FIELDS.some((f) => f.model === model && f.field === field);
}

/** The AAD bound into every ciphertext: `<Model>.<field>`, e.g. "Firearm.serialNumber". */
export function aadFor(model: string, field: string): string {
  return `${model}.${field}`;
}
