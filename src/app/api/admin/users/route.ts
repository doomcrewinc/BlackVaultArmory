export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { ROLES, type Role } from "@/lib/accounts";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";
import { getPublicUrl } from "@/lib/server/public-url";
import { createInvite } from "@/lib/auth/tokens";
import { INVALID_REQUEST, readJsonObject } from "@/lib/auth/route-helpers";

/** Every user, for the admin Users page. Never the password hash. */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const users = await prisma.user.findMany({
    select: { id: true, username: true, displayName: true, role: true, disabledAt: true, createdAt: true, lastLoginAt: true },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ users });
}

/** Create an invite link. Body `{ role?: "ADMIN" | "USER" }`, default USER. */
export async function POST(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const actor = (await getCurrentUser())!;

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json(INVALID_REQUEST, { status: 400 });
  const role = body.role === undefined ? "USER" : body.role;
  if (!ROLES.includes(role as Role)) return NextResponse.json(INVALID_REQUEST, { status: 400 });

  const { token, expiresAt } = await createInvite({ role: role as Role, createdById: actor.id });
  return NextResponse.json({ url: `${getPublicUrl().origin}/invite/${token}`, expiresAt });
}
