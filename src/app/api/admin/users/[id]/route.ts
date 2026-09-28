export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import type { Role } from "@/lib/accounts";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";
import { changeRoleOrStatus } from "@/lib/auth/admins";
import { INVALID_REQUEST, readJsonObject } from "@/lib/auth/route-helpers";

/** Promote/demote and disable/re-enable. Body `{ role?, disabled? }`; validated by changeRoleOrStatus. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const actor = (await getCurrentUser())!;

  const body = await readJsonObject(request);
  if (!body) return NextResponse.json(INVALID_REQUEST, { status: 400 });
  const change: { role?: Role; disabled?: boolean } = {};
  if (body.role !== undefined) change.role = body.role as Role;
  if (body.disabled !== undefined) change.disabled = body.disabled as boolean;

  const { id } = await params;
  const result = await changeRoleOrStatus(id, change, actor.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
}
