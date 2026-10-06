/**
 * A suppressor's full-auto rating: Yes, No or Limited, with the rounds a
 * Limited rating covers. Two nullable text columns on Accessory:
 * fullAutoRating (YES | NO | LIMITED; null is "not recorded") and
 * fullAutoLimitedTo (free text, set only while the rating is LIMITED).
 * A checkbox could not say "not recorded", and would have marked every
 * existing suppressor "No".
 */

/** Accessory types that are suppressors; the Suppressors section matches these. */
export const SUPPRESSOR_TYPES: readonly string[] = ["SUPPRESSOR"];

export function isSuppressorType(type: unknown): boolean {
  return (
    typeof type === "string" &&
    SUPPRESSOR_TYPES.includes(type.trim().toUpperCase())
  );
}

export const FULL_AUTO_RATINGS = ["YES", "NO", "LIMITED"] as const;
export type FullAutoRating = (typeof FULL_AUTO_RATINGS)[number];

export const FULL_AUTO_RATING_LABELS: Readonly<Record<FullAutoRating, string>> =
  { YES: "Yes", NO: "No", LIMITED: "Limited" };

/** The select's options in display order; the empty value is "not recorded". */
export const FULL_AUTO_RATING_OPTIONS: readonly {
  value: "" | FullAutoRating;
  label: string;
}[] = [
  { value: "", label: "Not recorded" },
  ...FULL_AUTO_RATINGS.map((value) => ({
    value,
    label: FULL_AUTO_RATING_LABELS[value],
  })),
];

export const FULL_AUTO_LIMITED_TO_MAX_LENGTH = 200;
export const FULL_AUTO_LIMITED_TO_REQUIRED_MESSAGE =
  "Say which rounds it is rated for full-auto fire with.";

export function isFullAutoRating(value: unknown): value is FullAutoRating {
  return (
    typeof value === "string" &&
    (FULL_AUTO_RATINGS as readonly string[]).includes(value)
  );
}

export type FullAutoFields = {
  fullAutoRating: FullAutoRating | null;
  fullAutoLimitedTo: string | null;
};

const NOT_RECORDED: FullAutoFields = {
  fullAutoRating: null,
  fullAutoLimitedTo: null,
};

function trimmedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The two columns to store, decided from the record's resolved type. Only a
 * suppressor keeps a rating; the text survives only beside LIMITED. Never
 * rejects: an unknown rating is not recorded, and LIMITED without text keeps
 * the rating. Restore uses this directly, so a backup never loses a rating;
 * the write routes validate first with resolveFullAutoFields.
 */
export function normalizeFullAutoFields(
  type: unknown,
  input: { fullAutoRating?: unknown; fullAutoLimitedTo?: unknown },
): FullAutoFields {
  if (!isSuppressorType(type) || !isFullAutoRating(input.fullAutoRating)) {
    return NOT_RECORDED;
  }
  if (input.fullAutoRating !== "LIMITED") {
    return { fullAutoRating: input.fullAutoRating, fullAutoLimitedTo: null };
  }
  const text = trimmedText(input.fullAutoLimitedTo);
  return {
    fullAutoRating: "LIMITED",
    fullAutoLimitedTo:
      text === null ? null : text.slice(0, FULL_AUTO_LIMITED_TO_MAX_LENGTH),
  };
}

export type FullAutoResolution =
  | { ok: true; fields: FullAutoFields }
  | { ok: false; error: string };

/**
 * The write routes' rule, applied to the RESULTING row: the caller merges the
 * stored values with the patch and passes the merged pair here with the
 * resolved type. A rating that is not YES, NO, LIMITED or null, or text that
 * is not a string, is an error whatever the type. For a suppressor, LIMITED
 * needs non-empty text of at most 200 characters. Anything else is decided by
 * normalizeFullAutoFields.
 */
export function resolveFullAutoFields(
  type: unknown,
  input: { fullAutoRating?: unknown; fullAutoLimitedTo?: unknown },
): FullAutoResolution {
  const { fullAutoRating, fullAutoLimitedTo } = input;
  if (
    fullAutoRating !== undefined &&
    fullAutoRating !== null &&
    !isFullAutoRating(fullAutoRating)
  ) {
    return {
      ok: false,
      error: "fullAutoRating must be YES, NO, LIMITED or null",
    };
  }
  if (
    fullAutoLimitedTo !== undefined &&
    fullAutoLimitedTo !== null &&
    typeof fullAutoLimitedTo !== "string"
  ) {
    return { ok: false, error: "fullAutoLimitedTo must be text or null" };
  }
  if (isSuppressorType(type) && fullAutoRating === "LIMITED") {
    const text = trimmedText(fullAutoLimitedTo);
    if (text === null) {
      return { ok: false, error: FULL_AUTO_LIMITED_TO_REQUIRED_MESSAGE };
    }
    if (text.length > FULL_AUTO_LIMITED_TO_MAX_LENGTH) {
      return {
        ok: false,
        error: `fullAutoLimitedTo must be at most ${FULL_AUTO_LIMITED_TO_MAX_LENGTH} characters`,
      };
    }
  }
  return { ok: true, fields: normalizeFullAutoFields(type, input) };
}

/** "Yes", "No", "Limited" or "Not recorded". */
export function fullAutoRatingLabel(rating: unknown): string {
  return isFullAutoRating(rating)
    ? FULL_AUTO_RATING_LABELS[rating]
    : "Not recorded";
}

/** The detail page's value: "Limited — 5.56 NATO only" for a Limited rating with text. */
export function fullAutoRatingText(
  rating: unknown,
  limitedTo: unknown,
): string {
  const label = fullAutoRatingLabel(rating);
  const text = trimmedText(limitedTo);
  return rating === "LIMITED" && text !== null ? `${label} — ${text}` : label;
}

/** An export cell: "Yes", "No", "Limited" or blank. */
export function fullAutoRatingExportValue(rating: unknown): string {
  return isFullAutoRating(rating) ? FULL_AUTO_RATING_LABELS[rating] : "";
}

/** An export cell for the Limited text: blank unless the rating is Limited. */
export function fullAutoLimitedToExportValue(
  rating: unknown,
  limitedTo: unknown,
): string {
  return rating === "LIMITED" ? (trimmedText(limitedTo) ?? "") : "";
}
