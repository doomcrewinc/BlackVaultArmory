"use client";

import {
  FULL_AUTO_LIMITED_TO_MAX_LENGTH,
  FULL_AUTO_LIMITED_TO_REQUIRED_MESSAGE,
  FULL_AUTO_RATING_OPTIONS,
  isFullAutoRating,
  type FullAutoRating,
} from "@/lib/full-auto-rated";

// Same strings every host form declares for its inputs and labels.
const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

/** The form's two inputs as strings: "" or a rating, and the Limited text. */
export interface FullAutoRatedValue {
  rating: "" | FullAutoRating;
  limitedTo: string;
}

export const EMPTY_FULL_AUTO_RATED_VALUE: FullAutoRatedValue = {
  rating: "",
  limitedTo: "",
};

/** The stored columns as a form value. */
export function toFullAutoRatedValue(stored: {
  fullAutoRating?: unknown;
  fullAutoLimitedTo?: unknown;
}): FullAutoRatedValue {
  const rating = isFullAutoRating(stored.fullAutoRating)
    ? stored.fullAutoRating
    : "";
  const limitedTo =
    rating === "LIMITED" && typeof stored.fullAutoLimitedTo === "string"
      ? stored.fullAutoLimitedTo
      : "";
  return { rating, limitedTo };
}

/** The request fields for a form value: null for "not recorded", text only beside Limited. */
export function fullAutoRatedPayload(value: FullAutoRatedValue) {
  return {
    fullAutoRating: value.rating || null,
    fullAutoLimitedTo:
      value.rating === "LIMITED" ? value.limitedTo.trim() : null,
  };
}

/** The message that blocks a submit, or null: Limited needs text. */
export function fullAutoRatedError(value: FullAutoRatedValue): string | null {
  return value.rating === "LIMITED" && value.limitedTo.trim() === ""
    ? FULL_AUTO_LIMITED_TO_REQUIRED_MESSAGE
    : null;
}

interface FullAutoRatedSelectProps {
  readonly value: FullAutoRatedValue;
  readonly onChange: (value: FullAutoRatedValue) => void;
}

/**
 * The suppressor's Full-Auto Rated field: Not recorded, Yes, No or Limited,
 * with a required "Rated For" text input beneath it while Limited is chosen.
 * Controlled and presentational; the host decides when to show it (suppressor
 * types only). Changing the rating away from Limited drops the text.
 */
export function FullAutoRatedSelect({
  value,
  onChange,
}: FullAutoRatedSelectProps) {
  function handleRatingChange(next: string) {
    const rating = isFullAutoRating(next) ? next : "";
    onChange({
      rating,
      limitedTo: rating === "LIMITED" ? value.limitedTo : "",
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="fullAutoRating" className={LABEL_CLASS}>
          Full-Auto Rated
        </label>
        <select
          id="fullAutoRating"
          name="fullAutoRating"
          value={value.rating}
          onChange={(event) => handleRatingChange(event.target.value)}
          className={INPUT_CLASS}
        >
          {FULL_AUTO_RATING_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {value.rating === "LIMITED" && (
        <div>
          <label htmlFor="fullAutoLimitedTo" className={LABEL_CLASS}>
            Rated For
          </label>
          <input
            id="fullAutoLimitedTo"
            name="fullAutoLimitedTo"
            type="text"
            required
            maxLength={FULL_AUTO_LIMITED_TO_MAX_LENGTH}
            value={value.limitedTo}
            onChange={(event) =>
              onChange({ rating: "LIMITED", limitedTo: event.target.value })
            }
            placeholder="e.g. 5.56 NATO only"
            className={INPUT_CLASS}
          />
        </div>
      )}
    </div>
  );
}
