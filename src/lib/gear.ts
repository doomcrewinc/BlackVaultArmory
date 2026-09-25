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

type ArmorFieldInput = {
  existing: { category: string; protectionLevel: string | null; armorSize: string | null };
  body: Record<string, unknown>;
};

function mergedText(
  body: Record<string, unknown>,
  key: string,
  stored: string | null,
): string | null {
  if (!(key in body)) return stored;
  const value = body[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return stored;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Merge first, then decide. Whether the armor fields MOVE comes from what the
 * client sent; what they move TO comes from re-running eligibility over the
 * merged record — the same shape as normalizeFirearmNfaFields.
 *
 * Reading eligibility off `body.category` alone would miss the case that
 * matters: a PUT that changes only the category, leaving a plate rating on a
 * hammer. Reading it off `existing.category` alone would refuse the fields on
 * the request that makes an item armor in the first place.
 *
 * A category this build does not recognise is left alone rather than cleared.
 * The codebase already made the opposite mistake once, silently declassifying
 * firearms whose class came from a later build; preserving what we cannot judge
 * is the rule here too.
 */
export function normalizeGearArmorFields({ existing, body }: ArmorFieldInput): {
  protectionLevel: string | null;
  armorSize: string | null;
} {
  const category =
    "category" in body && typeof body.category === "string" && body.category.trim() !== ""
      ? normalizeGearCategory(body.category)
      : existing.category;

  const protectionLevel = mergedText(body, "protectionLevel", existing.protectionLevel);
  const armorSize = mergedText(body, "armorSize", existing.armorSize);

  const knownCategory = (GEAR_CATEGORIES as readonly string[]).includes(category);
  if (knownCategory && !isArmorCategory(category)) {
    return { protectionLevel: null, armorSize: null };
  }
  return { protectionLevel, armorSize };
}
