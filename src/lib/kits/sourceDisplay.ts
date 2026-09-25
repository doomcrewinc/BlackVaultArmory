/**
 * sourceDisplay.ts — the display primitives every surface that NAMES a kit
 * line's source shares: the kit detail page (`getKitDetail`'s
 * `describeSource`) and the inventory picker's search endpoint
 * (`/api/kits/item-sources`).
 *
 * PURE, like `kitItemSource.ts` and `allocation.ts`: no Prisma, no clock. The
 * response types below are declared here rather than in the route module so a
 * client component can `import type` them without reaching into a file that
 * imports Prisma.
 *
 * WHAT LIVES HERE IS ONLY WHAT WOULD BE A REAL BUG IF TWO SURFACES DISAGREED:
 *
 *   - `FIREARM_OWNED_QUANTITY`. A Firearm row carries NO quantity column and
 *     stands for one physical object, so "owned" is 1. The picker showing
 *     "owned —" next to a rifle while the packed line reads "2 of 1 assigned
 *     across kits" would be two answers to one question.
 *   - `AMMO_UNIT_LABEL`. AmmoStock has no unit column; the unit is implied.
 *   - `kitSupplyUnitLabel`. The column stores the token, every surface shows
 *     the label.
 *
 * The per-kind "manufacturer · model" joins are spelled from
 * `joinKitSourceDetail` in both places rather than centralised into five
 * wrappers: which columns identify a row is a cosmetic choice per surface,
 * and the joiner is the part that must not drift into ", " on one page.
 */
import { SUPPLY_UNIT_LABELS, type SupplyUnit } from "@/lib/supply";
import type { KitItemSourceField } from "@/lib/kit";
import type { ExpiryStatus } from "@/lib/supply";

/**
 * How many a Firearm row stands for. See the note above, and
 * `getKitDetail`'s `describeSource`, which now reads it from here instead of
 * writing `owned: 1` with its own comment.
 */
export const FIREARM_OWNED_QUANTITY = 1;

/** AmmoStock's implied unit. Not in SUPPLY_UNIT_LABELS — ammo is not a supply. */
export const AMMO_UNIT_LABEL = "rounds";

/**
 * Joins the columns that identify a row into one sub-line, dropping the empty
 * ones. " · " in one place: a second spelling is how one surface comes to
 * read "Benchmade · 535" and another "Benchmade, 535".
 */
export function joinKitSourceDetail(
  ...parts: (string | null | undefined)[]
): string | null {
  const joined = parts.filter(Boolean).join(" · ");
  return joined === "" ? null : joined;
}

/** A Supply's unit label, falling back to the stored token for an unknown one. */
export function kitSupplyUnitLabel(unit: string): string {
  return SUPPLY_UNIT_LABELS[unit as SupplyUnit] ?? unit;
}

/**
 * One inventory row the picker can turn into a kit line.
 *
 * `field` is the foreign key the line would set — the picker sends exactly
 * this one key and nothing else, which is how it cannot build the
 * two-sources-at-once body the API rejects.
 *
 * `expiry` is a VERDICT decided server-side against one `today` resolved from
 * AppSettings, never a date for the browser to compare. Same rule as
 * `KitContentLine`: a browser-derived "expired" and a server-derived one
 * disagree for every user west of UTC after 17:00.
 */
export interface KitSourceResult {
  field: KitItemSourceField;
  id: string;
  name: string;
  detail: string | null;
  /** How many are owned, or null when the table tracks no quantity. */
  owned: number | null;
  unit: string | null;
  expiry: ExpiryStatus;
}

/** One labelled block of picker results, one per source kind. */
export interface KitSourceGroup {
  field: KitItemSourceField;
  label: string;
  results: KitSourceResult[];
}

export interface KitSourceSearchResponse {
  groups: KitSourceGroup[];
}
