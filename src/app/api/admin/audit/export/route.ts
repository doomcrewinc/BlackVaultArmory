export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { listAuditEvents, parseAuditFilters, type AuditEventDto } from "@/lib/audit/query";
import { toCsv } from "@/lib/audit/csv";

/** Rows per page while draining the full result set — bounded, never one unbounded query. */
const BATCH_SIZE = 500;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `GET /api/admin/audit/export?…same filters` → `text/csv` attachment of everything matching. Admin only. */
export async function GET(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const filters = parseAuditFilters(request.nextUrl.searchParams);
  const events: AuditEventDto[] = [];
  let cursor = filters.cursor;
  for (;;) {
    const page = await listAuditEvents({ ...filters, cursor }, BATCH_SIZE);
    events.push(...page.events);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  return new NextResponse(toCsv(events), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="blackvault-audit-${todayUtc()}.csv"`,
    },
  });
}
