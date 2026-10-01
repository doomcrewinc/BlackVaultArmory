import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, type PrismaClient } from "@prisma/client";
import { decryptValue, encryptValue, fingerprint, isEncrypted, type FieldKeys } from "./core.mjs";
import { aadFor, encryptedFieldsFor, type EncryptedFieldDescriptor } from "./fields";
import { getFieldKeys } from "./keys";
import { toDateOnlyUTC } from "../date";

/**
 * Field encryption at rest (docs/superpowers/specs/2026-09-30-field-encryption-design.md §2).
 *
 * A Prisma query extension that sits UNDER the audit extension
 * (`withAudit(withEncryption(base))`, src/lib/prisma.ts), so the audit layer
 * sees plaintext args and decrypted rows and redacts them, and only ciphertext
 * reaches the database. For every operation on every model it:
 *
 * - writes: encrypts each registered field (src/lib/encryption/fields.ts) in
 *   `data` / `create` / `update`, including nested relation writes at any
 *   depth, and sets `serialNumberHash` whenever `serialNumber` is written
 *   (`null` stays `null`, with a `null` hash);
 * - filters: rewrites `serialNumber` equality to the fingerprint column and
 *   throws EncryptedFieldQueryError for anything else that would compare,
 *   sort or group on ciphertext — in `where`, nested relation filters, unique
 *   keys, `orderBy`, `cursor`, `distinct`, `by` and the args of an
 *   `include`/`select` relation;
 * - reads: decrypts every registered field in the result in place, including
 *   nested `include`/`select` results; `nfaApprovalDate` comes back as a Date
 *   and `nfaTaxPaid` as a number. A value that fails to decrypt throws
 *   EncryptedFieldDecryptError; ciphertext is never returned.
 *
 * Prisma calls the hook only for top-level operations, never for nested
 * writes or includes, which is why everything below recurses by the schema's
 * relations (DMMF).
 *
 * Imports stay relative (no `@/`): src/lib/prisma.ts reaches this file and
 * scripts load that under plain ts-node.
 */

type Row = Record<string, unknown>;

export class EncryptedFieldQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptedFieldQueryError";
  }
}

export class EncryptedFieldDecryptError extends Error {
  readonly model: string;
  readonly id: string | null;
  readonly field: string;
  /** The underlying failure: "KEY_MISMATCH" or "MALFORMED" (EncryptionKeyError), else "DECRYPT_FAILED" (tampered / wrong AAD). */
  readonly code: string;

  constructor(model: string, id: string | null, field: string, cause: unknown) {
    const code =
      typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string"
        ? ((cause as { code: string }).code)
        : "DECRYPT_FAILED";
    super(`Cannot decrypt ${model}.${field} for id ${id ?? "(unknown)"}: ${code}`, { cause });
    this.name = "EncryptedFieldDecryptError";
    this.model = model;
    this.id = id;
    this.field = field;
    this.code = code;
  }
}

// ─── Schema metadata ────────────────────────────────────────────

/** relation field name -> related model name, per model. */
const RELATIONS = new Map<string, Map<string, string>>();
for (const m of Prisma.dmmf.datamodel.models) {
  RELATIONS.set(m.name, new Map(m.fields.filter((f) => f.kind === "object").map((f) => [f.name, f.type])));
}

function relationsOf(model: string): Map<string, string> {
  return RELATIONS.get(model) ?? new Map();
}

function descriptor(model: string, field: string): EncryptedFieldDescriptor | undefined {
  return encryptedFieldsFor(model).find((f) => f.field === field);
}

function requireDescriptor(model: string, field: string): EncryptedFieldDescriptor {
  const d = descriptor(model, field);
  if (!d) throw new Error(`${model}.${field} is not an encrypted field`);
  return d;
}

function isPlainObject(v: unknown): v is Row {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

const HASH_FIELD = "serialNumberHash";

// ─── Value codec (reused by Task 4's startup migration and the rotation script) ──

function serialize(d: EncryptedFieldDescriptor, value: unknown): string {
  switch (d.kind) {
    case "string":
      if (typeof value !== "string") throw new TypeError(`${d.model}.${d.field} must be a string`);
      return value;
    case "date": {
      // The date-only rule (src/lib/date.ts): the UTC calendar day of a Date,
      // or the Y-M-D a string starts with — stored as its UTC-midnight ISO form.
      if (!(value instanceof Date) && typeof value !== "string") {
        throw new TypeError(`${d.model}.${d.field} must be a Date`);
      }
      return toDateOnlyUTC(value).toISOString();
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`${d.model}.${d.field} must be a finite number`);
      }
      return JSON.stringify(value);
  }
}

