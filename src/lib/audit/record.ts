import type { Prisma } from "@prisma/client";
import type { AuditAction } from "./actions";
import type { AuditActor } from "./context";
import { redactRecord } from "./redact";

/** Anything that can insert an AuditEvent: the app client or a transaction client. */
export type AuditWriter = { auditEvent: Pick<Prisma.TransactionClient["auditEvent"], "create"> };

export type AuditEventInput = {
  action: AuditAction;
  actor: Pick<AuditActor, "actorId" | "actorName" | "actorIp">;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  /** Serialised to JSON text; redact before passing it (see {@link redactDeep}). */
  changes?: unknown;
};

/**
 * The single insert path for AuditEvent — the capture extension and
 * `recordEvent` both come through here, so the row shape is defined once.
 * `client` decides atomicity: pass the transaction client to commit and roll
 * back with the change.
 */
export async function writeAuditEvent(client: AuditWriter, event: AuditEventInput): Promise<void> {
  await client.auditEvent.create({
    data: {
      actorId: event.actor.actorId,
      actorName: event.actor.actorName,
      actorIp: event.actor.actorIp,
      action: event.action,
      entityType: event.entityType ?? null,
      entityId: event.entityId ?? null,
      entityLabel: event.entityLabel ?? null,
      changes: event.changes === undefined ? null : JSON.stringify(event.changes),
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * {@link redactRecord} applied at every level — nested create data can carry
 * a sensitive field (e.g. an accessory's serialNumber) below the top level.
 */
export function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!isPlainObject(value)) return value;
  const redacted = redactRecord(value);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(redacted)) out[key] = redactDeep(v);
  return out;
}
