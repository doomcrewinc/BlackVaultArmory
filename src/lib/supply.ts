/**
 * supply.ts — consumable stores: cleaning supplies, medical, food, water,
 * filters, batteries, fuel, sanitation, CBRN filters, signal gear and
 * anything else that gets used up. Unlike AmmoStock, a supply's quantity is
 * a decimal — solvent comes in fractions of an ounce, water in fractions of
 * a gallon — so normalizeAmount must never floor it.
 */

export const SUPPLY_CATEGORIES = [
  "CLEANING",
  "MEDICAL",
  "FOOD",
  "WATER",
  "FILTER",
  "BATTERY",
  "FUEL",
  "SANITATION",
  "CBRN_FILTER",
  "SIGNAL",
  "OTHER",
] as const;

export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number];

export const SUPPLY_CATEGORY_LABELS: Record<SupplyCategory, string> = {
  CLEANING: "Cleaning",
  MEDICAL: "Medical",
  FOOD: "Food",
  WATER: "Water",
  FILTER: "Filter",
  BATTERY: "Battery",
  FUEL: "Fuel",
  SANITATION: "Sanitation",
  CBRN_FILTER: "CBRN Filter",
  SIGNAL: "Signal",
  OTHER: "Other",
};

export const DEFAULT_SUPPLY_CATEGORY: SupplyCategory = "OTHER";

export const SUPPLY_UNITS = [
  "COUNT",
  "OZ",
  "ML",
  "L",
  "GAL",
  "LB",
  "KIT",
  "CAL",
] as const;

export type SupplyUnit = (typeof SUPPLY_UNITS)[number];

export const SUPPLY_UNIT_LABELS: Record<SupplyUnit, string> = {
  COUNT: "Count",
  OZ: "oz",
  ML: "mL",
  L: "L",
  GAL: "gal",
  LB: "lb",
  KIT: "Kit",
  CAL: "Calories",
};

export const DEFAULT_SUPPLY_UNIT: SupplyUnit = "COUNT";

/**
 * A write path never stores a category outside the enum. Unrecognised input
 * falls back rather than erroring, matching normalizeGearCategory in gear.ts
 * and normalizeEnum in nfa.ts.
 */
export function normalizeSupplyCategory(value: unknown): SupplyCategory {
  if (typeof value !== "string") return DEFAULT_SUPPLY_CATEGORY;
  const candidate = value.trim().toUpperCase();
  return (SUPPLY_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as SupplyCategory)
    : DEFAULT_SUPPLY_CATEGORY;
}

/**
 * A write path never stores a unit outside the enum. Same fallback shape as
 * normalizeSupplyCategory.
 */
export function normalizeSupplyUnit(value: unknown): SupplyUnit {
  if (typeof value !== "string") return DEFAULT_SUPPLY_UNIT;
  const candidate = value.trim().toUpperCase();
  return (SUPPLY_UNITS as readonly string[]).includes(candidate)
    ? (candidate as SupplyUnit)
    : DEFAULT_SUPPLY_UNIT;
}

/**
 * A non-negative decimal amount, or the fallback. Blank is the fallback, not
 * 0 — `Number("")` is `0`, and that exact bug has already shipped three
 * times in this repo (the accessories create form, the gear create form,
 * the NFA tax field), so whitespace is trimmed before the blank check runs.
 *
 * Unlike AmmoStock.quantity this is not floored: solvent comes in fractions
 * of an ounce, water in fractions of a gallon.
 */
export function normalizeAmount(
  value: unknown,
  fallback: number | null = null,
): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Low when lowStockAlert is set and quantity is at or below it. A null
 * threshold means never low. A zero threshold is a real threshold, not
 * "unset" — it means low only at zero.
 */
export function isLowStock(row: {
  quantity: number;
  lowStockAlert: number | null;
}): boolean {
  return row.lowStockAlert !== null && row.quantity <= row.lowStockAlert;
}

export type ExpiryStatus = "none" | "fine" | "soon" | "expired";

export const DEFAULT_EXPIRY_WARNING_DAYS = 90;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A calendar-day number for a Date, derived from its UTC year/month/day
 * rather than its raw timestamp. Two Date objects that fall on the same UTC
 * calendar day but differ in time-of-day (23:59:59 vs 00:00:01) must compare
 * equal here; subtracting getTime() values directly would not give a clean
 * multiple of a day and would make the diff sensitive to time-of-day. This
 * has nothing to do with the caller's timezone — the caller already resolved
 * "today" for whichever audience needed it — it only protects the comparison
 * itself from time-of-day noise.
 */
function calendarDayNumber(date: Date): number {
  return Math.round(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) /
      MS_PER_DAY,
  );
}

/**
 * Expiry status of a supply. "none" with no date, "expired" strictly before
 * today, "soon" on the day itself or within warningDays after, else "fine".
 * Expiring today is "soon", not "expired" — you can still use it today.
 *
 * `today` is a REQUIRED argument, never read from the clock in here. The
 * dashboard and section pages are server components that cannot know the
 * browser's timezone, so the caller resolves "today" — the server from a
 * stored timezone setting, the client from the browser — and both sides run
 * this same comparison against their own resolved value. A predicate that
 * called `new Date()` itself would make server and client disagree
 * unpredictably, and would not be testable without mocking the clock. Do not
 * add a `new Date()` fallback here, ever.
 */
export function expiryStatus(
  expirationDate: Date | null,
  today: Date,
  warningDays: number,
): ExpiryStatus {
  if (!expirationDate) return "none";

  const window =
    Number.isFinite(warningDays) && warningDays >= 0
      ? warningDays
      : DEFAULT_EXPIRY_WARNING_DAYS;

  const diffDays = calendarDayNumber(expirationDate) - calendarDayNumber(today);

  if (diffDays < 0) return "expired";
  if (diffDays <= window) return "soon";
  return "fine";
}
