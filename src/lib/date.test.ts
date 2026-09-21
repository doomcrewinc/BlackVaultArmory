import { describe, expect, it } from "vitest";
import { formatDateOnly, formatTimestamp, toDateOnlyUTC, todayLocalISO } from "./date";

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

describe("todayLocalISO", () => {
  it("returns the LOCAL date, not the UTC one, across the boundary", () => {
    // 01:30Z on the 21st is 19:30 on the 20th in America/Denver.
    // The old `new Date().toISOString().split("T")[0]` returned 2026-09-21 here.
    expect(todayLocalISO(new Date("2026-09-21T01:30:00.000Z"))).toBe("2026-09-20");
  });

  it("agrees with UTC when the local day matches", () => {
    expect(todayLocalISO(new Date("2026-09-20T18:00:00.000Z"))).toBe("2026-09-20");
  });

  it("zero-pads month and day", () => {
    expect(todayLocalISO(new Date("2026-01-05T18:00:00.000Z"))).toBe("2026-01-05");
  });
});
