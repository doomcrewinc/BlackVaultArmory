import { prisma } from "@/lib/prisma";
import { ROLES, type Role } from "@/lib/accounts";
import { endUserSessions } from "@/lib/auth/sessions";

/** Admin user management. The last active admin can never be demoted or disabled. */

const ACTIVE_ADMIN = { role: "ADMIN", disabledAt: null } as const;
const LAST_ADMIN_ERROR = "At least one active admin is required";
const MAX_ATTEMPTS = 3;

export type ChangeResult = { ok: true } | { ok: false; status: 400 | 404 | 409; error: string };

/** Thrown inside the transaction callback so Prisma rolls the change back. */
class ChangeRefused extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly error: string,
  ) {
    super(error);
  }
}

/** Active admins' display names, for the Admins-only page ("ask an admin"). */
export async function listAdmins(): Promise<{ displayName: string }[]> {
  return prisma.user.findMany({
    where: ACTIVE_ADMIN,
    select: { displayName: true },
    orderBy: { displayName: "asc" },
  });
}

/**
 * Serialization failure (Postgres SSI abort / write conflict). Duck-typed on `code` for the same
 * reason as isUniqueViolation: each provider's client ships its own error class.
 */
function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2034";
}

function isValidChange(change: unknown): change is { role?: Role; disabled?: boolean } {
  if (typeof change !== "object" || change === null) return false;
  const { role, disabled } = change as Record<string, unknown>;
  if (role === undefined && disabled === undefined) return false;
  if (role !== undefined && !ROLES.includes(role as Role)) return false;
  if (disabled !== undefined && typeof disabled !== "boolean") return false;
  return true;
}

/**
 * Change a user's role and/or disabled state.
 *
 * Last-admin protection is decided INSIDE one transaction, AFTER the change is applied: update,
 * then count active admins; zero → throw, which rolls the update back. Counting first and then
 * updating would let two admins demote each other concurrently (each sees the other still
 * active). The transaction is Serializable: on PostgreSQL the default READ COMMITTED would still
 * let both of those transactions commit (write skew — they update different rows); SSI aborts
 * one of them with P2034, which is retried here and then sees the committed demotion. SQLite
 * only offers Serializable (and writers are serialised anyway), so the option is valid on both.
 */
export async function changeRoleOrStatus(
  targetId: string,
  change: { role?: Role; disabled?: boolean },
  actorId: string,
): Promise<ChangeResult> {
  if (!isValidChange(change)) return { ok: false, status: 400, error: "Invalid request" };

  for (let attempt = 1; ; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const data: { role?: Role; disabledAt?: Date | null } = {};
          const target = await tx.user.findUnique({ where: { id: targetId } });
          if (!target) throw new ChangeRefused(404, "User not found");
          if (change.role !== undefined) data.role = change.role;
          // Re-disabling keeps the original timestamp.
          if (change.disabled !== undefined) data.disabledAt = change.disabled ? (target.disabledAt ?? new Date()) : null;
          await tx.user.update({ where: { id: targetId }, data });
          if ((await tx.user.count({ where: ACTIVE_ADMIN })) === 0) throw new ChangeRefused(409, LAST_ADMIN_ERROR);
        },
        { isolationLevel: "Serializable" },
      );
      break;
    } catch (error) {
      if (error instanceof ChangeRefused) return { ok: false, status: error.status, error: error.error };
      if (isSerializationFailure(error) && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }

  console.info(`[auth] user ${targetId} changed by ${actorId}:`, JSON.stringify(change));
  // After the commit: on SQLite (connection_limit=1) a query outside the open transaction would
  // wait for it forever. validateSession already refuses disabled users, so this is cleanup.
  if (change.disabled === true) await endUserSessions(targetId);
  return { ok: true };
}