function deserialize(d: EncryptedFieldDescriptor, text: string): string | Date | number {
  switch (d.kind) {
    case "string":
      return text;
    case "date": {
      // A numeric string is epoch milliseconds (legacy SQLite rows, fields.ts P3);
      // `new Date("1790380800000")` would be an Invalid Date.
      const date = /^-?\d+$/.test(text) ? new Date(Number(text)) : new Date(text);
      if (Number.isNaN(date.getTime())) throw new TypeError(`${d.model}.${d.field} holds an unreadable date`);
      return date;
    }
    case "number": {
      const n = Number(text);
      if (text.trim() === "" || !Number.isFinite(n)) throw new TypeError(`${d.model}.${d.field} holds an unreadable number`);
      return n;
    }
  }
}

function encodeWith(keys: FieldKeys, d: EncryptedFieldDescriptor, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return encryptValue(keys, aadFor(d.model, d.field), serialize(d, value));
}

/** The stored form of `value` for `model.field`: `bv2:` ciphertext, or null. */
export function encodeForStorage(model: string, field: string, value: unknown): string | null {
  const d = requireDescriptor(model, field);
  if (value === null || value === undefined) return null;
  return encodeWith(getFieldKeys(), d, value);
}

/**
 * The application value of a stored `model.field`: a string, a Date
 * (`nfaApprovalDate`) or a number (`nfaTaxPaid`), or null.
 *
 * A stored value that is not `bv2:` is a pre-encryption plaintext (the startup
 * migration, Task 4, converts those) and is returned as its application type,
 * not decrypted. A `bv2:` value that fails to decrypt throws
 * EncryptedFieldDecryptError (`code` says why: KEY_MISMATCH, MALFORMED,
 * DECRYPT_FAILED).
 */
export function decodeFromStorage(
  model: string,
  field: string,
  stored: unknown,
  id: string | null = null,
): string | Date | number | null {
  const d = requireDescriptor(model, field);
  if (stored === null || stored === undefined) return null;
  if (typeof stored !== "string") return stored as string | Date | number; // a pre-migration native value
  let text = stored;
  if (isEncrypted(stored)) {
    try {
      text = decryptValue(getFieldKeys(), aadFor(model, field), stored);
    } catch (e) {
      throw new EncryptedFieldDecryptError(model, id, field, e);
    }
  }
  try {
    return deserialize(d, text);
  } catch (e) {
    throw new EncryptedFieldDecryptError(model, id, field, e);
  }
}

// ─── Writes ─────────────────────────────────────────────────────

/** Scalar write value: a plain value, or the `{ set: value }` update form. */
function unwrapSet(value: unknown): { value: unknown; wrapped: boolean } {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === "set") return { value: value.set, wrapped: true };
    throw new EncryptedFieldQueryError(`Unsupported update operation on an encrypted field: ${keys.join(", ")}`);
  }
  return { value, wrapped: false };
}

/** Encrypts the registered fields of one create/update `data` object of `model`, recursing into nested writes. */
function encodeData(model: string, data: unknown): unknown {
  if (!isPlainObject(data)) return data;
  const out: Row = { ...data };
  for (const d of encryptedFieldsFor(model)) {
    if (!(d.field in data) || data[d.field] === undefined) continue;
    const { value } = unwrapSet(data[d.field]);
    const keys = value === null ? null : getFieldKeys();
    out[d.field] = keys ? encodeWith(keys, d, value) : null;
    if (d.fingerprint) out[HASH_FIELD] = keys ? fingerprint(keys, value as string) : null;
  }
  for (const [field, target] of relationsOf(model)) {
    if (data[field] !== undefined) out[field] = encodeNested(target, data[field]);
  }
  return out;
}

function each(value: unknown, fn: (v: unknown) => unknown): unknown {
  return Array.isArray(value) ? value.map(fn) : fn(value);
}

/** `{ where, data }` (to-many update/updateMany, to-one update with where) vs a bare to-one update `data`. */
function isWhereData(v: unknown): v is Row {
  return isPlainObject(v) && "data" in v && Object.keys(v).every((k) => k === "where" || k === "data");
}

/** A nested relation write (`create`, `connectOrCreate`, `upsert`, `update`, …) on the related `model`. */
function encodeNested(model: string, ops: unknown): unknown {
  if (!isPlainObject(ops)) return ops;
  const out: Row = { ...ops };
  for (const [op, arg] of Object.entries(ops)) {
    if (arg === undefined) continue;
    switch (op) {
      case "create":
        out[op] = each(arg, (v) => encodeData(model, v));
        break;
      case "createMany":
        out[op] = isPlainObject(arg) ? { ...arg, data: each(arg.data, (v) => encodeData(model, v)) } : arg;
        break;
      case "connectOrCreate":
        out[op] = each(arg, (v) =>
          isPlainObject(v) ? { ...v, where: rewriteWhere(model, v.where), create: encodeData(model, v.create) } : v,
        );
        break;
      case "upsert":
        out[op] = each(arg, (v) =>
          isPlainObject(v)
            ? {
                ...v,
                ...(v.where !== undefined && { where: rewriteWhere(model, v.where) }),
                create: encodeData(model, v.create),
                update: encodeData(model, v.update),
              }
            : v,
        );
        break;
      case "update":
      case "updateMany":
        out[op] = each(arg, (v) =>
          isWhereData(v)
            ? { ...v, ...(v.where !== undefined && { where: rewriteWhere(model, v.where) }), data: encodeData(model, v.data) }
            : encodeData(model, v),
        );
        break;
      case "connect":
      case "disconnect":
      case "set":
      case "delete":
      case "deleteMany":
        out[op] = each(arg, (v) => (isPlainObject(v) ? rewriteWhere(model, v) : v));
        break;
      default:
        break;
    }
  }
  return out;
}

