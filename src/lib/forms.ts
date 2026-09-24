/**
 * Read an optional numeric form field.
 *
 * Why this exists: `Number("")` is `0`, and `0` is both finite and `>= 0`, so a
 * `Number.isFinite(parsed) && parsed >= 0` guard silently turns a field the user
 * left blank into a real stored `0`. For money that defeats the app's
 * "show — for a null price" convention: the item then reads `$0`, which claims
 * the user recorded a price of zero rather than recorded nothing.
 *
 * Blank, missing and non-numeric all mean "absent" and return null. A typed `0`
 * is a real value and is returned as `0` — a genuinely free item must still be
 * recordable. Range is not enforced here; the inputs carry `min` and the API
 * owns validation, and the sibling forms (`accessories/[id]/edit`, both gear
 * forms) already treat any parsed number as given.
 */
export function parseOptionalNumber(
  value: FormDataEntryValue | null,
): number | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed === "") return null;

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
