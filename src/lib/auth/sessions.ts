import { prisma } from "@/lib/prisma";
import { isSecureRequest } from "@/lib/server/request-gate";
import { ROLES } from "@/lib/accounts";
import { generateToken, hashToken } from "./tokens";

/** DB-backed sessions. The cookie carries a random token; the DB stores only its hash. */

export const SESSION_COOKIE = "bv_session";
export const SESSION_TTL_MS = 30 * 86_400_000;
export const SLIDE_EVERY_MS = 3_600_000;

export type SessionUser = { id: string; username: string; displayName: string; role: "ADMIN" | "USER" };

export async function createSession(userId: string, userAgent: string | null, now: Date = new Date()) {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), createdAt: now, lastSeenAt: now, expiresAt, userAgent: userAgent?.slice(0, 256) ?? null },
  });
  return { token, expiresAt };
}

export async function validateSession(
  raw: string | undefined,
  now: Date = new Date(),
): Promise<{ user: SessionUser; sessionId: string; slidTo?: Date } | null> {
  if (!raw) return null;
  try {
    const row = await prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!row || row.expiresAt <= now || row.user.disabledAt) return null;

    const { id, username, displayName, role } = row.user;
    // role is a String column at the DB layer (see prisma/schema.base.prisma); an
    // unrecognised value means the session cannot be trusted, never a bare cast.
    if (!ROLES.includes(role as (typeof ROLES)[number])) return null;
    const user: SessionUser = { id, username, displayName, role: role as SessionUser["role"] };

    // Slide at most hourly so SQLite is not written on every request.
    if (now.getTime() - row.lastSeenAt.getTime() > SLIDE_EVERY_MS) {
      const slidTo = new Date(now.getTime() + SESSION_TTL_MS);
      await prisma.session.update({ where: { id: row.id }, data: { lastSeenAt: now, expiresAt: slidTo } });
      return { sessionId: row.id, user, slidTo };
    }

    return { sessionId: row.id, user };
  } catch (error) {
    console.error("[auth] session lookup failed:", error);
    return null;
  }
}

export async function endSession(sessionId: string) {
  await prisma.session.deleteMany({ where: { id: sessionId } });
}

export async function endUserSessions(userId: string, exceptSessionId?: string) {
  await prisma.session.deleteMany({ where: exceptSessionId ? { userId, NOT: { id: exceptSessionId } } : { userId } });
}

export function sessionCookie(token: string, expiresAt: Date, request: Request) {
  // Whole seconds remaining until expiry, never negative — Max-Age is the
  // browser-facing mirror of `expires` (spec: Global Constraints, cookie line).
  const maxAge = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 1000));
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: isSecureRequest(request),
    path: "/",
    expires: expiresAt,
    maxAge,
  };
}

export function clearedSessionCookie(request: Request) {
  return { ...sessionCookie("", new Date(0), request), maxAge: 0 };
}
