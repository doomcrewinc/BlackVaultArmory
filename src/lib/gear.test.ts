import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEAR_CATEGORY,
  GEAR_CATEGORIES,
  GEAR_CATEGORY_LABELS,
  isArmorCategory,
  normalizeGearArmorFields,
  normalizeGearCategory,
} from "./gear";

describe("gear categories", () => {
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

describe("the full category set", () => {
  it("carries every category the spec's section table places", () => {
    expect([...GEAR_CATEGORIES]).toEqual([
      "KNIFE",
      "CASE",
      "ARMOR",
      "MEDICAL_KIT",
      "WATER_TREATMENT",
      "POWER",
      "COMMS",
      "LIGHT",
      "FIRE",
      "SHELTER",
      "CLOTHING",
      "TOOL",
      "SANITATION",
      "CBRN",
      "NAVIGATION",
      "SIGNALING",
      "DOCUMENTS",
      "SAFETY",
      "BUGOUT",
      "OTHER",
    ]);
  });

  it("labels every category, with no label left as the raw enum value", () => {
    for (const category of GEAR_CATEGORIES) {
      const label = GEAR_CATEGORY_LABELS[category];
      expect(label, `${category} has no label`).toBeTruthy();
      expect(label).not.toBe(category);
    }
  });

  it("keeps KNIFE as the fallback, so an unknown category does not become armor", () => {
    expect(normalizeGearCategory("NOPE")).toBe("KNIFE");
    expect(normalizeGearCategory(undefined)).toBe("KNIFE");
  });

  it("recognises armor, and only armor, as carrying the armor fields", () => {
    expect(isArmorCategory("ARMOR")).toBe(true);
    for (const category of GEAR_CATEGORIES.filter((c) => c !== "ARMOR")) {
      expect(isArmorCategory(category), `${category} claimed armor`).toBe(false);
    }
    // Reached through restore and the sqlite->postgres copier, which do not
    // normalize: an unrecognised value is not armor.
    expect(isArmorCategory("armor")).toBe(false);
    expect(isArmorCategory("PLATE")).toBe(false);
  });
});

describe("normalizeGearArmorFields", () => {
  const stored = {
    category: "ARMOR",
    protectionLevel: "IIIA",
    armorSize: "M SAPI",
  };

  it("keeps the fields when the merged record is still armor", () => {
    expect(normalizeGearArmorFields({ existing: stored, body: {} })).toEqual({
      protectionLevel: "IIIA",
      armorSize: "M SAPI",
    });
  });

  it("clears the fields when the category moves off armor, even if the body never mentions them", () => {
    // The gate that matters: a PUT sending only { category: "TOOL" } must not
    // leave a plate rating attached to a hammer.
    expect(
      normalizeGearArmorFields({ existing: stored, body: { category: "TOOL" } }),
    ).toEqual({ protectionLevel: null, armorSize: null });
  });

  it("accepts the fields when the category moves onto armor in the same request", () => {
    expect(
      normalizeGearArmorFields({
        existing: { category: "TOOL", protectionLevel: null, armorSize: null },
        body: { category: "ARMOR", protectionLevel: "IV", armorSize: "L" },
      }),
    ).toEqual({ protectionLevel: "IV", armorSize: "L" });
  });

  it("treats an explicit null as clearing one nullable field", () => {
    expect(
      normalizeGearArmorFields({
        existing: stored,
        body: { protectionLevel: null },
      }),
    ).toEqual({ protectionLevel: null, armorSize: "M SAPI" });
  });

  it("treats a blank string as clearing, and trims what it keeps", () => {
    expect(
      normalizeGearArmorFields({
        existing: stored,
        body: { protectionLevel: "   ", armorSize: "  III  " },
      }),
    ).toEqual({ protectionLevel: null, armorSize: "III" });
  });

  it("preserves the fields on a category this build does not recognise", () => {
    // Forward compatibility, the rule restore already follows: a category a
    // later version added is not a reason to erase data this one cannot judge.
    expect(
      normalizeGearArmorFields({
        existing: { ...stored, category: "EXOSUIT" },
        body: {},
      }),
    ).toEqual({ protectionLevel: "IIIA", armorSize: "M SAPI" });
  });
});
