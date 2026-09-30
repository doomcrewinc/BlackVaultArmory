import type { AuditEventDto } from "./query";

/**
 * CSV export for the audit log. RFC 4180 escaping plus a formula-injection
 * guard: a cell that would be interpreted as a formula by Excel/Sheets
 * (starts with `=`, `+`, `-`, `@`, a tab or a carriage return) is prefixed
 * with `'` before RFC 4180 quoting is applied, so it opens as inert text
 * instead of executing. docs/superpowers/specs/2026-09-29-audit-log-design.md,
 * "CSV export"; Review Focus #4.
 */

const FORMULA_PREFIX_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/** One CSV cell: stringified, formula-guarded, then RFC 4180 quoted if needed. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (FORMULA_PREFIX_TRIGGER.test(text)) text = `'${text}`;
  if (NEEDS_QUOTING.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

const HEADERS = ["at", "actor", "ip", "action", "type", "item", "changes"] as const;

/** `at,actor,ip,action,type,item,changes` — `changes` is the compact JSON string. */
export function toCsv(events: AuditEventDto[]): string {
  const lines = [HEADERS.join(",")];
  for (const event of events) {
    lines.push(
      [
        csvCell(event.at),
        csvCell(event.actorName),
        csvCell(event.actorIp),
        csvCell(event.action),
        csvCell(event.entityType),
        csvCell(event.entityLabel),
        csvCell(event.changes === null ? "" : JSON.stringify(event.changes)),
      ].join(","),
    );
  }
  return lines.join("\n");
}
