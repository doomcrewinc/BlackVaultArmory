import { describe, expect, it, vi } from "vitest";
import { IS_PINNED_HOST_ZONE } from "@/test/host-timezone";
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
  resolveExpiryContext,
  resolveExpiryTimeZone,
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

  it.skipIf(!IS_PINNED_HOST_ZONE)("falls back to the HOST timezone when timezone is null, not to UTC", () => {
    // AppSettings.timezone is NULL out of the box and stays NULL on any
    // install whose owner never opened Settings, so this is the DEFAULT path,
    // not an edge case. Hardcoding UTC here re-opened the off-by-one above:
    // west of UTC, every evening, a supply expiring today read `expired`.
    //
    // This suite runs with TZ=America/Denver (vitest.config.ts), so the host
    // day for this instant is the 15th while the UTC day is already the 16th
    // — the two answers are distinguishable, which is what makes the
    // assertion meaningful.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(
      "America/Denver",
    );
    expect(todayForExpiry(null, eveningInDenver)).toEqual(day("2026-06-15"));
    expect(todayForExpiry(null, eveningInDenver)).toEqual(
      todayForExpiry("America/Denver", eveningInDenver),
    );
  });

  it("falls back to UTC when the host cannot name a timezone", () => {
    // The floor under the host-zone fallback. Only the zero-argument call —
    // the one systemTimeZone() makes — is stubbed; the explicit-zone lookup
    // must keep working, or this would pass for the wrong reason.
    const real = Intl.DateTimeFormat;
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(((...args: unknown[]) =>
        args.length === 0
          ? {
              resolvedOptions: () => {
                throw new Error("no Intl data");
              },
            }
          : new (real as unknown as new (
              ...a: unknown[]
            ) => Intl.DateTimeFormat)(...args)) as never);
    try {
      expect(todayForExpiry(null, eveningInDenver)).toEqual(day("2026-06-16"));
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to UTC when the host names a timezone Intl does not recognise", () => {
    const real = Intl.DateTimeFormat;
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(((...args: unknown[]) =>
        args.length === 0
          ? { resolvedOptions: () => ({ timeZone: "Not/AZone" }) }
          : new (real as unknown as new (
              ...a: unknown[]
            ) => Intl.DateTimeFormat)(...args)) as never);
    try {
      expect(todayForExpiry(null, eveningInDenver)).toEqual(day("2026-06-16"));
    } finally {
      spy.mockRestore();
    }
  });

  it("falls back to UTC on a SET but unrecognised timezone rather than throwing", () => {
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

describe("resolveExpiryTimeZone", () => {
  // The vitest config pins TZ=America/Denver, so the host zone is knowable.
  it("reports a saved zone as the deciding one, and says it came from the setting", () => {
    expect(resolveExpiryTimeZone("Asia/Tokyo")).toEqual({
      timeZone: "Asia/Tokyo",
      fromSetting: true,
    });
  });

  it.skipIf(!IS_PINNED_HOST_ZONE)("names the HOST zone, not UTC, when nothing is saved", () => {
    // Hardcoding UTC here is the off-by-one todayForExpiry exists to close, so
    // a disclosure line that claimed UTC would be doubly wrong: wrong zone AND
    // inconsistent with the verdicts.
    expect(resolveExpiryTimeZone(null)).toEqual({
      timeZone: "America/Denver",
      fromSetting: false,
    });
  });

  it("discards a saved zone Intl does not recognise, and stops claiming it came from the setting", () => {
    // A stored value the user chose is not silently replaced with a different
    // REAL zone — it is discarded to UTC. Reporting fromSetting: true here
    // would make a footnote name UTC as if the owner had picked it.
    expect(resolveExpiryTimeZone("Mars/Olympus_Mons")).toEqual({
      timeZone: "UTC",
      fromSetting: false,
    });
    expect(resolveExpiryTimeZone("")).toEqual({
      timeZone: "UTC",
      fromSetting: false,
    });
  });

  it.skipIf(!IS_PINNED_HOST_ZONE)("agrees with the zone todayForExpiry actually resolved the day in", () => {
    // The whole point of the extraction: one resolution, so a disclosure
    // cannot name a zone other than the one that decided. 21:00 on June 15 in
    // Denver is already the 16th in UTC.
    const eveningInDenver = new Date("2026-06-16T03:00:00.000Z");
    const { timeZone } = resolveExpiryTimeZone(null);
    expect(timeZone).toBe("America/Denver");
    expect(todayForExpiry(null, eveningInDenver)).toEqual(day("2026-06-15"));
  });
});

describe("resolveExpiryContext", () => {
  const eveningInDenver = new Date("2026-06-16T03:00:00.000Z");

  it("resolves today, the window and the disclosed zone from one settings read", () => {
    expect(
      resolveExpiryContext(
        { timezone: "America/Denver", expiryWarningDays: 30 },
        eveningInDenver,
      ),
    ).toEqual({
      today: day("2026-06-15"),
      warningDays: 30,
      timezone: "America/Denver",
      timezoneFromSetting: true,
    });
  });

  it.skipIf(!IS_PINNED_HOST_ZONE)("falls back to the host zone and the default window with no settings row", () => {
    expect(resolveExpiryContext(null, eveningInDenver)).toEqual({
      today: day("2026-06-15"),
      warningDays: DEFAULT_EXPIRY_WARNING_DAYS,
      timezone: "America/Denver",
      timezoneFromSetting: false,
    });
  });

  it("resolves the same `today` todayForExpiry would, for every zone shape", () => {
    // The invariant the footnote depends on. If these ever diverge, a renderer
    // annotating rows mapped with todayForExpiry would name the wrong day.
    for (const timezone of [null, "UTC", "Asia/Tokyo", "America/Denver", "Not/AZone"]) {
      expect(resolveExpiryContext({ timezone }, eveningInDenver).today).toEqual(
        todayForExpiry(timezone, eveningInDenver),
      );
    }
  });

  it("keeps a zero warning window rather than defaulting it away", () => {
    // 0 is a real window — "warn only on the day itself" — not "unset", the
    // same distinction isLowStock draws for a zero threshold.
    expect(
      resolveExpiryContext({ timezone: "UTC", expiryWarningDays: 0 }, eveningInDenver)
        .warningDays,
    ).toBe(0);
  });
});
