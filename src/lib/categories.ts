import { DEFAULT_NFA_CLASS, NFA_CLASSES } from "./types";

export type SectionGroup = "vault" | "gear" | "prep";
export type SectionSource = "firearm" | "accessory" | "gear" | "supply";

export type FirearmRow = { type: string; nfaClass: string };
export type AccessoryRow = { type: string };
export type GearRow = { category: string };
export type SupplyRow = { category: string };

export type SectionMatcher =
  | { source: "firearm"; where: object; holds: (row: FirearmRow) => boolean }
  | {
      source: "accessory";
      where: object;
      holds: (row: AccessoryRow) => boolean;
    }
  | {
      source: "gear";
      where: object;
      holds: (row: GearRow) => boolean;
    }
  | {
      source: "supply";
      where: object;
      holds: (row: SupplyRow) => boolean;
    };

export type CategorySection = {
  slug: string;
  label: string;
  description: string;
  group: SectionGroup;
  /**
   * lucide-react icon name. Declared for the later phases that give the section
   * list and its page headers their own icons; nothing renders it today — the
   * nav uses one icon per group and the section pages use `PageHeader`.
   */
  icon: string;
  sources: SectionMatcher[];
};

// Platform groupings. Catch-all sections are defined by NOT being in these
// lists, so a type nobody planned for — "UNSPECIFIED" from the firearms API, or
// anything added later — still lands somewhere visible.
const HANDGUN_TYPES = ["PISTOL", "REVOLVER"];
const RIFLE_TYPES = ["RIFLE", "BOLT_ACTION", "LEVER_ACTION", "PCC"];
const SHOTGUN_TYPES = ["SHOTGUN"];
const GROUPED_PLATFORMS = [...HANDGUN_TYPES, ...RIFLE_TYPES, ...SHOTGUN_TYPES];

const OPTIC_TYPES = ["OPTIC", "OPTIC_MOUNT"];
const SUPPRESSOR_TYPES = ["SUPPRESSOR"];
const BARREL_TYPES = ["BARREL"];
const RECEIVER_TYPES = ["LOWER_RECEIVER", "UPPER_RECEIVER"];
const MAGAZINE_TYPES = ["MAGAZINE"];
const GROUPED_ACCESSORIES = [
  ...OPTIC_TYPES,
  ...SUPPRESSOR_TYPES,
  ...BARREL_TYPES,
  ...RECEIVER_TYPES,
  ...MAGAZINE_TYPES,
];

function isKnownClass(nfaClass: string): boolean {
  return (NFA_CLASSES as readonly string[]).includes(nfaClass);
}

/** A Title I firearm on one of the listed platforms. */
function platformSection(types: string[]): SectionMatcher {
  return {
    source: "firearm",
    where: { nfaClass: DEFAULT_NFA_CLASS, type: { in: types } },
    holds: (row) =>
      row.nfaClass === DEFAULT_NFA_CLASS && types.includes(row.type),
  };
}

/**
 * Everything Title I that no platform section claimed, plus anything whose
 * stored class is not one this build knows.
 *
 * The class axis is gated positively everywhere else — platform sections demand
 * exactly `NONE`, class sections demand their own value — so the second branch
 * is what keeps the catch-all a real catch-all. Without it a row carrying an
 * unrecognised class matches ZERO sections and disappears from every section
 * page and nav count. Unreachable through the UI or the API (the normalizer
 * coerces an unknown class to NONE) but reachable through backup restore's
 * unvalidated createMany, the sqlite→postgres copier, Prisma Studio, and a
 * backup written by a later version that added a class this build lacks.
 *
 * The branches cannot both fire (one needs `NONE`, the other needs a class that
 * is not `NONE`), and an unknown class is excluded from every platform section
 * by their `NONE` gate, so any string lands here exactly once.
 */
function otherPlatformsSection(): SectionMatcher {
  return {
    source: "firearm",
    where: {
      OR: [
        { nfaClass: DEFAULT_NFA_CLASS, type: { notIn: GROUPED_PLATFORMS } },
        { nfaClass: { notIn: [...NFA_CLASSES] } },
      ],
    },
    holds: (row) =>
      (row.nfaClass === DEFAULT_NFA_CLASS &&
        !GROUPED_PLATFORMS.includes(row.type)) ||
      !isKnownClass(row.nfaClass),
  };
}

/** Everything of one NFA class, whatever its platform. */
function classSection(nfaClass: string): SectionMatcher {
  return {
    source: "firearm",
    where: { nfaClass },
    holds: (row) => row.nfaClass === nfaClass,
  };
}

function accessorySection(types: string[]): SectionMatcher {
  return {
    source: "accessory",
    where: { type: { in: types } },
    holds: (row) => types.includes(row.type),
  };
}

/** Components, custom slots, and anything unrecognised. */
function partsSection(): SectionMatcher {
  return {
    source: "accessory",
    where: { type: { notIn: GROUPED_ACCESSORIES } },
    holds: (row) => !GROUPED_ACCESSORIES.includes(row.type),
  };
}

