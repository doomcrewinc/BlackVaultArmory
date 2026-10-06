import { describe, expect, it } from "vitest";
import { CATEGORY_SECTIONS, sectionBySlug } from "@/lib/categories";
import {
  DEFAULT_LIST_WORDING,
  addFormContext,
  addFormSectionForAddress,
  itemNoun,
  listWordingForSection,
  sectionParam,
  titleCase,
} from "./wording";

describe("titleCase", () => {
  it.each([
    ["magazine", "Magazine"],
    ["armor piece", "Armor Piece"],
    ["food or water item", "Food or Water Item"],
    ["or the start of it", "Or the Start of It"],
    ["cleaning supplies", "Cleaning Supplies"],
    ["AOW", "AOW"],
    ["", ""],
  ])("%j becomes %j", (input, expected) => {
    expect(titleCase(input)).toBe(expected);
  });
});

describe("listWordingForSection", () => {
  it("builds labels in Title Case and sentences in sentence case", () => {
    expect(
      listWordingForSection(sectionBySlug("magazines")!, "accessory"),
    ).toEqual({
      addLabel: "Add Magazine",
      addHref: "/accessories/new?section=magazines",
      emptyTitle: "No magazines yet",
      emptyHint: sectionBySlug("magazines")!.emptyHint,
      addFirstLabel: "Add First Magazine",
      totalLabel: "Total Magazines",
      noMatch: "No magazines match the selected filter.",
    });
  });

  it("lets an uncountable noun say its own first-row button", () => {
    expect(
      listWordingForSection(sectionBySlug("armor")!, "gear"),
    ).toMatchObject({
      addLabel: "Add Armor",
      addFirstLabel: "Add Armor",
      emptyTitle: "No armor yet",
      totalLabel: "Total Armor",
    });
  });

  it("uses the block's words for one source of a mixed section", () => {
    const section = sectionBySlug("medical")!;
    expect(listWordingForSection(section, "gear")).toMatchObject({
      addLabel: "Add Medical Kit",
      addHref: "/gear/new?section=medical",
    });
    expect(listWordingForSection(section, "supply")).toMatchObject({
      addLabel: "Add Medical Supply",
      addHref: "/supplies/new?section=medical",
    });
  });

  it("uses 'or' in both forms of a block's noun", () => {
    expect(
      listWordingForSection(sectionBySlug("food-water")!, "supply"),
    ).toMatchObject({
      addLabel: "Add Food or Water Item",
      emptyTitle: "No food or water items yet",
    });
  });

  it("falls back to the default wording for a section with no words", () => {
    expect(listWordingForSection(sectionBySlug("handguns")!, "gear")).toBe(
      DEFAULT_LIST_WORDING.gear,
    );
  });
});

describe("DEFAULT_LIST_WORDING", () => {
  it.each([
    ["accessory", "Add Accessory", "No accessories yet", "Add First Accessory"],
    ["gear", "Add Gear", "No gear yet", "Add First Item"],
    ["supply", "Add Supply", "No supplies yet", "Add First Supply"],
  ] as const)(
    "%s keeps the wording it always had",
    (kind, add, empty, first) => {
      expect(DEFAULT_LIST_WORDING[kind]).toMatchObject({
        addLabel: add,
        emptyTitle: empty,
        addFirstLabel: first,
      });
    },
  );

  it("keeps Total Parts on the accessory list", () => {
    expect(DEFAULT_LIST_WORDING.accessory.totalLabel).toBe("Total Parts");
  });
});

describe("sectionParam", () => {
  it.each([
    ["section=magazines", "magazines"],
    ["", null],
    ["section=", null],
    ["other=1", null],
    ["section=magazines&section=optics", null],
    ["section=magazines&section=magazines", null],
  ])("%j gives %j", (query, expected) => {
    expect(sectionParam(new URLSearchParams(query))).toBe(expected);
  });
});

describe("addFormContext", () => {
  it("reads the section's words, return path and allowed values", () => {
    expect(addFormContext("accessory", "magazines")).toMatchObject({
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

describe("addFormSectionForAddress", () => {
  it.each([
    ["/accessories/new", "magazines", "magazines"],
    ["/gear/new", "armor", "armor"],
    ["/supplies/new", "medical", "medical"],
  ])("%s with %s names that section", (path, slug, expected) => {
    expect(addFormSectionForAddress(path, slug)?.slug).toBe(expected);
  });

  it.each([
    ["/accessories/new", "nonsense"],
    ["/accessories/new", "handguns"],
    ["/accessories/new", "knives"],
    ["/accessories/new", null],
    ["/gear/magazines", "magazines"],
    ["/accessories/abc", "magazines"],
    ["/", "magazines"],
  ])("%s with %s names no section", (path, slug) => {
    expect(addFormSectionForAddress(path, slug)).toBeNull();
  });
});

describe("itemNoun", () => {
  it.each([
    ["accessory", "MAGAZINE", "magazine"],
    ["accessory", "STOCK", "part"],
    ["gear", "ARMOR", "armor"],
    ["gear", "MEDICAL_KIT", "medical kit"],
    ["supply", "MEDICAL", "medical supply"],
    ["supply", "CLEANING", "cleaning supply"],
  ] as const)("%s %s is a %s", (kind, value, noun) => {
    expect(itemNoun(kind, value)).toBe(noun);
  });

  it("falls back to a section's noun for a value no section names", () => {
    expect(itemNoun("accessory", "NOT_A_TYPE")).toBe("part");
  });
});
