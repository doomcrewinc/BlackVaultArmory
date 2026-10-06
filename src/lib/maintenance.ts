import { toDateOnlyUTC } from "./date";

/**
 * When a firearm was last serviced: the later of the date kept on the firearm
 * (typed on its form, or set with a next-due date) and its newest maintenance
 * log entry.
 *
 * The log is the record of work done, so an entry counts the moment it exists
 * and stops counting the moment it is deleted; the date kept on the firearm is
 * the starting point for a firearm whose earlier service was never logged.
 * Values are date-only (see toDateOnlyUTC). Safe in client components.
 */
export function effectiveLastServiced(
  stored: Date | string | null | undefined,
  logDates: ReadonlyArray<Date | string>,
): Date | null {
  const days = [...(stored ? [stored] : []), ...logDates].map((value) => toDateOnlyUTC(value).getTime());
  return days.length === 0 ? null : new Date(Math.max(...days));
}
