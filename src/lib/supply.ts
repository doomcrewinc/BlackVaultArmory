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
  // Only a number or a string is a legitimate amount. Anything else — most
  // notably a boolean — must fall back rather than coerce: `Number(true)` is
  // `1`, which would silently turn a checkbox or truthy flag into a stocked
  // quantity.
  if (typeof value !== "number" && typeof value !== "string") return fallback;
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
 * The year/month/day a given instant reads as in a given IANA timezone, via
 * Intl rather than arithmetic on a fixed UTC offset — the offset itself
 * varies by date (DST), so a fixed-offset calculation is exactly the kind of
 * bug this module exists to avoid.
 */
function calendarPartsInTimeZone(
  timeZone: string,
  now: Date,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/**
 * The host's IANA timezone, or null when the runtime cannot name one.
 *
 * `resolvedOptions().timeZone` is specified to return an IANA name, but it is
 * an empty string on some older runtimes and the whole call can throw where
 * Intl is a stub, so both are treated as "no answer" rather than propagating.
 */
function systemTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Resolves "today" for expiryStatus, in a given timezone, as a Date whose
 * UTC year/month/day equal that timezone's calendar day — the exact shape
 * calendarDayNumber (and so expiryStatus) requires.
 *
 * This exists because a raw `new Date()` is NOT that shape: in any
 * negative-UTC-offset timezone (this project's own dev/test timezone,
 * America/Denver at UTC-6/-7, included), the wall clock is still on
 * yesterday's calendar day for several hours after UTC has already rolled
 * over to today. Pass that straight into expiryStatus and something
 * expiring "today" reads as already expired every evening, hours before
 * local midnight. Passing it through here first fixes that: the UTC day
 * this function returns is deliberately not the same as `now`'s UTC day
 * whenever the timezone's local day differs from it — that's the whole
 * point, see the "off-by-one" test in supply.test.ts for the worked example.
 *
 * A NULL `timezone` — AppSettings.timezone out of the box, and on any install
 * whose owner never opened Settings — falls back to the HOST's zone, not to
 * UTC. Hardcoding UTC there re-opened the exact off-by-one this helper exists
 * to close: a default install west of UTC read a supply expiring today as
 * `expired` every evening. The host zone is right for a bare-metal or dev
 * install and no worse than UTC anywhere else. In a container the host zone
 * IS UTC, so this cannot rescue Docker — nothing silent can, which is why the
 * dashboard shows a notice while the setting is unset.
 *
 * `timezone` is looked up via Intl, which throws on anything it doesn't
 * recognise; that throw falls back to UTC rather than propagating, since a
 * corrupt setting must not take down every expiry read in the app. Note the
 * asymmetry: a null setting resolves to the host zone, whereas a SET but
 * unrecognised one resolves to UTC — a stored value the user chose is not
 * silently replaced with a different real zone, it is discarded. The host zone
 * being itself unrecognised lands in the same catch, so UTC stays the floor.
 *
 * This is the ONE place a timezone is resolved. Callers pass
 * `settings?.timezone ?? null` and nothing else decides a default.
 *
 * Takes `now` as an argument for the same reason expiryStatus takes `today`:
 * nothing in this module reads the clock itself.
 */
export function todayForExpiry(timezone: string | null, now: Date): Date {
  return calendarDayInTimeZone(resolveExpiryTimeZone(timezone).timeZone, now);
}

/** The calendar day `now` falls on in `timeZone`, as a UTC-midnight Date. */
function calendarDayInTimeZone(timeZone: string, now: Date): Date {
  let parts: { year: number; month: number; day: number };
  try {
    parts = calendarPartsInTimeZone(timeZone, now);
  } catch {
    parts = calendarPartsInTimeZone("UTC", now);
  }
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

/**
 * WHICH timezone decided an expiry verdict, and whether the user chose it.
 *
 * Extracted out of todayForExpiry rather than reimplemented beside it, because
 * a renderer that wants to disclose the deciding zone ("Expiry evaluated in
 * America/Denver (server default) on 2026-09-24.") must name the zone the
 * verdicts were ACTUALLY computed in. A second, independent resolution — even
 * one written to the same rules — can disagree with the rows it annotates the
 * moment either side changes. todayForExpiry now calls this, so there is one
 * resolution and one answer.
 *
 * `fromSetting` is false in two distinct cases that render identically: no
 * timezone saved at all (the out-of-the-box state), and a saved value Intl
 * does not recognise, which todayForExpiry discards in favour of UTC. Both are
 * "not the zone this install is configured for", which is the only distinction
 * a disclosure line needs to draw; a corrupt setting is not silently reported
 * as if it had been honoured.
 */
export function resolveExpiryTimeZone(timezone: string | null): {
  timeZone: string;
  fromSetting: boolean;
} {
  const candidate = timezone ?? systemTimeZone() ?? "UTC";
  try {
    // Constructing the formatter is what throws on an unrecognised zone; the
    // day itself is resolved by calendarDayInTimeZone from the answer here.
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return { timeZone: candidate, fromSetting: timezone !== null };
  } catch {
    return { timeZone: "UTC", fromSetting: false };
  }
}

/** The AppSettings columns an expiry verdict depends on. */
export interface ExpirySettings {
  timezone?: string | null;
  expiryWarningDays?: number | null;
}

export interface ExpiryContext {
  /** Pass straight to expiryStatus. */
  today: Date;
  /** Pass straight to expiryStatus. */
  warningDays: number;
  /** The IANA zone the verdicts were computed in. */
  timezone: string;
  /** False when `timezone` came from the host rather than AppSettings. */
  timezoneFromSetting: boolean;
}

/**
 * Everything an expiry verdict needs, resolved ONCE from ONE AppSettings read.
 *
 * Callers that only render badges can keep using todayForExpiry. Callers that
 * also DISCLOSE which timezone decided — the full-armory export's footnote,
 * the dashboard — take the whole context from here, so the disclosure and the
 * verdicts it annotates cannot come from two different resolutions of "today".
 */
export function resolveExpiryContext(
  settings: ExpirySettings | null | undefined,
  now: Date,
): ExpiryContext {
  const setting = settings?.timezone ?? null;
  const { timeZone, fromSetting } = resolveExpiryTimeZone(setting);
  return {
    today: calendarDayInTimeZone(timeZone, now),
    warningDays: settings?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS,
    timezone: timeZone,
    timezoneFromSetting: fromSetting,
  };
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
 *
 * PRECONDITION on `today` (and `expirationDate`, which is already
 * date-only by column type): its UTC year/month/day must already equal the
 * intended calendar day. A raw wall-clock `new Date()` does NOT satisfy
 * this in a negative-UTC-offset timezone — it is still yesterday locally for
 * hours after UTC has rolled over — so passing it straight in shifts
 * expired/soon/fine boundaries a day early every evening. Callers must
 * resolve `today` through `todayForExpiry(timezone, now)` first; do not
 * construct it any other way.
 */
export function expiryStatus(
  expirationDate: Date | null,
  today: Date,
  warningDays: number,
): ExpiryStatus {
  if (!expirationDate || Number.isNaN(expirationDate.getTime())) {
    // A corrupt/unparseable expirationDate is unusable, not reassuring — it
    // must not silently fall through the NaN comparisons below into "fine".
    // Treated the same as no date at all: "none".
    return "none";
  }
  if (Number.isNaN(today.getTime())) {
    // Same reasoning for an invalid `today`: no verdict can be computed, so
    // don't emit one that happens to fall out of a NaN comparison.
    return "none";
  }

  const window =
    Number.isFinite(warningDays) && warningDays >= 0
      ? warningDays
      : DEFAULT_EXPIRY_WARNING_DAYS;

  const diffDays = calendarDayNumber(expirationDate) - calendarDayNumber(today);

  if (diffDays < 0) return "expired";
  if (diffDays <= window) return "soon";
  return "fine";
}
