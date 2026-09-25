/**
 * Kit: a packing list, not a copy. A `Kit` is a container (bugout bag, range
 * bag, vehicle kit); its `KitItem` rows point at inventory records elsewhere
 * (Gear, Supply, Accessory, AmmoStock, Firearm) and say how much of each lives
 * in this kit. See docs/superpowers/specs/2026-09-22-item-categories-design.md,
 * "Kit and KitItem: what is packed where".
 *
 * Order matters only for the category dropdown, which renders it directly.
 * OTHER is last as the explicit "none of these" choice, matching the other
 * category vocabularies in this codebase (see gear.ts).
 */
export const KIT_CATEGORIES = [
  "BUGOUT",
  "MEDICAL",
  "RANGE",
  "VEHICLE",
  "HOME",
  "OTHER",
] as const;

export type KitCategory = (typeof KIT_CATEGORIES)[number];

export const KIT_CATEGORY_LABELS: Record<KitCategory, string> = {
  BUGOUT: "Bugout",
  MEDICAL: "Medical",
  RANGE: "Range",
  VEHICLE: "Vehicle",
  HOME: "Home",
  OTHER: "Other",
};

export const DEFAULT_KIT_CATEGORY: KitCategory = "BUGOUT";

/**
 * A write path never stores a category outside the enum. Unrecognised input
 * falls back rather than erroring, matching how the gear and firearm class
 * normalizers behave.
 */
export function normalizeKitCategory(value: unknown): KitCategory {
  if (typeof value !== "string") return DEFAULT_KIT_CATEGORY;
  const candidate = value.trim().toUpperCase();
  return (KIT_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as KitCategory)
    : DEFAULT_KIT_CATEGORY;
}

/**
 * The five foreign keys a KitItem may set, in schema order. ONE definition:
 * the exactly-one rule, the API's validation, the picker and the tests all
 * derive from this rather than restating five field names. A hand-maintained
 * list that pins itself is the shape this project has paid for three times.
 */
export const KIT_ITEM_SOURCES = [
  "gearId",
  "supplyId",
  "accessoryId",
  "ammoStockId",
  "firearmId",
] as const;

export type KitItemSourceField = (typeof KIT_ITEM_SOURCES)[number];

/**
 * What a kit's contents are grouped under, one heading per source kind.
 *
 * A `Record<KitItemSourceField, string>`, so it is exhaustive BY TYPE: a
 * sixth entry added to KIT_ITEM_SOURCES is a tsc error here rather than a
 * group of lines that silently renders under no heading at all. Same
 * guarantee the section loader's sourceless `switch` gives, expressed the
 * only way a lookup table can express it.
 */
export const KIT_ITEM_SOURCE_LABELS: Record<KitItemSourceField, string> = {
  gearId: "Gear",
  supplyId: "Supplies",
  accessoryId: "Accessories",
  ammoStockId: "Ammo",
  firearmId: "Firearms",
};

/**
 * The heading for lines that set no source — the `label`-only rows the spec
 * allows for something not tracked anywhere in inventory. Not a member of
 * KIT_ITEM_SOURCES, because it is the absence of one; kept beside the labels
 * so the six group headings are defined in one place.
 */
export const KIT_ITEM_UNTRACKED_LABEL = "Other";
