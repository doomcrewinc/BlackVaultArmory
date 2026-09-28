export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/server/auth";

/** The signed-in user's unexpired sessions, most recently used first; `current` marks this one. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  const rows = await prisma.session.findMany({
    where: { userId: me.id, expiresAt: { gt: new Date() } },
    select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, userAgent: true },
    orderBy: { lastSeenAt: "desc" },
  });
  return NextResponse.json({ sessions: rows.map((row) => ({ ...row, current: row.id === me.sessionId })) });
}
