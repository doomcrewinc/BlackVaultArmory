import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPIRY_WARNING_DAYS,
  DEFAULT_SUPPLY_CATEGORY,
  DEFAULT_SUPPLY_UNIT,
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  SUPPLY_UNITS,
  SUPPLY_UNIT_LABELS,
  expiryStatus,
  isLowStock,
  normalizeAmount,
  normalizeSupplyCategory,
  normalizeSupplyUnit,
  todayForExpiry,
} from "./supply";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("enums", () => {
  it("labels every category and unit", () => {
    for (const c of SUPPLY_CATEGORIES) expect(SUPPLY_CATEGORY_LABELS[c]).toBeTruthy();
    for (const u of SUPPLY_UNITS) expect(SUPPLY_UNIT_LABELS[u]).toBeTruthy();
  });

  it("defaults to values that exist", () => {
    expect(SUPPLY_CATEGORIES).toContain(DEFAULT_SUPPLY_CATEGORY);
    expect(SUPPLY_UNITS).toContain(DEFAULT_SUPPLY_UNIT);
  });
});

describe("normalizeSupplyCategory / normalizeSupplyUnit", () => {
  it("accepts, trims and upper-cases", () => {
    expect(normalizeSupplyCategory(" medical ")).toBe("MEDICAL");
    expect(normalizeSupplyUnit(" gal ")).toBe("GAL");
  });

  it("falls back on anything unrecognised, including whitespace", () => {
    for (const bad of ["ZZ", "", "   ", undefined, null, 7, {}]) {
      expect(normalizeSupplyCategory(bad), String(bad)).toBe(DEFAULT_SUPPLY_CATEGORY);
      expect(normalizeSupplyUnit(bad), String(bad)).toBe(DEFAULT_SUPPLY_UNIT);
    }
  });
});

