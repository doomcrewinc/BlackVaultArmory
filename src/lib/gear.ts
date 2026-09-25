/**
 * Standalone kit: things you own that never mount on a firearm. `Gear` is for
 * durable goods and `Supply` for things you consume — that line decides where a
 * new category goes: a plate carrier is `Gear`, the water in the bag is `Supply`.
 *
 * Order matters only for the category dropdowns, which render it directly.
 * KNIFE and CASE lead because they predate the rest; OTHER is last because it
 * is the explicit "none of these" choice, distinct from the fallback below.
 */
export const GEAR_CATEGORIES = [
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
] as const;

export type GearCategory = (typeof GEAR_CATEGORIES)[number];

export const GEAR_CATEGORY_LABELS: Record<GearCategory, string> = {
  KNIFE: "Knife",
  CASE: "Case",
  ARMOR: "Armor",
  MEDICAL_KIT: "Medical Kit",
  WATER_TREATMENT: "Water Treatment",
  POWER: "Power",
  COMMS: "Comms",
  LIGHT: "Light",
  FIRE: "Fire",
  SHELTER: "Shelter",
  CLOTHING: "Clothing",
  TOOL: "Tool",
  SANITATION: "Sanitation",
  CBRN: "CBRN Protection",
  NAVIGATION: "Navigation",
  SIGNALING: "Signaling",
  DOCUMENTS: "Documents",
  SAFETY: "Safety",
  BUGOUT: "Bugout",
  OTHER: "Other",
};

/**
 * The armor fields (`protectionLevel`, `armorSize`) apply to exactly one
 * category. Takes a raw string rather than a `GearCategory` because the callers
 * that matter — the API's clearing gate and the detail page — hold whatever is
 * stored, which restore and the copier can set to anything.
 */
export function isArmorCategory(value: string): boolean {
  return value === "ARMOR";
}

export const DEFAULT_GEAR_CATEGORY: GearCategory = "KNIFE";

/**
 * A write path never stores a category outside the enum. Unrecognised input
 * falls back rather than erroring, matching how the firearm class and accessory
 * quantity normalizers behave.
 */
export function normalizeGearCategory(value: unknown): GearCategory {
  if (typeof value !== "string") return DEFAULT_GEAR_CATEGORY;
  const candidate = value.trim().toUpperCase();
  return (GEAR_CATEGORIES as readonly string[]).includes(candidate)
    ? (candidate as GearCategory)
    : DEFAULT_GEAR_CATEGORY;
}
