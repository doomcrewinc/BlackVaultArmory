/**
 * A currency amount, or null when nothing usable was sent.
 *
 * Extracted from nfa.ts, where it was private, because six write routes take a
 * price and only the NFA tax fields validated it. `Number("")` and `Number(" ")`
 * are both `0`, so an emptied price input records a free item unless the blank
 * guard trims — a bug that shipped three separate times in this codebase.
 *
 * Zero is a legitimate recorded price (a gift, a transfer at no cost), which is
 * why "blank" and "zero" have to be distinguished before the parse, not after.
 */
export function normalizeMoney(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
