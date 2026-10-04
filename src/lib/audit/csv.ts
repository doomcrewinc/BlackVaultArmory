import { csvCell } from "../csv";
import type { AuditEventDto } from "./query";

/**
 * CSV export for the audit log: RFC 4180 escaping plus the formula-injection
 * guard of ../csv.ts (csvCell), which every cell goes through.
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "CSV export".
 */

export { csvCell };

const HEADERS = ["at", "actor", "ip", "action", "type", "item", "changes"] as const;

/** UTF-8 BOM: without it, Excel guesses the file's encoding as the system codepage and mangles any non-ASCII label (e.g. "ÜBER"). */
const BOM = "﻿";

/** The BOM and the header line: the start of every export, before any row. */
export const CSV_PREAMBLE = BOM + HEADERS.join(",");

/** One data row, without its line separator. */
export function csvRow(event: AuditEventDto): string {
  return [
    csvCell(event.at),
    csvCell(event.actorName),
    csvCell(event.actorIp),
    csvCell(event.action),
    csvCell(event.entityType),
    csvCell(event.entityLabel),
    csvCell(event.changes === null ? "" : JSON.stringify(event.changes)),
  ].join(",");
}

/** RFC 4180 row separator, written BEFORE each row so the file never ends with a dangling one. */
export const CSV_ROW_SEPARATOR = "\r\n";

/**
 * `at,actor,ip,action,type,item,changes` — `changes` is the compact JSON
 * string. RFC 4180 row separator (CRLF) and a leading BOM, both for Excel's
 * benefit; a minimal parser (this module's own tests, or any other CSV
 * reader) only needs `\r?\n` and can ignore or strip the BOM.
 *
 * `CSV_PREAMBLE`, then `CSV_ROW_SEPARATOR + csvRow(event)` per event, is the
 * same text produced incrementally; the export route streams it that way.
 */
export function toCsv(events: AuditEventDto[]): string {
  return CSV_PREAMBLE + events.map((event) => CSV_ROW_SEPARATOR + csvRow(event)).join("");
}
