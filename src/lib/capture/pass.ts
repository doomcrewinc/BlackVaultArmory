import { prisma } from "@/lib/prisma";
import { generateToken, hashToken } from "@/lib/auth/tokens";
import type { PhotoEntityType } from "@/lib/photos/owner";

export const PASS_TTL_MS = 15 * 60_000;
export const PASS_MAX_UPLOADS = 50;

export type PassEndReason = "expired" | "closed" | "full";

export type OpenPass = {
  id: string;
  entityType: PhotoEntityType;
  entityId: string;
  createdById: string;
  creatorName: string;
  expiresAt: Date;
  uploadCount: number;
};

/** Closes any open pass for the item, creates a new one. Returns the raw token once and the ids of the passes it closed. */
export async function createPass(opts: {
  entityType: PhotoEntityType;
  entityId: string;
  createdById: string;
  sessionId: string;
  now?: Date;
}): Promise<{ id: string; token: string; expiresAt: Date; closedPassIds: string[] }> {
  const now = opts.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + PASS_TTL_MS);
  // Interactive form: queries built outside a transaction would not run on its connection.
  const { pass, closedPassIds } = await prisma.$transaction(async (tx) => {
    const where = { entityType: opts.entityType, entityId: opts.entityId, closedAt: null };
    const closed = await tx.capturePass.findMany({ where, select: { id: true } });
    await tx.capturePass.updateMany({ where, data: { closedAt: now } });
    const created = await tx.capturePass.create({
      data: {
        tokenHash: hashToken(token),
        entityType: opts.entityType,
        entityId: opts.entityId,
        createdById: opts.createdById,
        sessionId: opts.sessionId,
        createdAt: now,
        expiresAt,
      },
    });
    return { pass: created, closedPassIds: closed.map((row) => row.id) };
  });
  return { id: pass.id, token, expiresAt, closedPassIds };
}

/** Why a pass no longer takes uploads, or null while it is open. `closed` outranks `expired`, which outranks `full`. */
export function endReason(
  pass: { closedAt: Date | null; expiresAt: Date; uploadCount: number },
  now: Date = new Date(),
): PassEndReason | null {
  if (pass.closedAt) return "closed";
  if (pass.expiresAt <= now) return "expired";
  if (pass.uploadCount >= PASS_MAX_UPLOADS) return "full";
  return null;
}

/** null = no such token. A pass whose creator is disabled reads as "closed". */
export async function findPass(
  rawToken: string,
  now: Date = new Date(),
): Promise<{ ok: true; pass: OpenPass } | { ok: false; reason: PassEndReason } | null> {
  const row = await prisma.capturePass.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { createdBy: { select: { displayName: true, username: true, disabledAt: true } } },
  });
  if (!row) return null;
  const reason = row.createdBy.disabledAt ? "closed" : endReason(row, now);
  if (reason) return { ok: false, reason };
  return {
    ok: true,
    pass: {
      id: row.id,
      entityType: row.entityType as PhotoEntityType,
      entityId: row.entityId,
      createdById: row.createdById,
      creatorName: `${row.createdBy.displayName} (@${row.createdBy.username})`,
      expiresAt: row.expiresAt,
      uploadCount: row.uploadCount,
    },
  };
}

/** Atomically takes one upload slot. false when the pass is no longer open or is full. */
export async function takeSlot(passId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.capturePass.updateMany({
    where: { id: passId, closedAt: null, expiresAt: { gt: now }, uploadCount: { lt: PASS_MAX_UPLOADS } },
    data: { uploadCount: { increment: 1 } },
  });
  return count === 1;
}

/** The pass's current upload count, 0 when the pass is gone. */
export async function uploadCountOf(passId: string): Promise<number> {
  const row = await prisma.capturePass.findUnique({ where: { id: passId }, select: { uploadCount: true } });
  return row?.uploadCount ?? 0;
}

/** Gives a slot back after a failed upload. */
export async function returnSlot(passId: string): Promise<void> {
  await prisma.capturePass.updateMany({
    where: { id: passId, uploadCount: { gt: 0 } },
    data: { uploadCount: { decrement: 1 } },
  });
}

/** Sets closedAt if still open. Returns whether it changed anything. */
export async function closePass(passId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.capturePass.updateMany({
    where: { id: passId, closedAt: null },
    data: { closedAt: now },
  });
  return count === 1;
}
