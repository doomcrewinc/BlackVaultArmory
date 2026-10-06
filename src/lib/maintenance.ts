/**
 * How a firearm's "last serviced" date follows its maintenance log.
 *
 * The date is stored on the firearm (it can also be typed on the firearm's
 * form with no log entry behind it), so these rules say when a log entry
 * moves it. Dates are date-only values (UTC midnight).
 */

/**
 * After an entry is logged: the later of the current date and the entry's.
 * Logging work done today resets the clock; logging an older, forgotten job
 * does not move it back.
 */
export function lastServicedAfterEntry(current: Date | null, entry: Date): Date {
  return current && current.getTime() > entry.getTime() ? current : entry;
}

/**
 * After an entry is deleted. Only an entry that WAS the last service changes
 * anything: the date falls back to the latest entry that remains. With no
 * entry left there is nothing to fall back to, so the date stays; it can be
 * corrected on the firearm's form.
 */
export function lastServicedAfterDelete(
  current: Date | null,
  deleted: Date,
  latestRemaining: Date | null,
): Date | null {
  if (!current || current.getTime() !== deleted.getTime()) return current;
  return latestRemaining ?? current;
}
