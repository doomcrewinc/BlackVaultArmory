import { describe, expect, it } from "vitest";
import { normalizeMoney } from "./money";

describe("normalizeMoney", () => {
  it("treats absent, blank and whitespace-only as not recorded", () => {
    expect(normalizeMoney(undefined)).toBeNull();
    expect(normalizeMoney(null)).toBeNull();
    expect(normalizeMoney("")).toBeNull();
    // Number(" ") is 0, so an untrimmed guard silently records a free item.
    expect(normalizeMoney("   ")).toBeNull();
  });

  it("rejects values that are not a non-negative finite number", () => {
    expect(normalizeMoney("abc")).toBeNull();
    expect(normalizeMoney(-1)).toBeNull();
    expect(normalizeMoney(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeMoney(Number.NaN)).toBeNull();
    expect(normalizeMoney({})).toBeNull();
  });

  it("accepts numbers and numeric strings, including zero", () => {
    expect(normalizeMoney(0)).toBe(0);
    expect(normalizeMoney("0")).toBe(0);
    expect(normalizeMoney("149.99")).toBe(149.99);
    expect(normalizeMoney(" 149.99 ")).toBe(149.99);
  });
});
