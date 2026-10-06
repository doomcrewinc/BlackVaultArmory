import { calendarDaysUntil, todayLocalISO } from "./date";

/** Items due within this many days are listed as due soon. */
export const UPCOMING_DAYS = 30;
/** The most rows the two lists show between them. */
export const MAX_DUE_ROWS = 8;

export type WithDue<T> = T & { dueDate: Date; days: number };

/**
 * Splits items into overdue and due-soon by CALENDAR days on the viewer's own
 * date: a due date of 1 October is 4 days overdue all through 5 October,
 * whatever the UTC clock says. `days` is unsigned; the list an item is in says
 * which direction. An item due today is due soon with 0 days. Each list is
 * ordered most urgent first. Call from client components (see todayLocalISO).
 */
export function partitionByDue<T>(
  items: readonly T[],
  dueOf: (item: T) => Date,
  todayISO: string = todayLocalISO(),
): { overdue: Array<WithDue<T>>; dueSoon: Array<WithDue<T>> } {
  const dated = items
    .map((item) => {
      const dueDate = dueOf(item);
      return { item, dueDate, until: calendarDaysUntil(dueDate, todayISO) };
    })
    .filter((row) => row.until <= UPCOMING_DAYS)
    .sort((x, y) => x.until - y.until);
  const overdue = dated
    .filter((row) => row.until < 0)
    .slice(0, MAX_DUE_ROWS)
    .map((row) => ({ ...row.item, dueDate: row.dueDate, days: -row.until }));
  const dueSoon = dated
    .filter((row) => row.until >= 0)
    .slice(0, MAX_DUE_ROWS - overdue.length)
    .map((row) => ({ ...row.item, dueDate: row.dueDate, days: row.until }));
  return { overdue, dueSoon };
}

/** "Due today" or "Due in 3d", for an item that is not overdue. */
export function dueInLabel(days: number): string {
  return days === 0 ? "Due today" : `Due in ${days}d`;
}
