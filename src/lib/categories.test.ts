import { describe, expect, it } from "vitest";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
  gearSectionForAccessory,
  sectionBySlug,
  sectionsForGroup,
  vaultSectionForFirearm,
} from "./categories";
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
    ]);
  });
});

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
      "ZZ_MADE_UP",
    ];
    for (const type of types) {
      const matches = sectionsForGroup("gear").filter((section) =>
        section.sources.some(
          (source) => source.source === "accessory" && source.holds({ type }),
        ),
      );
      expect(
        matches.map((m) => m.slug),
        `type ${type}`,
      ).toHaveLength(1);
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
  const inWhere = (where: Record<string, unknown>, value: string): boolean => {
    const clause = where.type as
      { in?: string[]; notIn?: string[] } | undefined;
    if (clause?.in) return clause.in.includes(value);
    if (clause?.notIn) return !clause.notIn.includes(value);
    return where.type === value;
  };

  it("selects the same firearms as holds, for every platform", () => {
    for (const section of sectionsForGroup("vault")) {
      const where = firearmWhereForSection(section) as Record<
        string,
        unknown
      > | null;
      if (!where) continue;
      for (const type of [...FIREARM_TYPES, UNSPECIFIED_FIREARM_TYPE]) {
        const row = { type, nfaClass: (where.nfaClass as string) ?? "NONE" };
        const byWhere =
          (where.nfaClass === undefined || where.nfaClass === row.nfaClass) &&
          (where.type === undefined || inWhere(where, type));
        const byHolds = section.sources.some(
          (source) => source.source === "firearm" && source.holds(row),
        );
        expect(byWhere, `${section.slug} / ${type}`).toBe(byHolds);
      }
    }
  });

  it("selects the same accessories as holds, for every slot type", () => {
    for (const section of sectionsForGroup("gear")) {
      const where = accessoryWhereForSection(section) as Record<
        string,
        unknown
      > | null;
      if (!where) continue;
      for (const type of SLOT_TYPES) {
        const byWhere = where.type === undefined || inWhere(where, type);
        const byHolds = section.sources.some(
          (source) => source.source === "accessory" && source.holds({ type }),
        );
        expect(byWhere, `${section.slug} / ${type}`).toBe(byHolds);
      }
    }
  });
});
