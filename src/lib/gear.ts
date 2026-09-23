/**
 * Standalone kit: things you own that never mount on a firearm. Phase 2 ships
 * knives and cases; later phases add armor, medical, shelter and the rest, so
 * anything reading these values must tolerate a category it has not seen.
 */
export const GEAR_CATEGORIES = ["KNIFE", "CASE"] as const;

export type GearCategory = (typeof GEAR_CATEGORIES)[number];

export const GEAR_CATEGORY_LABELS: Record<GearCategory, string> = {
  KNIFE: "Knife",
  CASE: "Case",
};

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