const KNIFE_CATEGORIES = ["KNIFE"];
const CASE_CATEGORIES = ["CASE"];
const GROUPED_GEAR = [...KNIFE_CATEGORIES, ...CASE_CATEGORIES];

function gearSection(categories: string[]): SectionMatcher {
  return {
    source: "gear",
    where: { category: { in: categories } },
    holds: (row) => categories.includes(row.category),
  };
}

/**
 * Anything no gear section claimed — a category added to the schema before
 * its section exists (Phase 5 adds many more) must still be reachable, not
 * invisible. Rides on `cases` rather than a standalone "Other Gear" section
 * so the registry stays exactly-one today without inventing a section Phase 5
 * will restructure anyway. Mutually exclusive with `gearSection(CASE_CATEGORIES)`
 * on the same section (one demands membership in GROUPED_GEAR, the other demands
 * exclusion from it), so the two matchers never both fire.
 */
function otherGearSection(): SectionMatcher {
  return {
    source: "gear",
    where: { category: { notIn: GROUPED_GEAR } },
    holds: (row) => !GROUPED_GEAR.includes(row.category),
  };
}

const CLEANING_CATEGORIES = ["CLEANING"];
const MEDICAL_CATEGORIES = ["MEDICAL"];
const FOOD_WATER_CATEGORIES = ["FOOD", "WATER", "FILTER"];
// Every SupplyCategory an explicit section claims. Used by otherSupplySection
// below to build the negation — not just food-water's own explicit branch —
// so CLEANING and MEDICAL rows can never double-match into food-water too.
const GROUPED_SUPPLIES = [
  ...CLEANING_CATEGORIES,
  ...MEDICAL_CATEGORIES,
  ...FOOD_WATER_CATEGORIES,
];

function supplySection(categories: string[]): SectionMatcher {
  return {
    source: "supply",
    where: { category: { in: categories } },
    holds: (row) => categories.includes(row.category),
  };
}

/**
 * Everything no supply section claims yet: BATTERY, FUEL, SANITATION,
 * CBRN_FILTER, SIGNAL, OTHER, and any category this build does not
 * recognise. Phase 4 only builds Cleaning, Medical and Food & Water —
 * Power & Comms, Shelter & Clothing, Tools & Fire and Other Prep are phase
 * 5's job — so the six categories above are deliberately, temporarily
 * homeless. They ride on Food & Water for now, the same way `cases` rides
 * otherGearSection() for gear categories phase 2 hadn't built sections for
 * yet. Phase 5 restructures this into their own sections.
 *
 * Mutually exclusive with `supplySection(FOOD_WATER_CATEGORIES)` on the same
 * section (one demands membership in GROUPED_SUPPLIES, the other demands
 * exclusion from it), so the two matchers never both fire — and excluding
 * CLEANING/MEDICAL here (not just FOOD/WATER/FILTER) keeps rows claimed by
 * the cleaning and medical sections from also matching food-water's OR.
 */
function otherSupplySection(): SectionMatcher {
  return {
    source: "supply",
    where: { category: { notIn: GROUPED_SUPPLIES } },
    holds: (row) => !GROUPED_SUPPLIES.includes(row.category),
  };
}

