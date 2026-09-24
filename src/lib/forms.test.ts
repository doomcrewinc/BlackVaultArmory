import { describe, expect, it } from "vitest";
import { parseOptionalNumber } from "./forms";

describe("parseOptionalNumber", () => {
  it("returns null for a field the user left blank", () => {
    // The defect this guards: Number("") is 0, and 0 passes a
    // `Number.isFinite(parsed) && parsed >= 0` guard, so a blank purchase price
    // used to be stored as a real $0 instead of null.
    expect(parseOptionalNumber("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(parseOptionalNumber("   ")).toBeNull();
  });

  it("returns null for a missing field", () => {
    const data = new FormData();
    expect(parseOptionalNumber(data.get("purchasePrice"))).toBeNull();
  });

  it("returns null for a non-numeric value", () => {
    expect(parseOptionalNumber("abc")).toBeNull();
  });

  it("keeps a deliberately typed zero", () => {
    expect(parseOptionalNumber("0")).toBe(0);
    expect(parseOptionalNumber("0.00")).toBe(0);
  });

  it("parses real numbers, including negatives and decimals", () => {
    expect(parseOptionalNumber("249.99")).toBe(249.99);
    expect(parseOptionalNumber("-5")).toBe(-5);
  });

  it("reads straight off a FormData built from an empty numeric input", () => {
    const data = new FormData();
    data.set("purchasePrice", "");
    expect(parseOptionalNumber(data.get("purchasePrice"))).toBeNull();
  });
});
