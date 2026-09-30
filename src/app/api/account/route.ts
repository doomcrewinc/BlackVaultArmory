export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { endUserSessions } from "@/lib/auth/sessions";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/auth/password";
import { validateDisplayName } from "@/lib/auth/username";
import { INVALID_REQUEST, readJsonObject } from "@/lib/auth/route-helpers";
import { recordEvent } from "@/lib/audit/events";

const AUTH_REQUIRED = { error: "Authentication required" };
const WRONG_PASSWORD = { error: "Current password is incorrect" };

/** The signed-in user. */
export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json(AUTH_REQUIRED, { status: 401 });
  const { id, username, displayName, role } = me;
  return NextResponse.json({ id, username, displayName, role });
}

/**
 * Self-service: `{ displayName?, currentPassword?, newPassword? }`. A password change needs the
 * current password and ends every OTHER session of the user.
 */
export async function PATCH(request: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json(AUTH_REQUIRED, { status: 401 });

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json(INVALID_REQUEST, { status: 400 });
  const { displayName, currentPassword, newPassword } = body;
  if (displayName === undefined && newPassword === undefined) return NextResponse.json(INVALID_REQUEST, { status: 400 });
  if (displayName !== undefined && typeof displayName !== "string") return NextResponse.json(INVALID_REQUEST, { status: 400 });
  if (newPassword !== undefined && typeof newPassword !== "string") return NextResponse.json(INVALID_REQUEST, { status: 400 });

  const data: { displayName?: string; passwordHash?: string } = {};
  if (displayName !== undefined) {
    const invalid = validateDisplayName(displayName);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    data.displayName = displayName.trim();
  }

  if (newPassword !== undefined) {
    const invalid = validatePassword(newPassword);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    if (typeof currentPassword !== "string") return NextResponse.json(WRONG_PASSWORD, { status: 401 });
    const stored = await prisma.user.findUnique({ where: { id: me.id }, select: { passwordHash: true } });
    if (!stored || !(await verifyPassword(currentPassword, stored.passwordHash)).ok) {
      return NextResponse.json(WRONG_PASSWORD, { status: 401 });
    }
    data.passwordHash = await hashPassword(newPassword);
  }

  const updated = await prisma.user.update({
    where: { id: me.id },
    data,
    select: { id: true, username: true, displayName: true, role: true },
  });
  if (data.passwordHash) {
    await recordEvent(null, {
      action: "PASSWORD_CHANGED",
      entityType: "User",
      entityId: updated.id,
      entityLabel: `${updated.displayName} (@${updated.username})`,
    });
    await endUserSessions(me.id, me.sessionId);
  }
  return NextResponse.json(updated);
}