// ─── Filters ────────────────────────────────────────────────────

function refuse(model: string, field: string, how: string): never {
  throw new EncryptedFieldQueryError(
    `${model}.${field} is encrypted: ${how} is not supported (only exact serialNumber equality can be queried).`,
  );
}

/** `field: value` in a `where` on an encrypted field: the fingerprint rewrite, a null check, or a refusal. */
function rewriteEncryptedCondition(model: string, d: EncryptedFieldDescriptor, value: unknown, out: Row) {
  // A null check is safe on ciphertext: a column is null exactly when its plaintext is.
  if (value === null) return;
  let operand: unknown = value;
  if (isPlainObject(value)) {
    const ops = Object.keys(value);
    if (ops.length === 1 && ops[0] === "not" && value.not === null) return;
    if (ops.length !== 1 || ops[0] !== "equals") refuse(model, d.field, `the filter "${ops.join(", ")}"`);
    operand = value.equals;
    if (operand === null) return;
  }
  if (!d.fingerprint) refuse(model, d.field, "an equality filter");
  if (typeof operand !== "string") refuse(model, d.field, "a non-string equality filter");
  delete out[d.field];
  out[HASH_FIELD] = fingerprint(getFieldKeys(), operand);
}

const RELATION_FILTER_OPS = new Set(["is", "isNot", "some", "every", "none"]);

/** A `where` (or unique `where`) on `model`, with serial equality on the fingerprint. */
function rewriteWhere(model: string, where: unknown): unknown {
  if (!isPlainObject(where)) return where;
  const out: Row = { ...where };
  const relations = relationsOf(model);
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "AND" || key === "OR" || key === "NOT") {
      out[key] = each(value, (v) => rewriteWhere(model, v));
      continue;
    }
    const d = descriptor(model, key);
    if (d) {
      rewriteEncryptedCondition(model, d, value, out);
      continue;
    }
    const target = relations.get(key);
    if (target && isPlainObject(value)) {
      const keys = Object.keys(value);
      out[key] =
        keys.length > 0 && keys.every((k) => RELATION_FILTER_OPS.has(k))
          ? Object.fromEntries(keys.map((k) => [k, rewriteWhere(target, value[k])]))
          : rewriteWhere(target, value);
    }
  }
  return out;
}

/** `orderBy` must not sort on ciphertext (directly or through a relation). */
function checkOrderBy(model: string, orderBy: unknown) {
  each(orderBy, (entry) => {
    if (!isPlainObject(entry)) return;
    for (const [key, value] of Object.entries(entry)) {
      if (descriptor(model, key)) refuse(model, key, "orderBy");
      const target = relationsOf(model).get(key);
      if (target && isPlainObject(value)) checkOrderBy(target, value);
    }
  });
}

function checkFieldList(model: string, list: unknown, how: string) {
  each(list, (f) => {
    if (typeof f === "string" && descriptor(model, f)) refuse(model, f, how);
  });
}

function checkCursor(model: string, cursor: unknown) {
  if (!isPlainObject(cursor)) return;
  for (const key of Object.keys(cursor)) if (descriptor(model, key)) refuse(model, key, "a cursor");
}

/** `_min` / `_max` would compare ciphertext. */
function checkAggregates(model: string, args: Row) {
  for (const agg of ["_min", "_max"]) {
    const sel = args[agg];
    if (!isPlainObject(sel)) continue;
    for (const key of Object.keys(sel)) if (descriptor(model, key) && sel[key]) refuse(model, key, agg);
  }
}

/** Query args of one model (top level, or a relation inside `include` / `select`). */
function rewriteQueryArgs(model: string, args: Row): Row {
  const out: Row = { ...args };
  if (args.where !== undefined) out.where = rewriteWhere(model, args.where);
  if (args.orderBy !== undefined) checkOrderBy(model, args.orderBy);
  if (args.cursor !== undefined) checkCursor(model, args.cursor);
  if (args.distinct !== undefined) checkFieldList(model, args.distinct, "distinct");
  if (args.by !== undefined) checkFieldList(model, args.by, "groupBy");
  if (args.having !== undefined && isPlainObject(args.having)) {
    for (const key of Object.keys(args.having)) if (descriptor(model, key)) refuse(model, key, "having");
  }
  checkAggregates(model, args);
  for (const key of ["include", "select"] as const) {
    if (isPlainObject(args[key])) out[key] = rewriteSelection(model, args[key] as Row);
  }
  return out;
}

