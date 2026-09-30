import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";

/**
 * The audit log's per-async-context state. See
 * docs/superpowers/specs/2026-09-29-audit-log-spike.md, "Decision".
 *
 * Imports here stay relative (no `@/`): src/lib/prisma.ts reaches this file,
 * and scripts load src/lib/prisma.ts under plain ts-node, which has no path
 * aliases.
 */

/**
 * Who made a change, in the shape of the AuditEvent actor columns.
 * `kind` says which of the three it is; `actorName` is the snapshot stored on
 * the row: `"<displayName> (@<username>)"`, or exactly `"system"` /
 * `"anonymous"`.
 */
export type AuditActor =
  | { kind: "user"; actorId: string; actorName: string; actorIp: string | null }
  | { kind: "anonymous"; actorId: null; actorName: "anonymous"; actorIp: string | null }
  | { kind: "system"; actorId: null; actorName: "system"; actorIp: null };

export const SYSTEM_ACTOR: AuditActor = Object.freeze({
  kind: "system",
  actorId: null,
  actorName: "system",
  actorIp: null,
}) as AuditActor;

export type AuditStore = {
  /** The interactive-transaction client every audited write in this context runs on. */
  tx?: Prisma.TransactionClient;
  /** Resolved before the transaction opened; never looked up inside one. */
  actor?: AuditActor;
  /** Set only while an audited write re-dispatched onto `tx` is running: this hook call records it. */
  inner?: boolean;
  /** Row-level auditing off (restore, maintenance scripts). Copied into every transaction opened inside. */
  suppress?: boolean;
};

export const auditStorage = new AsyncLocalStorage<AuditStore>();

/**
 * Runs `fn` with row-level auditing off for every write inside it, including
 * writes in transactions `fn` opens (the wrapped `$transaction` copies the
 * flag into the transaction's store). For restore, which replaces every row and
 * records one RESTORE event instead, and for maintenance scripts.
 */
export function withoutRowAudit<T>(fn: () => Promise<T>): Promise<T> {
  const outer = auditStorage.getStore();
  // `async () => await fn()`: a Prisma promise is lazy, so returning it
  // un-awaited would run it after `run` has left the store (spike, "OOM").
  return auditStorage.run({ ...outer, suppress: true }, async () => await fn());
}

/** The spike's name for {@link withoutRowAudit}. */
export const runWithRowAuditSuppressed = withoutRowAudit;
