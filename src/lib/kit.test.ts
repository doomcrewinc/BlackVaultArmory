import { describe, expect, it } from "vitest";
import {
  DEFAULT_KIT_CATEGORY,
  KIT_CATEGORIES,
  KIT_CATEGORY_LABELS,
  KIT_ITEM_SOURCES,
  normalizeKitCategory,
} from "./kit";

describe("kit categories", () => {
  it("carries the six the spec names", () => {
    expect([...KIT_CATEGORIES]).toEqual([
      "BUGOUT",
      "MEDICAL",
      "RANGE",
      "VEHICLE",
      "HOME",
      "OTHER",
    ]);
  });

  it("labels every category, with no label left as the raw token", () => {
    for (const category of KIT_CATEGORIES) {
      const label = KIT_CATEGORY_LABELS[category];
      expect(label, `${category} has no label`).toBeTruthy();
      expect(label).not.toBe(category);
    }
  });

  it("falls back rather than throwing on input from outside the enum", () => {
    expect(normalizeKitCategory("NOPE")).toBe(DEFAULT_KIT_CATEGORY);
    expect(normalizeKitCategory(undefined)).toBe(DEFAULT_KIT_CATEGORY);
    expect(normalizeKitCategory("  bugout  ")).toBe("BUGOUT");
  });

  it("names the five KitItem foreign keys, in schema order", () => {
    expect([...KIT_ITEM_SOURCES]).toEqual([
      "gearId",
      "supplyId",
      "accessoryId",
      "ammoStockId",
      "firearmId",
    ]);
  });
});