export const CATEGORY_SECTIONS: CategorySection[] = [
  {
    slug: "handguns",
    label: "Handguns",
    description: "Pistols & revolvers",
    group: "vault",
    icon: "Crosshair",
    sources: [platformSection(HANDGUN_TYPES)],
  },
  {
    slug: "rifles",
    label: "Rifles",
    description: "Rifles, PCCs & bolt guns",
    group: "vault",
    icon: "Crosshair",
    sources: [platformSection(RIFLE_TYPES)],
  },
  {
    slug: "shotguns",
    label: "Shotguns",
    description: "Shotguns",
    group: "vault",
    icon: "Crosshair",
    sources: [platformSection(SHOTGUN_TYPES)],
  },
  {
    slug: "other-firearms",
    label: "Other",
    description: "Unsorted & other platforms",
    group: "vault",
    icon: "Shield",
    sources: [otherPlatformsSection()],
  },
  {
    slug: "sbr",
    label: "SBR",
    description: "Short-barreled rifles",
    group: "vault",
    icon: "Shield",
    sources: [classSection("SBR")],
  },
  {
    slug: "sbs",
    label: "SBS",
    description: "Short-barreled shotguns",
    group: "vault",
    icon: "Shield",
    sources: [classSection("SBS")],
  },
  {
    slug: "machine-guns",
    label: "Machine Guns",
    description: "Select-fire, any platform",
    group: "vault",
    icon: "Shield",
    sources: [classSection("MACHINE_GUN")],
  },
  {
    slug: "aow",
    label: "AOW",
    description: "Any other weapon",
    group: "vault",
    icon: "Shield",
    sources: [classSection("AOW")],
  },
  {
    slug: "destructive-devices",
    label: "Destructive Devices",
    description: "DD-classified items",
    group: "vault",
    icon: "Shield",
    sources: [classSection("DESTRUCTIVE_DEVICE")],
  },
  {
    slug: "optics",
    label: "Optics",
    description: "Sights & mounts",
    group: "gear",
    icon: "Crosshair",
    sources: [accessorySection(OPTIC_TYPES)],
  },
  {
    slug: "suppressors",
    label: "Suppressors",
    description: "Silencers",
    group: "gear",
    icon: "Crosshair",
    sources: [accessorySection(SUPPRESSOR_TYPES)],
  },
  {
    slug: "barrels",
    label: "Barrels",
    description: "Spare & swap barrels",
    group: "gear",
    icon: "Crosshair",
    sources: [accessorySection(BARREL_TYPES)],
  },
  {
    slug: "lowers",
    label: "Lowers",
    description: "Receivers",
    group: "gear",
    icon: "Layers",
    sources: [accessorySection(RECEIVER_TYPES)],
  },
  {
    slug: "magazines",
    label: "Magazines",
    description: "Mags & drums",
    group: "gear",
    icon: "Layers",
    sources: [accessorySection(MAGAZINE_TYPES)],
  },
  {
    slug: "parts",
    label: "Parts",
    description: "Components & everything else",
    group: "gear",
    icon: "Settings2",
    sources: [partsSection()],
  },
  {
    slug: "knives",
    label: "Knives",
    description: "Blades & multitools",
    group: "gear",
    icon: "Crosshair",
    sources: [gearSection(KNIFE_CATEGORIES)],
  },
  {
    slug: "cases",
    label: "Cases",
    description: "Cases & storage",
    group: "gear",
    icon: "Layers",
    sources: [gearSection(CASE_CATEGORIES), otherGearSection()],
  },
  {
    slug: "cleaning",
    label: "Cleaning",
    description: "Solvents, oils & cleaning supplies",
    group: "gear",
    icon: "SprayCan",
    sources: [supplySection(CLEANING_CATEGORIES)],
  },
  {
    slug: "medical",
    label: "Medical",
    description: "First aid & medical supplies",
    group: "prep",
    icon: "Cross",
    sources: [supplySection(MEDICAL_CATEGORIES)],
  },
  {
    slug: "food-water",
    label: "Food & Water",
    description: "Food, water & filtration",
    group: "prep",
    icon: "Droplets",
    sources: [supplySection(FOOD_WATER_CATEGORIES), otherSupplySection()],
  },
];

export function sectionBySlug(slug: string): CategorySection | undefined {
  return CATEGORY_SECTIONS.find((section) => section.slug === slug);
}

export function sectionsForGroup(group: SectionGroup): CategorySection[] {
  return CATEGORY_SECTIONS.filter((section) => section.group === group);
}

export function firearmWhereForSection(
  section: CategorySection,
): object | null {
  return (
    section.sources.find((source) => source.source === "firearm")?.where ?? null
  );
}

export function accessoryWhereForSection(
  section: CategorySection,
): object | null {
  return (
    section.sources.find((source) => source.source === "accessory")?.where ??
    null
  );
}

export function vaultSectionForFirearm(
  row: FirearmRow,
): CategorySection | undefined {
  return sectionsForGroup("vault").find((section) =>
    section.sources.some(
      (source) => source.source === "firearm" && source.holds(row),
    ),
  );
}

export function gearSectionForAccessory(
  row: AccessoryRow,
): CategorySection | undefined {
  return sectionsForGroup("gear").find((section) =>
    section.sources.some(
      (source) => source.source === "accessory" && source.holds(row),
    ),
  );
}

export function gearWhereForSection(section: CategorySection): object | null {
  const matchers = section.sources.filter((source) => source.source === "gear");
  if (matchers.length === 0) return null;
  if (matchers.length === 1) return matchers[0].where;
  return { OR: matchers.map((matcher) => matcher.where) };
}

export function gearSectionForItem(row: GearRow): CategorySection | undefined {
  return sectionsForGroup("gear").find((section) =>
    section.sources.some(
      (source) => source.source === "gear" && source.holds(row),
    ),
  );
}

export function supplyWhereForSection(section: CategorySection): object | null {
  const matchers = section.sources.filter(
    (source) => source.source === "supply",
  );
  if (matchers.length === 0) return null;
  if (matchers.length === 1) return matchers[0].where;
  return { OR: matchers.map((matcher) => matcher.where) };
}

/**
 * Unlike vaultSectionForFirearm/gearSectionForAccessory, this searches every
 * section rather than one group's — cleaning's supply source lives in the
 * "gear" group while medical's and food-water's live in "prep", so a
 * group-scoped search would miss cleaning.
 */
export function supplySectionForItem(
  row: SupplyRow,
): CategorySection | undefined {
  return CATEGORY_SECTIONS.find((section) =>
    section.sources.some(
      (source) => source.source === "supply" && source.holds(row),
    ),
  );
}
