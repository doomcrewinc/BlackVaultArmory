export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { clearedSessionCookie } from "@/lib/auth/sessions";

/** End one of your own sessions. Ending the current one also clears the cookie. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const { id } = await params;
  // Scoped to the user: another user's session id is indistinguishable from an unknown one.
  const { count } = await prisma.session.deleteMany({ where: { id, userId: me.id } });
  if (count === 0) return NextResponse.json({ error: "Session not found" }, { status: 404 });

  const response = NextResponse.json({ ok: true });
  if (id === me.sessionId) response.cookies.set(clearedSessionCookie(request));
  return response;
}
