import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveActor } from "./actor";
import { auditStorage, SYSTEM_ACTOR, type AuditActor, type AuditStore } from "./context";
import { labelFor } from "./labels";
import { diffRecords } from "./redact";
import { redactDeep, writeAuditEvent } from "./record";
import { isAudited } from "./registry";

/**
 * Automatic audit capture: every create/update/delete on an audited model is
 * recorded, with the acting user, in the same transaction as the change.
 *
 * Mechanism (docs/superpowers/specs/2026-09-29-audit-log-spike.md, "Decision",
 * candidate A — proven atomic and deadlock-free on SQLite `connection_limit=1`
 * and PostgreSQL):
 * - every audited write runs on an interactive-transaction client held in an
 *   AsyncLocalStorage store, and its audit row is written with that same client;
 * - a single write outside a transaction is wrapped in one;
 * - a write issued inside a transaction callback — through `tx` or, by
 *   mistake, the outer client — is re-dispatched onto the store's `tx`;
 * - `$transaction` is wrapped so the store exists, nested calls flatten into
 *   the open transaction, and the array form becomes an interactive one;
 * - the actor is resolved before any transaction opens (never inside one).
 *
 * Rules for callers are in the spike doc, "Rules for code that uses the
 * audited client". Imports stay relative: scripts load this under ts-node.
 */

const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

/** Operations that would change or remove an existing audit entry. */
const APPEND_ONLY_BLOCKED: ReadonlySet<string> = new Set(["update", "updateMany", "upsert", "delete", "deleteMany"]);

/** Auto-wrapped writes queue behind a busy SQLite connection instead of failing at Prisma's 2 s maxWait (spike A13/A13b). */
const TX_DEFAULTS = { maxWait: 10_000, timeout: 10_000 } as const;

type Row = Record<string, unknown>;
type AnyDelegate = Record<string, (args?: unknown) => Promise<unknown>>;
type Delegates = Record<string, AnyDelegate>;
type TxOptions = { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel };

// ─── Schema metadata (DMMF) ─────────────────────────────────────

type CascadeEdge = { child: string; relationField: string };

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

function scalarFields(model: string): string[] {
  return (MODELS.get(model)?.fields ?? []).filter((f) => f.kind !== "object").map((f) => f.name);
}

function relationFields(model: string): Set<string> {
  return new Set((MODELS.get(model)?.fields ?? []).filter((f) => f.kind === "object").map((f) => f.name));
}

/** parent model -> the child relations the DATABASE removes when a parent row is deleted. */
const CASCADES = new Map<string, CascadeEdge[]>();
for (const m of Prisma.dmmf.datamodel.models) {
  for (const f of m.fields) {
    if (f.kind !== "object" || f.relationOnDelete !== "Cascade" || !f.relationFromFields?.length) continue;
    const edges = CASCADES.get(f.type) ?? [];
    edges.push({ child: m.name, relationField: f.name });
    CASCADES.set(f.type, edges);
  }
}

