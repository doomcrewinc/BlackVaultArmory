/**
 * date.ts — the only sanctioned way to read or write a date in this app.
 *
 * Two kinds of temporal value exist here and they must not be confused:
 *
 *   DATE-ONLY   a calendar day with no time: acquisitionDate, sessionDate,
 *               purchaseDate, lastMaintenanceDate, lastBatteryChangeDate,
 *               drillDate, MaintenanceLog.date.
 *               Stored as DateTime pinned to 00:00:00.000Z.
 *               Written with toDateOnlyUTC(). Displayed with formatDateOnly().
 *
 *   TIMESTAMP   an instant: createdAt, updatedAt, loggedAt, transactedAt,
 *               cachedAt, changedAt.
 *               Stored UTC. Displayed with formatTimestamp() in local time.
 *
 * A date-only value rendered in local time is off by one day for every viewer
 * west of UTC — that is the bug this module exists to prevent. There is
 * deliberately no generic `formatDate`: every call site must state which kind
 * of value it holds.
 */

const DASH = "—";

const DATE_ONLY_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Force a value onto UTC midnight of its UTC calendar day.
 * The only correct way to write a date-only field.
 *
 * A string beginning `YYYY-MM-DD` is read lexically — the calendar day is taken
 * from those first 10 characters and any time-of-day or offset is ignored
 * entirely. A naive datetime string (no `Z`, no offset) is parsed by JS as
 * LOCAL time, so reading UTC components back off it would make the result
 * depend on the time of day it happened to run. For a date-only field the user
 * typed a calendar day, not an instant, so the written day is the correct
 * reading regardless of any time or offset attached to the string.
 *
 * A `Date` object has no such ambiguity — it genuinely is an instant — so its
 * UTC calendar day is used directly.
 *
 * Throws on unparseable input — storing an Invalid Date would corrupt the row
 * silently, and a date-only column has no sentinel for "unknown" other than null,
 * which the caller must choose explicitly.
 */
export function toDateOnlyUTC(input: Date | string): Date {
  if (typeof input === "string") {
    const match = DATE_ONLY_PREFIX.exec(input);
    if (match) {
      const [, year, month, day] = match;
      const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
      if (Number.isNaN(candidate.getTime())) {
        throw new Error(`toDateOnlyUTC: invalid date input: ${String(input)}`);
      }
      return candidate;
    }
    const parsed = new Date(input);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`toDateOnlyUTC: invalid date input: ${String(input)}`);
    }
    return new Date(
      Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
    );
  }

  const parsed = input;
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`toDateOnlyUTC: invalid date input: ${String(input)}`);
  }
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
  );
}

/**
 * Render a date-only value. Pinned to UTC so the stored calendar day is shown
 * verbatim to every viewer, in any timezone.
 */
export function formatDateOnly(value: Date | string | null | undefined): string {
  if (!value) return DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Render an instant in the viewer's local timezone.
 * `timeZone` exists for tests; production callers omit it.
 */
export function formatTimestamp(
  value: Date | string | null | undefined,
  timeZone?: string
): string {
  if (!value) return DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/**
 * Today's date in the VIEWER's timezone, as YYYY-MM-DD for a date input.
 *
 * Deliberately not `new Date().toISOString().split("T")[0]`, which returns the
 * UTC day and therefore shows tomorrow to anyone west of UTC late in the evening.
 * Call this from client components only — on the server "local" is the
 * container's timezone, which is UTC in Docker and not the user's.
 */
export function todayLocalISO(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
