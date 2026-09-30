export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { listAuditEvents, parseAuditFilters } from "@/lib/audit/query";

/** `GET /api/admin/audit?cursor&user&action&type&from&to&q` → `{ events, nextCursor }`. Admin only. */
export async function GET(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const filters = parseAuditFilters(request.nextUrl.searchParams);
  const { events, nextCursor } = await listAuditEvents(filters);
  return NextResponse.json({ events, nextCursor });
}
