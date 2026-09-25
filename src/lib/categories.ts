import { isRenderableSource } from "./sections/renderableSources";
import { DEFAULT_NFA_CLASS, NFA_CLASSES } from "./types";

/**
 * Every nav group, in sidebar order. A `readonly` tuple rather than a bare
 * union so tests (and anything else) can WALK the groups instead of
 * re-listing them — the reachability test in categories.test.ts derives the
 * routes it checks from this and CATEGORY_SECTIONS, so a group or section
 * added here is checked without anyone remembering to update a list.
 */
export const SECTION_GROUPS = ["vault", "gear", "prep"] as const;

export type SectionGroup = (typeof SECTION_GROUPS)[number];
export type SectionSource = "firearm" | "accessory" | "gear" | "supply" | "kit";

/**
 * The source kinds whose section draws the WHOLE table, so their matcher
 * carries `where: {}` on purpose.
 *
 * Every other matcher in this file filters, and `loadSectionItems.test.ts`
 * asserts no query is issued with an empty `where` — `{}` IS an unfiltered
 * query, and a `?? undefined` coercion that produced one has caused two live
 * bugs in this epic. The spec's section table says `Preparedness | Kits |
 * kit, all`, so for `kit` an unfiltered query is the honest intent rather
 * than a bug, and that ONE test cannot be true of both.
 *
 * It is resolved here, in the registry, rather than by exempting a delegate
 * inside the test. Two things read this list and they check each other:
 *
 *   - the empty-`where` assertion skips the key-count check for these kinds
 *     alone, so an accidental `where: {}` on a firearm, accessory, gear or
 *     supply matcher still fails;
 *   - a second test asserts this list is EXACTLY the set of kinds for which
 *     some registered matcher carries an empty `where`. So a kind listed
 *     here that actually filters fails, and a kind that ships `{}` without
 *     being listed fails.
 *
 * A tautological `where` (`{ OR: [{ category: { in: ALL } }, { category: {
 * notIn: ALL } }] }`) was the alternative, and was rejected: it would satisfy
 * a guard built to detect unfiltered queries while BEING an unfiltered query.
 * That is the dead-guard shape phase 5 spent itself removing — the invariant
 * "every query this loader issues carries a filter" has genuinely stopped
 * being true, and the guard should say so out loud instead of being fooled.
 *
 * `satisfies` keeps the entries inside `SectionSource`, so a renamed source
 * kind is a compile error here rather than a silently dead exemption.
 */
export const UNFILTERED_SECTION_SOURCES = [
  "kit",
] as const satisfies readonly SectionSource[];

