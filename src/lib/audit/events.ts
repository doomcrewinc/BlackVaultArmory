import type { AuditAction } from "./actions";
import { auditStorage, type AuditActor } from "./context";
import { resolveActor } from "./actor";
import { getClientIpFromHeaders } from "../server/client-ip";
import { redactDeep, writeAuditEvent, type AuditWriter } from "./record";
import { prisma } from "../prisma";

/**
 * Explicit security events — logins, logout, invites, role changes,
 * enable/disable, reset links, password changes, the direct-access toggle,
 * backup and restore. The capture extension (extension.ts) only sees
 * automatic row writes on audited models; these events are never inferred
 * from a row write, so the auth/admin/backup routes call this directly.
 *
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "Security events".
 * Imports stay relative: src/lib/prisma.ts (via events.ts's callers) is
 * loaded by scripts under plain ts-node, which has no path aliases.
 */

/** Anything that can insert an AuditEvent: the app client or a transaction client. */
export type TxOrClient = AuditWriter;

export type RecordEventInput = {
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  /** Serialised to JSON text; redacted the same way row changes are — never pass a raw token or password. */
  changes?: unknown;
  /**
   * Overrides actor resolution: LOGIN and INVITE_REDEEMED happen before the
   * acting user's session cookie exists (it is created afterward), so
   * `resolveActor()` would see no cookie and report `anonymous`. The user who
   * just proved their identity (password, or a single-use token) is the
   * actor instead. LOGOUT uses it too — by the time the event would resolve
   * the actor, the session row it is ending may already be gone.
   */
  actorOverride?: { actorId: string | null; actorName: string };
};

/** Header-only IP lookup: safe to call inside an open transaction (unlike resolveActor's session lookup). */
async function ipFromHeaders(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    return getClientIpFromHeaders(await headers());
  } catch {
    return null;
  }
}

async function actorFor(
  override: RecordEventInput["actorOverride"],
  stored: AuditActor | undefined,
): Promise<AuditActor> {
  if (override) {
    const actorIp = await ipFromHeaders();
    return override.actorId
      ? { kind: "user", actorId: override.actorId, actorName: override.actorName, actorIp }
      : { kind: "anonymous", actorId: null, actorName: "anonymous", actorIp };
  }
  // The store's actor was resolved before any transaction opened (never re-resolved
  // inside one — resolveActor()'s session lookup would deadlock on SQLite
  // connection_limit=1, spike R5). Outside a transaction there is no store to reuse.
  return stored ?? (await resolveActor());
}

/**
 * Records one explicit security event.
 *
 * `client`: pass the open transaction so the event commits or rolls back
 * with the change it belongs to (e.g. ROLE_CHANGED inside changeRoleOrStatus's
 * transaction, INVITE_REDEEMED inside redeem's). `null` uses the current
 * transaction from the audit store if one is open, else writes directly
 * through the app client — a single insert, atomic on its own.
 *
 * Guard: the audit STORE tracking an open transaction (`store.tx`) with no
 * already-resolved actor and no `actorOverride` — the case when that
 * transaction was opened under row-audit suppression (e.g. `withoutRowAudit`),
 * which skips `resolveActor()` when it opens the transaction (see
 * `extension.ts`'s wrapped `$transaction`) — throws rather than calling
 * `resolveActor()` here: that call needs the database connection the open
 * transaction is holding, which deadlocks on SQLite `connection_limit=1`
 * (spike R5). No current call site hits this; it exists so a future one
 * fails loudly instead of hanging.
 *
 * Deliberately keyed on `store.tx`, NOT on whether `client` was passed: a
 * caller can legitimately pass an explicit transaction client that was never
 * opened through the audited app client at all (e.g. a test driving
 * `changeRoleOrStatus` against a raw, unaudited `PrismaClient` to isolate
 * database concurrency — `admins.real-db.test.ts`). There is no ALS store in
 * that case, `resolveActor()`'s session lookup runs on the AUDITED singleton's
 * own connection pool (a different client entirely), and nothing deadlocks.
 */
export async function recordEvent(client: TxOrClient | null, e: RecordEventInput): Promise<void> {
  const store = auditStorage.getStore();
  if (store?.tx && !e.actorOverride && !store.actor) {
    throw new Error(
      `recordEvent(${e.action}): an open transaction (row audit suppressed) has no resolved actor and no ` +
        `actorOverride was given. resolveActor() cannot run inside an open transaction (it would deadlock on ` +
        `SQLite connection_limit=1); pass actorOverride explicitly instead.`,
    );
  }
  const writer = client ?? store?.tx ?? prisma;
  const actor = await actorFor(e.actorOverride, store?.actor);
  await writeAuditEvent(writer, {
    action: e.action,
    actor,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    entityLabel: e.entityLabel ?? null,
    changes: e.changes === undefined ? undefined : redactDeep(e.changes),
  });
}

/**
 * Same as {@link recordEvent}, but never throws: for call sites where the
 * request's main work has already committed outside a transaction (restore,
 * backup, reset-link issuance, login/logout, invite creation, the
 * self-service password change, the direct-access toggle) — an audit-write
 * failure there must not turn an already-successful action into a 500. Logs
 * and swallows the error instead.
 *
 * Events written INSIDE a transaction (redeem's INVITE_REDEEMED/
 * PASSWORD_CHANGED, changeRoleOrStatus's ROLE_CHANGED/USER_DISABLED/
 * USER_ENABLED) do NOT use this — they must stay atomic with the change they
 * describe, so a failing insert there should still roll the whole
 * transaction back.
 */
export async function recordEventBestEffort(client: TxOrClient | null, e: RecordEventInput): Promise<void> {
  try {
    await recordEvent(client, e);
  } catch (error) {
    console.error(`[audit] failed to record ${e.action} (request otherwise succeeded):`, error);
  }
}
