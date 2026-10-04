/**
 * CSV cells, for every export that writes a CSV file. RFC 4180 quoting, and a
 * formula-injection guard: a cell that Excel or Sheets would read as a
 * formula (it starts with `=`, `+`, `-`, `@`, a tab or a carriage return) is
 * prefixed with `'` before it is quoted, so it opens as inert text instead of
 * running. The values come from what users type (names, notes, serials), and
 * the person who opens an export is often not the one who typed them.
 */

const FORMULA_PREFIX_TRIGGER = /^[=+\-@\t\r]/;
const NEEDS_QUOTING = /[",\r\n]/;

/** RFC 4180 quoting alone: for a value that is not user text (a number, a date), which must stay what it is. */
export function csvQuote(text: string): string {
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV cell: stringified, formula-guarded, then RFC 4180 quoted if needed. */
export function csvCell(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return csvQuote(FORMULA_PREFIX_TRIGGER.test(text) ? `'${text}` : text);
}
