/**
 * How many identical items one record stands for. Always at least 1: a record
 * that exists represents something, and 0 would make an item invisible in
 * counts while still sitting in the list.
 */
export function normalizeQuantity(value: unknown, fallback = 1): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const whole = Math.floor(parsed);
  return whole >= 1 ? whole : fallback;
}