function delegateName(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

function delegateOf(client: unknown, model: string): AnyDelegate {
  return (client as Delegates)[delegateName(model)];
}

function scalarsOf(model: string, row: Row): Row {
  const out: Row = {};
  for (const field of scalarFields(model)) if (field in row) out[field] = row[field];
  return out;
}

/**
 * Rows the database will remove by `onDelete: Cascade` when the row matching
 * `where` is deleted, per model, transitively (a firearm's builds AND their
 * slots). Counted before the delete, on the same transaction, so the counts
 * are what the delete removes. Only non-zero counts are kept.
 */
async function countCascadedChildren(tx: unknown, model: string, where: Row, path: string[] = [model]): Promise<Record<string, number>> {
  const totals: Record<string, number> = {};
  for (const { child, relationField } of CASCADES.get(model) ?? []) {
    if (path.includes(child)) continue;
    const childWhere = { [relationField]: { is: where } };
    const count = (await delegateOf(tx, child).count({ where: childWhere })) as number;
    if (!count) continue;
    totals[child] = (totals[child] ?? 0) + count;
    const deeper = await countCascadedChildren(tx, child, childWhere, [...path, child]);
    for (const [m, n] of Object.entries(deeper)) totals[m] = (totals[m] ?? 0) + n;
  }
  return totals;
}

/** Relation operations in create/update data (nested create/connect/…), redacted. */
function nestedWrites(model: string, data: unknown): Row {
  const out: Row = {};
  if (typeof data !== "object" || data === null) return out;
  const relations = relationFields(model);
  for (const [key, value] of Object.entries(data as Row)) {
    if (relations.has(key) && value !== undefined) out[key] = redactDeep(value);
  }
  return out;
}

// ─── Capture ────────────────────────────────────────────────────

type Capture = {
  tx: Prisma.TransactionClient;
  actor: AuditActor;
  model: string;
  operation: string;
  args: Row;
  query: (args: unknown) => Promise<unknown>;
};

async function record(c: Capture, action: "CREATE" | "UPDATE" | "DELETE", row: Row, changes: unknown) {
  await writeAuditEvent(c.tx, {
    action,
    actor: c.actor,
    entityType: c.model,
    entityId: row.id == null ? null : String(row.id),
    entityLabel: labelFor(c.model, row),
    changes,
  });
}

async function findById(c: Capture, id: unknown): Promise<Row | null> {
  return (await delegateOf(c.tx, c.model).findUnique({ where: { id } })) as Row | null;
}

/**
 * Runs a create/upsert so its result always carries the row id, then returns
 * the caller's result (without an id it did not select) and the full stored
 * row, whatever `select`/`include` the caller used.
 */
async function writeKeepingId(c: Capture): Promise<{ result: unknown; row: Row | null }> {
  const select = c.args.select as Row | undefined;
  const addedId = !!select && !select.id;
  const result = (await c.query(addedId ? { ...c.args, select: { ...select, id: true } } : c.args)) as Row | null;
  if (!result || result.id == null) return { result, row: null };
  const id = result.id;
  const row = select || c.args.include ? await findById(c, id) : result;
  if (addedId) {
    const { id: _dropped, ...rest } = result;
    void _dropped;
    return { result: rest, row };
  }
  return { result, row };
}

async function recordCreate(c: Capture, row: Row, data: unknown) {
  await record(c, "CREATE", row, { ...(redactDeep(scalarsOf(c.model, row)) as Row), ...nestedWrites(c.model, data) });
}

async function recordUpdate(c: Capture, before: Row, after: Row) {
  const changes: Row = { ...diffRecords(scalarsOf(c.model, before), scalarsOf(c.model, after)) };
  const nested = nestedWrites(c.model, c.args.data);
  if (Object.keys(nested).length) changes._nested = nested;
  if (!Object.keys(changes).length) return; // a save with the values the row already had
  await record(c, "UPDATE", after, changes);
}

async function recordDelete(c: Capture, before: Row) {
  const children = await countCascadedChildren(c.tx, c.model, { id: before.id });
  const snapshot = redactDeep(scalarsOf(c.model, before)) as Row;
  return () =>
    record(c, "DELETE", before, Object.keys(children).length ? { ...snapshot, _children: children } : snapshot);
}

/** Runs one audited write on `c.tx` and records it. Returns the operation's own result. */
async function capture(c: Capture): Promise<unknown> {
  const d = delegateOf(c.tx, c.model);
  switch (c.operation) {
    case "create": {
      const { result, row } = await writeKeepingId(c);
      if (row) await recordCreate(c, row, c.args.data);
      return result;
    }
    case "createMany":
    case "createManyAndReturn": {
      // createMany returns no rows: record each input row (ids only when the caller supplied them).
      const result = await c.query(c.args);
      const returned = c.operation === "createManyAndReturn" ? (result as Row[]) : null;
      const data = Array.isArray(c.args.data) ? (c.args.data as Row[]) : [c.args.data as Row];
      for (const [i, item] of data.entries()) await recordCreate(c, returned?.[i] ?? item, item);
      return result;
    }
    case "update": {
      const before = (await d.findUnique({ where: c.args.where })) as Row | null;
      const result = await c.query(c.args);
      if (!before) return result;
      const after = await findById(c, before.id);
      if (after) await recordUpdate(c, before, after);
      return result;
    }
    case "upsert": {
      const before = (await d.findUnique({ where: c.args.where })) as Row | null;
      const { result, row } = await writeKeepingId(c);
      if (before) {
        const after = await findById(c, before.id);
        if (after) await recordUpdate({ ...c, args: { ...c.args, data: c.args.update } }, before, after);
      } else if (row) {
        await recordCreate(c, row, c.args.create);
      }
      return result;
    }
    case "updateMany": {
      const befores = (await d.findMany({ where: c.args.where })) as Row[];
      const result = await c.query(c.args);
      if (!befores.length) return result;
      const afters = (await d.findMany({ where: { id: { in: befores.map((b) => b.id) } } })) as Row[];
      const afterById = new Map(afters.map((a) => [a.id, a]));
      for (const before of befores) {
        const after = afterById.get(before.id);
        if (after) await recordUpdate(c, before, after);
      }
      return result;
    }
    case "delete": {
      const before = (await d.findUnique({ where: c.args.where })) as Row | null;
      const write = before ? await recordDelete(c, before) : null;
      const result = await c.query(c.args);
      if (write) await write();
      return result;
    }
    case "deleteMany": {
      const befores = (await d.findMany({ where: c.args.where })) as Row[];
      const writes = [];
      for (const before of befores) writes.push(await recordDelete(c, before));
      const result = await c.query(c.args);
      for (const write of writes) await write();
      return result;
    }
    default:
      return c.query(c.args);
  }
}

// ─── The client ─────────────────────────────────────────────────

/**
 * Returns the audited client: `base` with the capture hook, and a
 * `$transaction` that keeps the audit store. Typed as the base client — the
 * query extension adds no API, and callers keep their `PrismaClient` /
 * `Prisma.TransactionClient` annotations.
 */
export function withAudit<C extends PrismaClient>(base: C): C {
  // Assigned right after $extends; the hook only runs once a query is made.
  let wrappedTx: (arg: unknown, opts?: TxOptions) => Promise<unknown> = () => {
    throw new Error("audit client not initialised");
  };

  const ext = base.$extends({
    name: "audit-log",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (model === "AuditEvent" && APPEND_ONLY_BLOCKED.has(operation)) {
            throw new Error("AuditEvent is append-only");
          }
          if (!isAudited(model) || !WRITE_OPERATIONS.has(operation)) return query(args);

          const store = auditStorage.getStore();
          if (store?.suppress) return query(args);

          // Every `auditStorage.run` callback is `async () => await …`: Prisma
          // promises are lazy, and one returned un-awaited would execute after
          // `run` left the store and re-dispatch forever (spike, "OOM").
          if (store?.tx && store.inner) {
            const tx = store.tx;
            const actor = store.actor ?? SYSTEM_ACTOR;
            return auditStorage.run({ ...store, inner: false }, async () =>
              await capture({ tx, actor, model, operation, args: args as Row, query: query as (a: unknown) => Promise<unknown> }),
            );
          }
          if (store?.tx) {
            const tx = store.tx;
            return auditStorage.run({ ...store, inner: true }, async () => await delegateOf(tx, model)[operation](args));
          }
          return wrappedTx(async () => {
            const s = auditStorage.getStore() as AuditStore;
            const tx = s.tx as Prisma.TransactionClient;
            return auditStorage.run({ ...s, inner: true }, async () => await delegateOf(tx, model)[operation](args));
          });
        },
      },
    },
  });

  const rawTx = ext.$transaction.bind(ext) as unknown as (
    fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
    opts?: TxOptions,
  ) => Promise<unknown>;

  const runAll = async (items: readonly unknown[]) => {
    const out: unknown[] = [];
    for (const item of items) out.push(await item);
    return out;
  };

  wrappedTx = async (arg, opts) => {
    const outer = auditStorage.getStore();
    const body = (tx: Prisma.TransactionClient) =>
      typeof arg === "function" ? (arg as (t: Prisma.TransactionClient) => Promise<unknown>)(tx) : runAll(arg as unknown[]);

    // Already in a transaction: flatten into it (spike A8). Inner opts are ignored.
    if (outer?.tx) return body(outer.tx);

    // Resolved BEFORE the transaction opens — a session lookup inside one
    // deadlocks on SQLite connection_limit=1 (audit-log spike). Not needed when suppressed.
    const actor = outer?.suppress ? outer.actor : (outer?.actor ?? (await resolveActor()));
    return rawTx(
      (tx) => auditStorage.run({ tx, actor, suppress: outer?.suppress }, async () => await body(tx)),
      { ...TX_DEFAULTS, ...opts },
    );
  };

  return new Proxy(ext, {
    get: (target, prop) => (prop === "$transaction" ? wrappedTx : Reflect.get(target, prop)),
  }) as unknown as C;
}
