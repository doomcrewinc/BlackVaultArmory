import { describe, expect, it } from "vitest";
import { CATEGORY_SECTIONS, sectionBySlug } from "@/lib/categories";
import {
  addFormContext,
  capitalizeFirst,
  itemNoun,
  listWordingForSection,
} from "./wording";

describe("listWordingForSection", () => {
  it("builds every string from the section's nouns", () => {
    expect(
      listWordingForSection(sectionBySlug("magazines")!, "accessory"),
    ).toEqual({
      addLabel: "Add magazine",
      addHref: "/accessories/new?section=magazines",
      emptyTitle: "No magazines yet",
      emptyHint: sectionBySlug("magazines")!.emptyHint,
      addFirstLabel: "Add first magazine",
      totalLabel: "Total magazines",
      noMatch: "No magazines match the selected filter.",
    });
  });

  it("uses the block's words for one source of a mixed section", () => {
    const section = sectionBySlug("medical")!;
    expect(listWordingForSection(section, "gear")).toMatchObject({
      addLabel: "Add medical kit",
      addHref: "/gear/new?section=medical",
    });
    expect(listWordingForSection(section, "supply")).toMatchObject({
      addLabel: "Add medical supply",
      addHref: "/supplies/new?section=medical",
    });
  });
});

describe("addFormContext", () => {
  it("reads the section's words, return path and allowed values", () => {
    expect(addFormContext("accessory", "magazines")).toEqual({
      singular: "magazine",
      sectionLabel: "Magazines",
      returnHref: "/gear/magazines",
      allowedValues: ["MAGAZINE"],
    });
  });

  it("returns prep sections to their own group", () => {
    expect(addFormContext("gear", "armor")?.returnHref).toBe("/prep/armor");
  });

  it("limits a mixed section to the values of the form's own source", () => {
    expect(addFormContext("gear", "food-water")?.allowedValues).toEqual([
      "WATER_TREATMENT",
    ]);
    expect(addFormContext("supply", "food-water")?.allowedValues).toEqual([
      "FOOD",
      "WATER",
      "FILTER",
    ]);
  });

  it.each([
    ["an absent value", undefined],
    ["an empty value", ""],
    ["a null value", null],
    ["garbage", "../../evil"],
    ["a URL", "https://example.com"],
    ["a firearm section", "handguns"],
    ["a section of another kind", "knives"],
    ["a prototype key", "constructor"],
  ])("ignores %s", (_name, value) => {
    expect(addFormContext("accessory", value)).toBeNull();
  });

  it("builds the return path from the registry, never from the input", () => {
    for (const section of CATEGORY_SECTIONS) {
      for (const kind of ["accessory", "gear", "supply"] as const) {
        const context = addFormContext(kind, section.slug);
        if (context) {
          expect(context.returnHref).toBe(`/${section.group}/${section.slug}`);
        }
      }
    }
  });
});

describe("itemNoun", () => {
  it.each([
    ["accessory", "MAGAZINE", "magazine"],
    ["accessory", "STOCK", "part"],
    ["gear", "ARMOR", "armor piece"],
    ["gear", "MEDICAL_KIT", "medical kit"],
    ["supply", "MEDICAL", "medical supply"],
    ["supply", "CLEANING", "cleaning supply"],
  ] as const)("%s %s is a %s", (kind, value, noun) => {
    expect(itemNoun(kind, value)).toBe(noun);
  });

  it("falls back to the storage name for a value no section holds", () => {
    expect(itemNoun("accessory", "NOT_A_TYPE")).toBe("part");
  });
});

describe("capitalizeFirst", () => {
  it("raises the first letter only", () => {
    expect(capitalizeFirst("armor piece")).toBe("Armor piece");
    expect(capitalizeFirst("")).toBe("");
  });
});
