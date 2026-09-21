import { describe, expect, it } from "vitest";
import { calverForDate, formatVersion } from "./version";

describe("calverForDate", () => {
  it("formats a date as YYYY.M.D in UTC", () => {
    expect(calverForDate(new Date("2026-09-20T12:00:00.000Z"))).toBe("2026.9.20");
  });

  it("strips leading zeros from month and day", () => {
    expect(calverForDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026.1.5");
  });

  it("keeps two-digit month and day intact", () => {
    expect(calverForDate(new Date("2026-12-31T00:00:00.000Z"))).toBe("2026.12.31");
  });

  it("uses UTC, not local time", () => {
    // 23:30 UTC on the 20th is still the 20th regardless of runner timezone
    expect(calverForDate(new Date("2026-09-20T23:30:00.000Z"))).toBe("2026.9.20");
  });

  it("always produces a semver-parseable string with no leading zeros", () => {
    const v = calverForDate(new Date("2026-01-05T00:00:00.000Z"));
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    for (const part of v.split(".")) {
      expect(part === "0" || !part.startsWith("0")).toBe(true);
    }
  });
});

describe("formatVersion", () => {
  it("appends a 7-character sha", () => {
    expect(formatVersion("2026.9.20", "e991c3749325b5daf6")).toBe("2026.9.20-e991c37");
  });

  it("leaves an already-short sha alone", () => {
    expect(formatVersion("2026.9.20", "e991c37")).toBe("2026.9.20-e991c37");
  });

  it("returns bare calver when sha is null", () => {
    expect(formatVersion("2026.9.20", null)).toBe("2026.9.20");
  });

  it("returns bare calver when sha is undefined", () => {
    expect(formatVersion("2026.9.20")).toBe("2026.9.20");
  });

  it("returns bare calver when sha is blank or whitespace", () => {
    expect(formatVersion("2026.9.20", "   ")).toBe("2026.9.20");
  });
});
