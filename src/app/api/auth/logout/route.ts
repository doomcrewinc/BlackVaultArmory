export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, clearedSessionCookie, endSession, endUserSessions, validateSession } from "@/lib/auth/sessions";

/**
 * End the current session (or, with `?all=1`, every session of the signed-in user) and clear
 * the cookie. Always 200 with the cookie cleared, even without a valid session — logging out
 * must never fail from the browser's point of view.
 */
export async function POST(request: NextRequest) {
  const current = await validateSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (current) {
    if (request.nextUrl.searchParams.get("all") === "1") await endUserSessions(current.user.id);
    else await endSession(current.sessionId);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(clearedSessionCookie(request));
  return response;
}
