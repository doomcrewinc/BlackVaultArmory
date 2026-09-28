import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { SESSION_COOKIE, createSession, sessionCookie } from "./sessions";
import { hashToken } from "./tokens";

/** Shared plumbing for the /api/auth/* routes. */

export const INVALID_REQUEST = { error: "Invalid request" } as const;

/** The parsed JSON body if it is a plain object, else null (bad JSON, array, null, number…). */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * Prisma unique-constraint violation. Duck-typed on `code` rather than `instanceof`: the
 * SQLite client (.prisma/client-sqlite) and the Postgres client (@prisma/client) each ship
 * their own PrismaClientKnownRequestError class, so instanceof against one misses the other.
 */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Sign `userId` in: end any session named by the incoming cookie (rotation — a fresh token on
 * every sign-in), create a new session, and return `body` with the session cookie set.
 */
export async function signInResponse(request: NextRequest, userId: string, body: unknown, status = 200) {
  const incoming = request.cookies.get(SESSION_COOKIE)?.value;
  if (incoming) await prisma.session.deleteMany({ where: { tokenHash: hashToken(incoming) } });
  const { token, expiresAt } = await createSession(userId, request.headers.get("user-agent"));
  const response = NextResponse.json(body, { status });
  response.cookies.set(sessionCookie(token, expiresAt, request));
  return response;
}