export type FirearmRow = { type: string; nfaClass: string };
export type AccessoryRow = { type: string };
export type GearRow = { category: string };
export type SupplyRow = { category: string };
export type KitRow = { category: string };

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
    }
  | {
      source: "kit";
      where: object;
      holds: (row: KitRow) => boolean;
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
const ARMOR_CATEGORIES = ["ARMOR"];
const MEDICAL_GEAR_CATEGORIES = ["MEDICAL_KIT"];
const FOOD_WATER_GEAR_CATEGORIES = ["WATER_TREATMENT"];
const POWER_COMMS_GEAR_CATEGORIES = ["POWER", "COMMS"];
const SHELTER_GEAR_CATEGORIES = ["SHELTER", "CLOTHING"];
const TOOLS_FIRE_GEAR_CATEGORIES = ["TOOL", "FIRE", "LIGHT", "SIGNALING"];
const OTHER_PREP_GEAR_CATEGORIES = [
  "SANITATION",
  "CBRN",
  "NAVIGATION",
  "DOCUMENTS",
  "SAFETY",
  "BUGOUT",
  "OTHER",
];

// Every GearCategory an explicit section claims. The catch-all below is the
// negation of this list, so a category added to the schema without a section
// still lands somewhere visible instead of matching zero sections.
const GROUPED_GEAR = [
  ...KNIFE_CATEGORIES,
  ...CASE_CATEGORIES,
  ...ARMOR_CATEGORIES,
  ...MEDICAL_GEAR_CATEGORIES,
  ...FOOD_WATER_GEAR_CATEGORIES,
  ...POWER_COMMS_GEAR_CATEGORIES,
  ...SHELTER_GEAR_CATEGORIES,
  ...TOOLS_FIRE_GEAR_CATEGORIES,
  ...OTHER_PREP_GEAR_CATEGORIES,
];

function gearSection(categories: string[]): SectionMatcher {
  return {
    source: "gear",
    where: { category: { in: categories } },
    holds: (row) => categories.includes(row.category),
  };
}

/**
 * Anything no gear section claimed — a category added to the schema without
 * a section still has to be reachable, not invisible. Rides on `other-prep`:
 * Other Prep is where an unclassifiable durable good belongs. Mutually
 * exclusive with every other `gearSection(...)` matcher on this section (one
 * demands membership in GROUPED_GEAR, this one demands exclusion from it),
 * so the two never both fire.
 */
function otherGearSection(): SectionMatcher {
  return {
    source: "gear",
    where: { category: { notIn: GROUPED_GEAR } },
    holds: (row) => !GROUPED_GEAR.includes(row.category),
  };
}

const CLEANING_CATEGORIES = ["CLEANING"];
const MEDICAL_SUPPLY_CATEGORIES = ["MEDICAL"];
const FOOD_WATER_SUPPLY_CATEGORIES = ["FOOD", "WATER", "FILTER"];
const POWER_COMMS_SUPPLY_CATEGORIES = ["BATTERY"];
const TOOLS_FIRE_SUPPLY_CATEGORIES = ["FUEL", "SIGNAL"];
const OTHER_PREP_SUPPLY_CATEGORIES = ["SANITATION", "CBRN_FILTER", "OTHER"];

// Every SupplyCategory an explicit section claims. Used by otherSupplySection
// below to build the negation — not just one section's own explicit branch —
// so no grouped category can ever double-match into another section's OR.
const GROUPED_SUPPLIES = [
  ...CLEANING_CATEGORIES,
  ...MEDICAL_SUPPLY_CATEGORIES,
  ...FOOD_WATER_SUPPLY_CATEGORIES,
  ...POWER_COMMS_SUPPLY_CATEGORIES,
  ...TOOLS_FIRE_SUPPLY_CATEGORIES,
  ...OTHER_PREP_SUPPLY_CATEGORIES,
];

function supplySection(categories: string[]): SectionMatcher {
  return {
    source: "supply",
    where: { category: { in: categories } },
    holds: (row) => categories.includes(row.category),
  };
}

/**
 * Everything no supply section claims: any category this build does not
 * recognise. Rides on `other-prep`, the same way `otherGearSection()` does
 * for gear categories. Mutually exclusive with every other
 * `supplySection(...)` matcher on this section (one demands membership in
 * GROUPED_SUPPLIES, this one demands exclusion from it), so the two never
 * both fire.
 */
function otherSupplySection(): SectionMatcher {
  return {
    source: "supply",
    where: { category: { notIn: GROUPED_SUPPLIES } },
    holds: (row) => !GROUPED_SUPPLIES.includes(row.category),
  };
}

/**
 * Every kit, whatever its category — the spec's section table reads
 * `Preparedness | Kits | kit, all`.
 *
 * The only matcher in this file with no filter, and the only member of
 * `UNFILTERED_SECTION_SOURCES`; read its docblock before copying this shape.
 * `where: {}` rather than a tautology, and `holds: () => true` rather than a
 * category test: a kit is not sorted into one of several kit sections the way
 * gear and supplies are, so there is no axis to gate on and nothing for a
 * catch-all to be the negation of. Every kit lands here exactly once, which
 * is what the other sources need their `notIn` branches to achieve.
 */
function kitSection(): SectionMatcher {
  return {
    source: "kit",
    where: {},
    holds: () => true,
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
    sources: [gearSection(CASE_CATEGORIES)],
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
    slug: "armor",
    label: "Armor",
    description: "Plates, carriers & soft armor",
    group: "prep",
    icon: "ShieldCheck",
    sources: [gearSection(ARMOR_CATEGORIES)],
  },
  {
    slug: "medical",
    label: "Medical",
    description: "Kits, first aid & medical supplies",
    group: "prep",
    icon: "Cross",
    sources: [
      gearSection(MEDICAL_GEAR_CATEGORIES),
      supplySection(MEDICAL_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "food-water",
    label: "Food & Water",
    description: "Food, water, filters & treatment",
    group: "prep",
    icon: "Droplets",
    sources: [
      gearSection(FOOD_WATER_GEAR_CATEGORIES),
      supplySection(FOOD_WATER_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "power-comms",
    label: "Power & Comms",
    description: "Batteries, power & radios",
    group: "prep",
    icon: "BatteryCharging",
    sources: [
      gearSection(POWER_COMMS_GEAR_CATEGORIES),
      supplySection(POWER_COMMS_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "shelter-clothing",
    label: "Shelter & Clothing",
    description: "Shelter, sleep & clothing",
    group: "prep",
    icon: "Tent",
    sources: [gearSection(SHELTER_GEAR_CATEGORIES)],
  },
  {
    slug: "tools-fire",
    label: "Tools & Fire",
    description: "Tools, light, fire & signaling",
    group: "prep",
    icon: "Flame",
    sources: [
      gearSection(TOOLS_FIRE_GEAR_CATEGORIES),
      supplySection(TOOLS_FIRE_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "other-prep",
    label: "Other Prep",
    description: "Sanitation, CBRN, navigation & everything else",
    group: "prep",
    icon: "Package",
    sources: [
      gearSection(OTHER_PREP_GEAR_CATEGORIES),
      otherGearSection(),
      supplySection(OTHER_PREP_SUPPLY_CATEGORIES),
      otherSupplySection(),
    ],
  },
  {
    slug: "kits",
    label: "Kits",
    description: "Bugout, medical, range & vehicle packing lists",
    group: "prep",
    icon: "Backpack",
    sources: [kitSection()],
  },
];

export function sectionBySlug(slug: string): CategorySection | undefined {
  return CATEGORY_SECTIONS.find((section) => section.slug === slug);
}

export function sectionsForGroup(group: SectionGroup): CategorySection[] {
  return CATEGORY_SECTIONS.filter((section) => section.group === group);
}

/**
 * The landing page for a nav group. Defined here, beside the registry, rather
 * than typed into the sidebar: adding a group means adding a route, and the
 * reachability test in categories.test.ts can only check that if it can
 * derive the URL. `/vault` predates the registry and keeps its own path.
 */
export function groupHref(group: SectionGroup): string {
  return `/${group}`;
}

/**
 * The page listing one section's items. The vault's sections sit under
 * /vault/category/<slug> for historical reasons; gear and prep sections sit
 * directly under their group. Single source of truth for the sidebar, the
 * section index pages and the reachability test.
 */
export function sectionHref(section: CategorySection): string {
  return section.group === "vault"
    ? `/vault/category/${section.slug}`
    : `/${section.group}/${section.slug}`;
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

/**
 * Searches every section rather than one group's, like supplySectionForItem
 * and unlike vaultSectionForFirearm. Gear categories are spread across both
 * the "gear" group (knives, cases) and the "prep" group (armor, medical kits,
 * shelter and the rest), so a group-scoped search would return undefined for
 * EIGHTEEN of the twenty categories — everything but KNIFE and CASE.
 *
 * Its caller is the gear detail page's back link
 * (src/app/gear/item/[id]/page.tsx), which resolves the item's own section
 * instead of the "/gear" it used to hardcode: /gear is a section index over
 * the gear group alone, so an ARMOR item's "Back to Gear" landed on a page
 * that did not contain it. That page treats undefined as "no section" and
 * falls back to "/" with the label "Home", matching what the supply detail
 * page does with supplySectionForItem.
 *
 * Measured, not predicted: undefined is unreachable for all twenty current
 * categories — other-prep's catch-all matcher is the negation of the full
 * grouped list, so it holds anything the named sections do not. The fallback
 * is there for a category a later build adds while this registry lags.
 */
export function gearSectionForItem(row: GearRow): CategorySection | undefined {
  return CATEGORY_SECTIONS.find((section) =>
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

/**
 * `{}` for the kits section, and that is not a bug — see
 * `UNFILTERED_SECTION_SOURCES`. Still `?? null` rather than `?? undefined`,
 * and the loader still gates on null: `{}` is truthy, so the kits query goes
 * out unfiltered on purpose, while a section with NO kit matcher returns null
 * and is skipped. `?? undefined` would collapse those two into one.
 */
export function kitWhereForSection(section: CategorySection): object | null {
  return (
    section.sources.find((source) => source.source === "kit")?.where ?? null
  );
}

/**
 * The distinct source kinds a section draws from, in declaration order. The
 * section renderer walks this rather than probing each where-builder for null,
 * so "this section has no data source at all" is a case the caller can see
 * instead of one that quietly renders an empty page.
 */
export function sectionSources(section: CategorySection): SectionSource[] {
  const seen: SectionSource[] = [];
  for (const source of section.sources) {
    if (!seen.includes(source.source)) seen.push(source.source);
  }
  return seen;
}

/**
 * Whether a section's page can actually SHOW something: at least one declared
 * source, a real where clause for every source it declares, and a view in its
 * group that can render every one of them.
 *
 * Exists because "the route resolves" and "the page renders" are different
 * claims, and the suite only ever checked the first. `/prep` shipped as a 404
 * the sidebar linked from every page; `/prep/armor` would have shipped the
 * same way — the route file existed, but the page's own supply-matcher guard
 * called notFound() for a gear-only section. Both [slug] pages now gate on
 * this function and the test asserts it holds for every registered section,
 * so the page and the test can no longer disagree.
 *
 * BOTH halves are required, and the second is the one that is easy to miss.
 * A where clause only says the LOADER can fetch the rows. Give a prep section
 * a `firearm` source and it clears that half — `firearmWhereForSection`
 * returns a good fragment — then `PayloadList` throws during render, because
 * SectionView has no firearm branch: an HTTP 500 with no retry link, verified
 * empirically. The renderable set per group is NOT restated here; it comes
 * from `sections/renderableSources.ts`, the one definition the view itself is
 * compile-pinned to.
 */
export function sectionIsRenderable(section: CategorySection): boolean {
  const kinds = sectionSources(section);
  if (kinds.length === 0) return false;
  // The `: boolean` return annotation is LOAD-BEARING and was missing until
  // phase 6 added the `kit` source and caught it. `Array.prototype.every`
  // takes `(value) => unknown`, so with no annotation the callback's inferred
  // `boolean | undefined` was assignable to the contextual type and the
  // switch's exhaustiveness was NEVER CHECKED: adding a fifth SectionSource
  // produced no error here at all, and the new kind fell out of the switch as
  // `undefined` — falsy — so `sectionIsRenderable` returned false and both
  // [slug] pages `notFound()`. A section registered per spec would have
  // 404'd, which is the exact silent-omission shape the docblock above says
  // this gate prevents. Same failure as `RenderablePayloadList`'s explicit
  // `ReactElement`, and the same fix. Verified by removing the annotation:
  // the `kit` case below can be deleted and tsc stays clean without it.
  return kinds.every((kind): boolean => {
    // Half 2: the group's view has a renderer for this kind.
    if (!isRenderableSource(section.group, kind)) return false;
    // Half 1: the loader has something to query with. The switch is
    // exhaustive over SectionSource with no `default`, so a source kind added
    // to the registry is a tsc error here (TS2366, via the annotation above)
    // rather than a kind this gate waves through unchecked.
    switch (kind) {
      case "firearm":
        return firearmWhereForSection(section) !== null;
      case "accessory":
        return accessoryWhereForSection(section) !== null;
      case "gear":
        return gearWhereForSection(section) !== null;
      case "supply":
        return supplyWhereForSection(section) !== null;
      // `{}`, not null: truthy, so this passes. "All kits" is a real where
      // clause for the loader's purposes — see UNFILTERED_SECTION_SOURCES.
      case "kit":
        return kitWhereForSection(section) !== null;
    }
  });
}
