export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, clearedSessionCookie, endSession, endUserSessions, validateSession } from "@/lib/auth/sessions";
import { recordEventBestEffort } from "@/lib/audit/events";

/**
 * End the current session (or, with `?all=1`, every session of the signed-in user) and clear
 * the cookie. Always 200 with the cookie cleared, even without a valid session — logging out
 * must never fail from the browser's point of view.
 */
export async function POST(request: NextRequest) {
  const current = await validateSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (current) {
    const all = request.nextUrl.searchParams.get("all") === "1";
    if (all) await endUserSessions(current.user.id);
    else await endSession(current.sessionId);
    // actorOverride: by now the session row this event is about may already be gone,
    // so resolveActor()'s lookup could no longer find it — name the user explicitly.
    const actorName = `${current.user.displayName} (@${current.user.username})`;
    await recordEventBestEffort(null, {
      action: "LOGOUT",
      entityType: "User",
      entityId: current.user.id,
      entityLabel: actorName,
      actorOverride: { actorId: current.user.id, actorName },
      ...(all ? { changes: { allSessions: true } } : {}),
    });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(clearedSessionCookie(request));
  return response;
}
