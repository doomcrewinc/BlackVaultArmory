export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { hasNulByte, listAuditEvents, parseAuditFilters } from "@/lib/audit/query";

/** `GET /api/admin/audit/item/:type/:id` → every event for that entity, newest first, same paging. Admin only. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ type: string; id: string }> }) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { type, id } = await params;
  // A NUL byte can never validly appear in a stored entityType/entityId, and
  // Postgres rejects one outright (22021) if it reaches a query parameter —
  // an empty result, not a 500.
  if (hasNulByte(type) || hasNulByte(id)) return NextResponse.json({ events: [], nextCursor: null });

  const filters = { ...parseAuditFilters(request.nextUrl.searchParams), type, entityId: id };
  const { events, nextCursor } = await listAuditEvents(filters);
  return NextResponse.json({ events, nextCursor });
}
