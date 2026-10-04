export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { listAuditEvents, parseAuditFilters, type AuditEventDto, type AuditFilters } from "@/lib/audit/query";
import { CSV_PREAMBLE, CSV_ROW_SEPARATOR, csvRow } from "@/lib/audit/csv";

/** Rows per database query. The response is written page by page, so memory is bounded by this, not by the size of the log. */
const BATCH_SIZE = 500;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Pages of events in the list's own order (`at desc, id desc`, `id` unique, so
 * the cursor `(at, id)` is a total order and no row is skipped or repeated
 * between pages). Every page is its own short query: no transaction spans the
 * export, so a slow download never holds the SQLite connection.
 */
async function* pages(filters: AuditFilters): AsyncGenerator<AuditEventDto[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await listAuditEvents({ ...filters, cursor }, BATCH_SIZE);
    yield page.events;
    if (!page.nextCursor) return;
    cursor = page.nextCursor;
  }
}

function rowsChunk(events: AuditEventDto[]): string {
  return events.map((event) => CSV_ROW_SEPARATOR + csvRow(event)).join("");
}

/**
 * `GET /api/admin/audit/export?…same filters` → `text/csv` attachment of everything matching. Admin only.
 *
 * The first page is read before the response is created, so a database error
 * there is still an ordinary 500. After that the status line has been sent: an
 * error on a later page errors the stream, which ends the HTTP response
 * without its terminating chunk, so the client's download fails (curl: exit
 * 18, "transfer closed"; fetch: the body read rejects) instead of ending as a
 * silently truncated file.
 */
export async function GET(request: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const filters = parseAuditFilters(request.nextUrl.searchParams);
  // The export is "everything matching the filters", always from the newest
  // row — not "everything after wherever a forwarded list-page cursor
  // happens to stop". `cursor` is only ever this export's own page token.
  delete filters.cursor;

  const iterator = pages(filters);
  const first = await iterator.next();
  const encoder = new TextEncoder();
  let preamble = true;

  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          let next = preamble ? first : await iterator.next();
          const head = preamble ? CSV_PREAMBLE : "";
          preamble = false;
          // A page can be empty while `nextCursor` is set (a search that found
          // nothing in the stretch of the log it read): keep going, writing
          // nothing for it, until a page has rows or the log ends.
          while (!next.done && next.value.length === 0) next = await iterator.next();
          if (next.done) {
            if (head) controller.enqueue(encoder.encode(head));
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(head + rowsChunk(next.value)));
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return(undefined);
      },
    },
    { highWaterMark: 0 },
  );

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Disposition": `attachment; filename="blackvault-audit-${todayUtc()}.csv"`,
    },
  });
}