describe("normalizeAmount", () => {
  it("keeps decimals — solvent comes in fractions of an ounce", () => {
    expect(normalizeAmount(12.5)).toBe(12.5);
    expect(normalizeAmount("0.75")).toBe(0.75);
  });

  it("keeps a real zero", () => {
    expect(normalizeAmount(0)).toBe(0);
    expect(normalizeAmount("0")).toBe(0);
  });

  it("treats blank AND whitespace as absent, never as zero", () => {
    expect(normalizeAmount("")).toBeNull();
    expect(normalizeAmount("   ")).toBeNull();
    expect(normalizeAmount(undefined)).toBeNull();
    expect(normalizeAmount(null)).toBeNull();
  });

  it("refuses negatives and nonsense", () => {
    expect(normalizeAmount(-1)).toBeNull();
    expect(normalizeAmount("abc")).toBeNull();
    expect(normalizeAmount(Number.NaN)).toBeNull();
    expect(normalizeAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rejects non-numeric, non-string types rather than coercing them", () => {
    // Number(true) is 1 — a boolean must not silently become a quantity.
    expect(normalizeAmount(true)).toBeNull();
    expect(normalizeAmount(false)).toBeNull();
    expect(normalizeAmount([])).toBeNull();
    expect(normalizeAmount({})).toBeNull();
  });

  it("honours a fallback, for an update that must preserve the stored value", () => {
    expect(normalizeAmount("", 12.5)).toBe(12.5);
    expect(normalizeAmount("   ", 12.5)).toBe(12.5);
    expect(normalizeAmount("bad", 12.5)).toBe(12.5);
  });
});

describe("isLowStock", () => {
  it("is low at or below the threshold", () => {
    expect(isLowStock({ quantity: 2, lowStockAlert: 4 })).toBe(true);
    expect(isLowStock({ quantity: 4, lowStockAlert: 4 })).toBe(true);
    expect(isLowStock({ quantity: 5, lowStockAlert: 4 })).toBe(false);
  });

  it("never low without a threshold", () => {
    expect(isLowStock({ quantity: 0, lowStockAlert: null })).toBe(false);
  });

  it("treats a zero threshold as a real threshold, low only at zero", () => {
    expect(isLowStock({ quantity: 0, lowStockAlert: 0 })).toBe(true);
    expect(isLowStock({ quantity: 0.5, lowStockAlert: 0 })).toBe(false);
  });
});

describe("expiryStatus", () => {
  const today = day("2026-06-15");

  it("is none without a date", () => {
    expect(expiryStatus(null, today, 90)).toBe("none");
  });

  it("is expired strictly before today", () => {
    expect(expiryStatus(day("2026-06-14"), today, 90)).toBe("expired");
  });

  it("is soon — not expired — on the day itself", () => {
    expect(expiryStatus(day("2026-06-15"), today, 90)).toBe("soon");
  });

  it("is soon inside the window and fine outside it", () => {
    expect(expiryStatus(day("2026-09-13"), today, 90)).toBe("soon");
    expect(expiryStatus(day("2026-09-14"), today, 90)).toBe("fine");
  });

  it("ignores time of day on both sides", () => {
    const lateToday = new Date("2026-06-15T23:59:59.000Z");
    expect(expiryStatus(new Date("2026-06-15T00:00:01.000Z"), lateToday, 90)).toBe("soon");
  });

  it("with a zero window warns only on the day itself", () => {
    expect(expiryStatus(day("2026-06-15"), today, 0)).toBe("soon");
    expect(expiryStatus(day("2026-06-16"), today, 0)).toBe("fine");
  });

  it("falls back on a malformed window rather than warning about everything", () => {
    expect(expiryStatus(day("2026-08-01"), today, -5)).toBe(
      expiryStatus(day("2026-08-01"), today, DEFAULT_EXPIRY_WARNING_DAYS),
    );
    expect(expiryStatus(day("2026-08-01"), today, Number.NaN)).toBe(
      expiryStatus(day("2026-08-01"), today, DEFAULT_EXPIRY_WARNING_DAYS),
    );
  });

  it("never reads the clock itself — same inputs, same answer", () => {
    const a = expiryStatus(day("2026-06-20"), today, 90);
    const b = expiryStatus(day("2026-06-20"), today, 90);
    expect(a).toBe(b);
    expect(a).toBe("soon");
  });

  it("treats an invalid expirationDate as no usable date, not as fine", () => {
    expect(expiryStatus(new Date("not-a-date"), today, 90)).toBe("none");
  });

  it("treats an invalid 'today' as unresolvable, not as fine", () => {
    expect(expiryStatus(day("2026-06-20"), new Date("not-a-date"), 90)).toBe(
      "none",
    );
  });
});

describe("todayForExpiry", () => {
  // 8pm Mountain Time on June 15 is already 03:00 UTC on June 16 — a raw
  // `new Date()` reads the wrong calendar day in this (or any
  // negative-UTC-offset) timezone. This is the precondition expiryStatus's
  // `today` argument depends on, and the reason this helper exists.
  const eveningInDenver = new Date("2026-06-15T20:00:00-07:00");

  it("resolves the caller's timezone's calendar day, not the instant's UTC day", () => {
    expect(todayForExpiry("America/Denver", eveningInDenver)).toEqual(
      day("2026-06-15"),
    );
  });

  it("documents the bug it fixes: a naive Date passed straight to expiryStatus gives a different, wrong verdict", () => {
    const resolvedToday = todayForExpiry("America/Denver", eveningInDenver);
    const somethingExpiringToday = day("2026-06-15");

    // The mistake this helper exists to prevent: passing `now` straight
    // into expiryStatus reads its UTC day (the 16th) and marks something
    // expiring TODAY as already expired, hours before local midnight.
    const naiveVerdict = expiryStatus(
      somethingExpiringToday,
      eveningInDenver,
      90,
    );
    // Resolving "today" through the caller's timezone first gives the
    // correct verdict: expiring today is "soon", not "expired".
    const correctVerdict = expiryStatus(
      somethingExpiringToday,
      resolvedToday,
      90,
    );

    expect(naiveVerdict).not.toBe(correctVerdict);
    expect(naiveVerdict).toBe("expired");
    expect(correctVerdict).toBe("soon");
  });

  it("falls back to UTC when timezone is null", () => {
    // UTC day here is the 16th — distinct from Denver's 15th above, so this
    // proves null falls back to UTC rather than silently defaulting to some
    // other zone.
    expect(todayForExpiry(null, eveningInDenver)).toEqual(day("2026-06-16"));
  });

  it("falls back to UTC on an unrecognised timezone rather than throwing", () => {
    expect(() => todayForExpiry("Not/AZone", eveningInDenver)).not.toThrow();
    expect(todayForExpiry("Not/AZone", eveningInDenver)).toEqual(
      day("2026-06-16"),
    );
  });

  it("resolves a timezone ahead of UTC, where the local day can lead the UTC day", () => {
    // 20:00 UTC on the 15th is already 05:00 the next morning in Tokyo
    // (UTC+9) — the local day is ahead of, not behind, the UTC day.
    const lateUtcAfternoon = new Date("2026-06-15T20:00:00Z");
    expect(todayForExpiry("Asia/Tokyo", lateUtcAfternoon)).toEqual(
      day("2026-06-16"),
    );
  });
});
