import { describe, expect, it } from "vitest";
import { normalizeQuantity } from "./quantity";

describe("normalizeQuantity", () => {
  it("defaults to 1", () => {
    expect(normalizeQuantity(undefined)).toBe(1);
    expect(normalizeQuantity(null)).toBe(1);
    expect(normalizeQuantity("")).toBe(1);
  });

  it("accepts a positive whole number, as a number or a string", () => {
    expect(normalizeQuantity(12)).toBe(12);
    expect(normalizeQuantity("12")).toBe(12);
  });

  it("floors a fraction — you cannot own half a magazine", () => {
    expect(normalizeQuantity(2.7)).toBe(2);
  });

  it("refuses zero and negatives, falling back", () => {
    expect(normalizeQuantity(0)).toBe(1);
    expect(normalizeQuantity(-3)).toBe(1);
  });

  it("refuses nonsense", () => {
    expect(normalizeQuantity("abc")).toBe(1);
    expect(normalizeQuantity({})).toBe(1);
    expect(normalizeQuantity(Number.NaN)).toBe(1);
    expect(normalizeQuantity(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it("honours an explicit fallback, for PATCH keeping the stored value", () => {
    expect(normalizeQuantity(undefined, 9)).toBe(9);
    expect(normalizeQuantity("bad", 9)).toBe(9);
  });
});
