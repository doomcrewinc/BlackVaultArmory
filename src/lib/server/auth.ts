import { cache } from "react";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, validateSession, type SessionUser } from "@/lib/auth/sessions";

/**
 * Who is signed in. Always re-validates the cookie against the database — it never trusts a
 * header set by proxy.ts, so a request that somehow bypasses the proxy still cannot claim to
 * be someone. Wrapped in React `cache()`, which dedupes calls within a single server-component
 * render — but does nothing in a route handler, since a route handler is not a render: there,
 * every call re-validates the session against the database. (See `src/lib/audit/actor.ts`'s own
 * per-request memo, added because of this — a request that makes several audited writes would
 * otherwise repeat the session lookup once per write.)
 */
export const getCurrentUser = cache(async (): Promise<(SessionUser & { sessionId: string }) | null> => {
  const store = await cookies();
  const result = await validateSession(store.get(SESSION_COOKIE)?.value);
  return result ? { ...result.user, sessionId: result.sessionId } : null;
});

export async function requireAuth(): Promise<NextResponse | null> {
  return (await getCurrentUser()) ? null : NextResponse.json({ error: "Authentication required" }, { status: 401 });
}

export async function requireAdmin(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Admins only" }, { status: 403 });
  return null;
}
