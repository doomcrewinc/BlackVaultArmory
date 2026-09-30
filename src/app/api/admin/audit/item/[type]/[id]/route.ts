export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { listAuditEvents, parseAuditFilters } from "@/lib/audit/query";

/** `GET /api/admin/audit/item/:type/:id` → every event for that entity, newest first, same paging. Admin only. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string; id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { type, id } = await params;
  const filters = { ...parseAuditFilters(request.nextUrl.searchParams), type, entityId: id };
  const { events, nextCursor } = await listAuditEvents(filters);
  return NextResponse.json({ events, nextCursor });
}