function rewriteSelection(model: string, selection: Row): Row {
  const out: Row = { ...selection };
  const relations = relationsOf(model);
  for (const [key, value] of Object.entries(selection)) {
    if (!isPlainObject(value)) continue;
    if (key === "_count") {
      const inner = value.select;
      if (isPlainObject(inner)) {
        const sel: Row = { ...inner };
        for (const [rel, relArgs] of Object.entries(inner)) {
          const target = relations.get(rel);
          if (target && isPlainObject(relArgs)) sel[rel] = rewriteQueryArgs(target, relArgs);
        }
        out[key] = { ...value, select: sel };
      }
      continue;
    }
    const target = relations.get(key);
    if (target) out[key] = rewriteQueryArgs(target, value);
  }
  return out;
}

// ─── Reads ──────────────────────────────────────────────────────

/** Decrypts every registered field of `model` in a result row (or rows), recursing into included relations. */
function decodeResult(model: string, result: unknown): unknown {
  if (Array.isArray(result)) {
    for (const r of result) decodeResult(model, r);
    return result;
  }
  if (!isPlainObject(result)) return result;
  const id = typeof result.id === "string" ? result.id : null;
  for (const d of encryptedFieldsFor(model)) {
    if (d.field in result) result[d.field] = decodeFromStorage(model, d.field, result[d.field], id);
  }
  for (const [field, target] of relationsOf(model)) {
    if (result[field] !== undefined && result[field] !== null) decodeResult(target, result[field]);
  }
  return result;
}

// ─── Operation args ─────────────────────────────────────────────

function rewriteArgs(model: string, operation: string, args: Row): Row {
  const out = rewriteQueryArgs(model, args);
  switch (operation) {
    case "create":
    case "update":
    case "updateMany":
      if (args.data !== undefined) out.data = encodeData(model, args.data);
      break;
    case "createMany":
    case "createManyAndReturn":
      if (args.data !== undefined) out.data = each(args.data, (v) => encodeData(model, v));
      break;
    case "upsert":
      out.create = encodeData(model, args.create);
      out.update = encodeData(model, args.update);
      break;
    default:
      break;
  }
  return out;
}

/** Results that are rows of `model` (counts, aggregates and batch payloads carry no encrypted values). */
const ROW_RESULTS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createManyAndReturn",
  "update",
  "upsert",
  "delete",
]);

// ─── The client ─────────────────────────────────────────────────

/**
 * REDISPATCH. Prisma runs query hooks in the order the extensions were added,
 * so in `withAudit(withEncryption(base))` THIS hook runs first, and the audit
 * hook runs inside its `query(...)`. The audit hook then re-dispatches an
 * audited write onto its transaction client (`tx.<model>.<operation>(args)`,
 * audit/extension.ts), which re-enters the whole chain — this hook included —
 * with the args this hook already encrypted. Encrypting them again would store
 * ciphertext of ciphertext.
 *
 * So while this hook's `query(...)` is running, the async context records the
 * model and operation it rewrote. A call for that same model and operation
 * arriving inside it is the re-dispatch: it passes through untouched (and
 * clears the marker, so the audit layer's own reads and writes inside it —
 * other operations, or the AuditEvent model — are handled normally). Prisma
 * clones args between hooks, so object identity cannot be used instead.
 */
const inFlight = new AsyncLocalStorage<{ model: string; operation: string } | undefined>();

/**
 * Returns `base` with field encryption. Typed as the base client: the query
 * extension adds no API. The app-facing Date/number types of the type-changed
 * columns are restored by AppPrismaClient (./app-client-types.ts), applied once
 * in src/lib/prisma.ts.
 */
export function withEncryption<C extends PrismaClient>(base: C): C {
  return base.$extends({
    name: "field-encryption",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const pending = inFlight.getStore();
          if (pending && pending.model === model && pending.operation === operation) {
            // The audit layer re-dispatching the call this hook already
            // rewrote onto its transaction client (see REDISPATCH above):
            // the args are already encrypted, and the outer call decodes.
            return inFlight.run(undefined, async () => await query(args));
          }
          const rewritten = isPlainObject(args) ? rewriteArgs(model, operation, args) : args;
          const result = await inFlight.run({ model, operation }, async () => await query(rewritten));
          return ROW_RESULTS.has(operation) ? decodeResult(model, result) : result;
        },
      },
    },
  }) as unknown as C;
}
