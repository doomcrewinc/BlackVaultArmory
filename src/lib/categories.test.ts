import { describe, expect, it } from "vitest";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
  gearSectionForAccessory,
  gearWhereForSection,
  sectionBySlug,
  sectionsForGroup,
  vaultSectionForFirearm,
} from "./categories";
import { GEAR_CATEGORIES } from "./gear";
import {
  CUSTOM_SLOT_PREFIX,
  FIREARM_TYPES,
  NFA_CLASSES,
  SLOT_TYPES,
  UNSPECIFIED_FIREARM_TYPE,
} from "./types";

describe("registry shape", () => {
  it("has unique slugs", () => {
    const slugs = CATEGORY_SECTIONS.map((s) => s.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses url-safe slugs", () => {
    for (const section of CATEGORY_SECTIONS) {
      expect(section.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("gives every section a label, description and icon", () => {
    for (const section of CATEGORY_SECTIONS) {
      expect(section.label).toBeTruthy();
      expect(section.description).toBeTruthy();
      expect(section.icon).toBeTruthy();
      expect(section.sources.length).toBeGreaterThan(0);
    }
  });

  it("resolves a slug, and refuses an unknown one", () => {
    expect(sectionBySlug("handguns")?.label).toBe("Handguns");
    expect(sectionBySlug("nope")).toBeUndefined();
  });

  it("groups sections in declaration order", () => {
    expect(sectionsForGroup("vault").map((s) => s.slug)).toEqual([
      "handguns",
      "rifles",
      "shotguns",
      "other-firearms",
      "sbr",
      "sbs",
      "machine-guns",
      "aow",
      "destructive-devices",
    ]);
    expect(sectionsForGroup("gear").map((s) => s.slug)).toEqual([
      "optics",
      "suppressors",
      "barrels",
      "lowers",
      "magazines",
      "parts",
      "knives",
      "cases",
    ]);
  });
});

// Values no build knows: a typo, an empty column, the right class in the wrong
// case, and a class a later version might add. Each must still land somewhere.
const UNKNOWN_CLASSES = ["NOT_A_CLASS", "", "machine_gun", "ZZ_FUTURE_CLASS"];
const UNKNOWN_TYPES = ["ZZ_MADE_UP", "", "pistol"];

function vaultSectionsMatching(row: { type: string; nfaClass: string }) {
  return sectionsForGroup("vault").filter((section) =>
    section.sources.some(
      (source) => source.source === "firearm" && source.holds(row),
    ),
  );
}

function gearSectionsMatching(row: { type: string }) {
  return sectionsForGroup("gear").filter((section) =>
    section.sources.some(
      (source) => source.source === "accessory" && source.holds(row),
    ),
  );
}

describe("firearm placement", () => {
  it("places every platform with no class in exactly one vault section", () => {
    const platforms = [
      ...FIREARM_TYPES,
      UNSPECIFIED_FIREARM_TYPE,
      "ZZ_MADE_UP",
    ];
    for (const type of platforms) {
      const matches = sectionsForGroup("vault").filter((section) =>
        section.sources.some(
          (source) =>
            source.source === "firearm" &&
            source.holds({ type, nfaClass: "NONE" }),
        ),
      );
      expect(
        matches.map((m) => m.slug),
        `type ${type}`,
      ).toHaveLength(1);
    }
  });

  it("places every class in exactly one vault section, whatever the platform", () => {
    for (const nfaClass of NFA_CLASSES) {
      for (const type of FIREARM_TYPES) {
        const matches = sectionsForGroup("vault").filter((section) =>
          section.sources.some(
            (source) =>
              source.source === "firearm" && source.holds({ type, nfaClass }),
          ),
        );
        expect(matches, `${type} / ${nfaClass}`).toHaveLength(1);
      }
    }
  });

  it("places a class this build does not know in exactly one vault section", () => {
    for (const nfaClass of UNKNOWN_CLASSES) {
      for (const type of [
        ...FIREARM_TYPES,
        UNSPECIFIED_FIREARM_TYPE,
        ...UNKNOWN_TYPES,
      ]) {
        const matches = vaultSectionsMatching({ type, nfaClass });
        expect(
          matches.map((m) => m.slug),
          `${type} / ${nfaClass}`,
        ).toEqual(["other-firearms"]);
      }
    }
  });

  it("sends a select-fire PDW to machine guns, not to a platform section", () => {
    expect(
      vaultSectionForFirearm({ type: "PDW", nfaClass: "MACHINE_GUN" })?.slug,
    ).toBe("machine-guns");
    expect(
      vaultSectionForFirearm({ type: "PDW", nfaClass: "NONE" })?.slug,
    ).toBe("other-firearms");
  });

  it("groups the platforms the way the spec says", () => {
    expect(
      vaultSectionForFirearm({ type: "PISTOL", nfaClass: "NONE" })?.slug,
    ).toBe("handguns");
    expect(
      vaultSectionForFirearm({ type: "REVOLVER", nfaClass: "NONE" })?.slug,
    ).toBe("handguns");
    expect(
      vaultSectionForFirearm({ type: "RIFLE", nfaClass: "NONE" })?.slug,
    ).toBe("rifles");
    expect(
      vaultSectionForFirearm({ type: "PCC", nfaClass: "NONE" })?.slug,
    ).toBe("rifles");
    expect(
      vaultSectionForFirearm({ type: "BOLT_ACTION", nfaClass: "NONE" })?.slug,
    ).toBe("rifles");
    expect(
      vaultSectionForFirearm({ type: "LEVER_ACTION", nfaClass: "NONE" })?.slug,
    ).toBe("rifles");
    expect(
      vaultSectionForFirearm({ type: "SHOTGUN", nfaClass: "NONE" })?.slug,
    ).toBe("shotguns");
    expect(
      vaultSectionForFirearm({ type: "SMG", nfaClass: "NONE" })?.slug,
    ).toBe("other-firearms");
  });

  it("never loses a firearm whose type was never set", () => {
    expect(
      vaultSectionForFirearm({
        type: UNSPECIFIED_FIREARM_TYPE,
        nfaClass: "NONE",
      })?.slug,
    ).toBe("other-firearms");
  });
});

describe("accessory placement", () => {
  it("places every slot type in exactly one gear section", () => {
    const types = [
      ...SLOT_TYPES,
      `${CUSTOM_SLOT_PREFIX}Cheek Riser`,
      ...UNKNOWN_TYPES,
    ];
    for (const type of types) {
      expect(
        gearSectionsMatching({ type }).map((m) => m.slug),
        `type ${type}`,
      ).toHaveLength(1);
    }
  });

  it("places a type this build does not know in the parts catch-all", () => {
    for (const type of UNKNOWN_TYPES) {
      expect(
        gearSectionsMatching({ type }).map((m) => m.slug),
        `type ${type}`,
      ).toEqual(["parts"]);
    }
  });

  it("groups the accessory types the way the spec says", () => {
    expect(gearSectionForAccessory({ type: "OPTIC" })?.slug).toBe("optics");
    expect(gearSectionForAccessory({ type: "OPTIC_MOUNT" })?.slug).toBe(
      "optics",
    );
    expect(gearSectionForAccessory({ type: "SUPPRESSOR" })?.slug).toBe(
      "suppressors",
    );
    expect(gearSectionForAccessory({ type: "BARREL" })?.slug).toBe("barrels");
    expect(gearSectionForAccessory({ type: "LOWER_RECEIVER" })?.slug).toBe(
      "lowers",
    );
    expect(gearSectionForAccessory({ type: "UPPER_RECEIVER" })?.slug).toBe(
      "lowers",
    );
    expect(gearSectionForAccessory({ type: "MAGAZINE" })?.slug).toBe(
      "magazines",
    );
    expect(gearSectionForAccessory({ type: "TRIGGER" })?.slug).toBe("parts");
    expect(
      gearSectionForAccessory({ type: `${CUSTOM_SLOT_PREFIX}Cheek Riser` })
        ?.slug,
    ).toBe("parts");
  });
});

describe("where fragments agree with holds", () => {
  type Clause = string | { in?: string[]; notIn?: string[] } | undefined;
  type Where = Record<string, unknown>;

  const fieldMatches = (clause: Clause, value: string): boolean => {
    if (clause === undefined) return true;
    if (typeof clause === "string") return clause === value;
    if (clause.in) return clause.in.includes(value);
    if (clause.notIn) return !clause.notIn.includes(value);
    return true;
  };

  // A miniature Prisma evaluator: enough of `where` for these fragments (field
  // equality, `in`, `notIn`, and a top-level `OR`), so the row under test is
  // never derived from the fragment it is meant to check.
  const whereMatches = (where: Where, row: Record<string, string>): boolean =>
    Object.entries(where).every(([field, clause]) => {
      if (field === "OR") {
        return (clause as Where[]).some((branch) => whereMatches(branch, row));
      }
      return fieldMatches(clause as Clause, row[field] ?? "");
    });

  it("selects the same firearms as holds, for every platform and every class", () => {
    const classes = [...NFA_CLASSES, ...UNKNOWN_CLASSES];
    const types = [
      ...FIREARM_TYPES,
      UNSPECIFIED_FIREARM_TYPE,
      ...UNKNOWN_TYPES,
    ];
    for (const section of sectionsForGroup("vault")) {
      const where = firearmWhereForSection(section) as Where | null;
      if (!where) continue;
      for (const nfaClass of classes) {
        for (const type of types) {
          const row = { type, nfaClass };
          const byHolds = section.sources.some(
            (source) => source.source === "firearm" && source.holds(row),
          );
          expect(
            whereMatches(where, row),
            `${section.slug} / ${type} / ${nfaClass}`,
          ).toBe(byHolds);
        }
      }
    }
  });

  it("selects the same accessories as holds, for every slot type", () => {
    for (const section of sectionsForGroup("gear")) {
      const where = accessoryWhereForSection(section) as Where | null;
      if (!where) continue;
      for (const type of [
        ...SLOT_TYPES,
        `${CUSTOM_SLOT_PREFIX}Cheek Riser`,
        ...UNKNOWN_TYPES,
      ]) {
        const byHolds = section.sources.some(
          (source) => source.source === "accessory" && source.holds({ type }),
        );
        expect(whereMatches(where, { type }), `${section.slug} / ${type}`).toBe(
          byHolds,
        );
      }
    }
  });
});

describe("gear-backed sections", () => {
  it("adds knives and cases to the gear group, after the accessory sections", () => {
    expect(sectionsForGroup("gear").map((s) => s.slug)).toEqual([
      "optics",
      "suppressors",
      "barrels",
      "lowers",
      "magazines",
      "parts",
      "knives",
      "cases",
    ]);
  });

  it("places every gear category in exactly one section", () => {
    for (const category of GEAR_CATEGORIES) {
      const matches = sectionsForGroup("gear").filter((section) =>
        section.sources.some(
          (source) => source.source === "gear" && source.holds({ category }),
        ),
      );
      expect(
        matches.map((m) => m.slug),
        `category ${category}`,
      ).toHaveLength(1);
    }
  });

  it("never loses gear with an unrecognised category", () => {
    for (const category of ["ZZ_JUNK", "", "knife", "ARMOR"]) {
      const matches = sectionsForGroup("gear").filter((section) =>
        section.sources.some(
          (source) => source.source === "gear" && source.holds({ category }),
        ),
      );
      expect(
        matches.map((m) => m.slug),
        `category ${category}`,
      ).toHaveLength(1);
    }
  });

  it("keeps accessory sections free of gear rows and vice versa", () => {
    const knives = sectionBySlug("knives")!;
    expect(accessoryWhereForSection(knives)).toBeNull();
    expect(gearWhereForSection(knives)).toEqual({
      category: { in: ["KNIFE"] },
    });

    const optics = sectionBySlug("optics")!;
    expect(gearWhereForSection(optics)).toBeNull();
  });

  it("no section uses a slug that would collide with a gear route segment", () => {
    const reserved = ["new", "item"];
    for (const section of CATEGORY_SECTIONS) {
      expect(reserved).not.toContain(section.slug);
    }
  });
});
