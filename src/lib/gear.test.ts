import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEAR_CATEGORY,
  GEAR_CATEGORIES,
  GEAR_CATEGORY_LABELS,
  normalizeGearCategory,
} from "./gear";

describe("gear categories", () => {
  it("covers the phase 2 categories", () => {
    expect(GEAR_CATEGORIES).toEqual(["KNIFE", "CASE"]);
  });

  it("labels every category", () => {
    for (const category of GEAR_CATEGORIES) {
      expect(GEAR_CATEGORY_LABELS[category]).toBeTruthy();
    }
  });

  it("defaults to a real category", () => {
    expect(GEAR_CATEGORIES).toContain(DEFAULT_GEAR_CATEGORY);
  });
});

describe("normalizeGearCategory", () => {
  it("accepts a known category", () => {
    expect(normalizeGearCategory("CASE")).toBe("CASE");
  });

  it("trims and upper-cases", () => {
    expect(normalizeGearCategory(" case ")).toBe("CASE");
  });

  it("falls back for anything it does not recognise", () => {
    expect(normalizeGearCategory("MADE_UP")).toBe(DEFAULT_GEAR_CATEGORY);
    expect(normalizeGearCategory("")).toBe(DEFAULT_GEAR_CATEGORY);
    expect(normalizeGearCategory(undefined)).toBe(DEFAULT_GEAR_CATEGORY);
    expect(normalizeGearCategory(null)).toBe(DEFAULT_GEAR_CATEGORY);
    expect(normalizeGearCategory(7)).toBe(DEFAULT_GEAR_CATEGORY);
  });
});
