export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/server/auth";
import { envForcesDirectAccess, invalidateDirectAccessCache } from "@/lib/server/direct-access";
import { INVALID_REQUEST, readJsonObject } from "@/lib/auth/route-helpers";
import { recordEvent } from "@/lib/audit/events";

/**
 * Admin toggle for serving http://<ip>:<port> directly. Refused while the environment forces it
 * on — the stored setting would have no effect. proxy.ts sees the change on its next request;
 * the TCP gate within its 5 s poll of /api/internal/gate-config.
 */
export async function PUT(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  if (envForcesDirectAccess()) {
    return NextResponse.json({ error: "Direct access is forced on by BLACKVAULT_ALLOW_DIRECT_ACCESS" }, { status: 409 });
  }

  const body = await readJsonObject(request);
  if (!body || typeof body.allowDirectAccess !== "boolean") return NextResponse.json(INVALID_REQUEST, { status: 400 });
  const allowDirectAccess = body.allowDirectAccess;

  const before = await prisma.appSettings.findUnique({ where: { id: "singleton" }, select: { allowDirectAccess: true } });
  const from = before?.allowDirectAccess ?? false;

  const saved = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", allowDirectAccess },
    update: { allowDirectAccess },
  });
  invalidateDirectAccessCache();
  if (from !== allowDirectAccess) {
    await recordEvent(null, {
      action: "DIRECT_ACCESS_CHANGED",
      entityType: "AppSettings",
      entityId: "singleton",
      changes: { from, to: allowDirectAccess },
    });
  }
  return NextResponse.json({ allowed: saved.allowDirectAccess === true, source: "setting" });
}
