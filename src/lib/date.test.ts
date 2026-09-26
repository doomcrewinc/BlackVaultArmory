import { describe, expect, it } from "vitest";
import { hostTimeZone } from "@/test/host-timezone";
import {
  formatDateOnly,
  formatTimestamp,
  InvalidDateError,
  toDateOnlyUTC,
  todayLocalISO,
  toISODate,
} from "./date";

describe("toDateOnlyUTC", () => {
  it("normalizes a YYYY-MM-DD string to UTC midnight", () => {
    expect(toDateOnlyUTC("2026-09-20").toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("strips the time from a full ISO timestamp", () => {
    expect(toDateOnlyUTC("2026-09-20T18:45:12.345Z").toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    );
  });

  it("strips the time from a Date", () => {
    expect(toDateOnlyUTC(new Date("2026-09-20T23:59:59.999Z")).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    );
  });

  it("uses the UTC calendar day, not the local one", () => {
    // 01:30Z on the 21st is still the 20th in America/Denver. The UTC day wins,
    // because the stored value is UTC and the server cannot know the viewer's zone.
    expect(toDateOnlyUTC(new Date("2026-09-21T01:30:00.000Z")).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z"
    );
  });

  it("is idempotent", () => {
    const once = toDateOnlyUTC("2026-09-20");
    expect(toDateOnlyUTC(once).toISOString()).toBe(once.toISOString());
  });

  it("throws on an unparseable input rather than storing Invalid Date", () => {
    expect(() => toDateOnlyUTC("not-a-date")).toThrow(/invalid date/i);
  });

  it("reads a date-only string lexically, ignoring any time component", () => {
    // A naive datetime string is parsed as LOCAL by JS. Reading UTC components off
    // that would make the result depend on the time of day, so the date part is
    // taken lexically instead.
    expect(toDateOnlyUTC("2026-09-20T20:00:00").toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(toDateOnlyUTC("2026-09-20T10:00:00").toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("ignores an explicit offset in favour of the written calendar day", () => {
    // The user typed a day, not an instant.
    expect(toDateOnlyUTC("2026-09-20T23:00:00-06:00").toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    );
    expect(toDateOnlyUTC("2026-09-20T01:00:00+13:00").toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    );
  });

  it("is time-of-day independent for every string form", () => {
    const forms = [
      "2026-09-20",
      "2026-09-20T00:00:00",
      "2026-09-20T12:00:00",
      "2026-09-20T23:59:59",
      "2026-09-20T00:00:00Z",
      "2026-09-20T23:59:59Z",
    ];
    for (const form of forms) {
      expect(toDateOnlyUTC(form).toISOString(), `failed for ${form}`).toBe(
        "2026-09-20T00:00:00.000Z"
      );
    }
  });

  it("rejects out-of-range calendar values instead of rolling them over", () => {
    // Date.UTC normalizes these silently: Feb 30 -> Mar 2, month 13 -> next year.
    expect(() => toDateOnlyUTC("2026-02-30")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("2026-13-01")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("2026-00-10")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("2026-04-31")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("2026-09-00")).toThrow(/invalid date/i);
  });

  it("validates leap years through the round-trip check", () => {
    expect(toDateOnlyUTC("2028-02-29").toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(() => toDateOnlyUTC("2026-02-29")).toThrow(/invalid date/i);
  });

  it("reads unpadded month and day lexically rather than falling back", () => {
    // These previously bypassed the lexical path and were off by one in +UTC zones.
    expect(toDateOnlyUTC("2026-9-20").toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(toDateOnlyUTC("2026-09-5").toISOString()).toBe("2026-09-05T00:00:00.000Z");
    expect(toDateOnlyUTC("2026-1-5").toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("rejects strings that are not Y-M-D rather than guessing", () => {
    // JS parses these as LOCAL time, which is the bug this module exists to prevent.
    expect(() => toDateOnlyUTC("September 20, 2026")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("09/20/2026")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("20260920")).toThrow(/invalid date/i);
    expect(() => toDateOnlyUTC("")).toThrow(/invalid date/i);
  });

  it("throws a typed InvalidDateError so callers can map it to a 400", () => {
    expect(() => toDateOnlyUTC("2026-02-30")).toThrow(InvalidDateError);
  });
});

describe("formatDateOnly", () => {
  it("shows the stored calendar day, not the local one", () => {
    // This is the bug: under browser-local formatting in Denver this rendered "Sep 19".
    expect(formatDateOnly("2026-09-20T00:00:00.000Z")).toBe("Sep 20, 2026");
  });

  it("is pinned to UTC, so the host timezone cannot shift it", () => {
    // The suite runs in America/Denver (UTC-6). A local formatter would say Sep 19.
    expect(formatDateOnly(new Date("2026-09-20T00:00:00.000Z"))).toBe("Sep 20, 2026");
  });

  it("renders a dash for null and undefined", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly(undefined)).toBe("—");
  });

  it("renders the stored day identically in every timezone", () => {
    const original = process.env.TZ;
    try {
      for (const zone of ["Pacific/Pago_Pago", "UTC", "Pacific/Auckland"]) {
        process.env.TZ = zone;
        expect(formatDateOnly("2026-09-20T00:00:00.000Z"), zone).toBe("Sep 20, 2026");
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

describe("formatTimestamp", () => {
  it("renders in the supplied timezone", () => {
    const instant = "2026-09-20T02:00:00.000Z";
    expect(formatTimestamp(instant, "UTC")).toContain("Sep 20");
    // UTC-11: 02:00Z on the 20th is 15:00 on the 19th.
    expect(formatTimestamp(instant, "Pacific/Pago_Pago")).toContain("Sep 19");
    // UTC+13: 02:00Z on the 20th is 15:00 on the 20th.
    expect(formatTimestamp(instant, "Pacific/Auckland")).toContain("Sep 20");
  });

  it("renders a dash for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });
});

describe("toISODate", () => {
  it("renders a date-only value as machine-readable YYYY-MM-DD", () => {
    expect(toISODate(new Date("2026-09-20T00:00:00.000Z"))).toBe("2026-09-20");
  });

  it("is time-of-day independent, inheriting the lexical parsing", () => {
    expect(toISODate("2026-09-20T20:00:00")).toBe("2026-09-20");
  });

  it("returns an empty string for null so CSV cells stay blank", () => {
    expect(toISODate(null)).toBe("");
    expect(toISODate(undefined)).toBe("");
  });

  it("ignores an explicit offset in favour of the written calendar day", () => {
    expect(toISODate("2026-09-20T23:00:00-06:00")).toBe("2026-09-20");
  });
});

describe("todayLocalISO", () => {
  // todayLocalISO is the ONLY genuinely host-zone-sensitive function in the
  // app: everything else either uses Date.UTC or passes an explicit timeZone
  // to Intl, and is therefore zone-invariant by construction. So this block is
  // what the CI timezone matrix is actually for, and none of it may be gated
  // behind the pinned zone — a second leg that skipped these would re-run ~895
  // zone-invariant tests and prove nothing.
  //
  // Every expectation below is built with the LOCAL-time Date constructor
  // (`new Date(y, m, d, h, min)`), which means "this wall-clock moment in
  // whatever zone is running". No zone arithmetic is baked into any expected
  // value, so these hold in Denver, Auckland and anywhere else.

  // An INDEPENDENT oracle for "the calendar day in the host zone".
  // todayLocalISO reads Date's local-time getters (ECMA-262); this asks ICU
  // with an explicit zone. Two different implementations, so agreement is a
  // real result rather than a tautology. en-CA formats as YYYY-MM-DD.
  const localDayOracle = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: hostTimeZone(),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);

  // The naive implementation todayLocalISO replaced, kept to prove these
  // tests are not vacuous.
  const naiveUtc = (d: Date) => d.toISOString().slice(0, 10);

  it("returns the LOCAL date, not the UTC one, across the boundary", () => {
    // One minute either side of local midnight. In ANY zone offset from UTC by
    // at least a minute, at least one of these lands on a different UTC day.
    const justAfterMidnight = new Date(2026, 8, 20, 0, 1);
    const justBeforeMidnight = new Date(2026, 8, 20, 23, 59);

    for (const d of [justAfterMidnight, justBeforeMidnight]) {
      expect(todayLocalISO(d)).toBe("2026-09-20");
      expect(todayLocalISO(d)).toBe(localDayOracle(d));
    }

    // Not vacuous: anywhere but UTC itself, the naive rendering is WRONG for at
    // least one of those two instants. That off-by-one is exactly what
    // `new Date().toISOString().split("T")[0]` used to produce, and it is the
    // reason this function exists.
    const bothMatchNaiveUtc =
      naiveUtc(justAfterMidnight) === "2026-09-20" &&
      naiveUtc(justBeforeMidnight) === "2026-09-20";
    expect(bothMatchNaiveUtc).toBe(justAfterMidnight.getTimezoneOffset() === 0);
  });

  it("agrees with the naive UTC rendering exactly when the two calendar days coincide", () => {
    const localNoon = new Date(2026, 8, 20, 12, 0);
    expect(todayLocalISO(localNoon)).toBe("2026-09-20");
    expect(todayLocalISO(localNoon)).toBe(localDayOracle(localNoon));

    // Local noon shares the UTC calendar day in every zone within 12 hours of
    // UTC. Beyond that (Pacific/Kiritimati at +14) it does not, and the LOCAL
    // day still wins — which is the whole contract.
    if (naiveUtc(localNoon) === "2026-09-20") {
      expect(todayLocalISO(localNoon)).toBe(naiveUtc(localNoon));
    }
  });

  it("zero-pads month and day", () => {
    // January 5th, local, in whatever zone is running. Unpadded output
    // ("2026-1-5") is the exact historical bug family this matrix exists to
    // catch, and the property is entirely zone-independent.
    const earlyJanuary = new Date(2026, 0, 5, 12, 0);
    expect(todayLocalISO(earlyJanuary)).toBe("2026-01-05");
    expect(todayLocalISO(earlyJanuary)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
