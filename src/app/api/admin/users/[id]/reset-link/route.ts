export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";
import { getPublicUrl } from "@/lib/server/public-url";
import { createResetLink } from "@/lib/auth/tokens";
import { endUserSessions } from "@/lib/auth/sessions";

/**
 * Issue a single-use password reset link for a user and end their sessions immediately. For a
 * link issued to yourself the current session survives (spec: "except, for a self-change, the
 * current one"), so an admin testing their own link is not signed out mid-page.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const actor = (await getCurrentUser())!;

  const { id } = await params;
  const target = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!target) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const { token, expiresAt } = await createResetLink({ userId: target.id, createdById: actor.id });
  if (target.id === actor.id) await endUserSessions(target.id, actor.sessionId);
  else await endUserSessions(target.id);
  return NextResponse.json({ url: `${getPublicUrl().origin}/reset/${token}`, expiresAt });
}
