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
  // The export is "everything matching the filters", always from the newest
  // row — not "everything after wherever a forwarded list-page cursor
  // happens to stop". `cursor` below is only ever this loop's own page
  // token.
  delete filters.cursor;
  const events: AuditEventDto[] = [];
  let cursor: string | undefined;
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
