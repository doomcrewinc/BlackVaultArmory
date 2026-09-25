/**
 * kitItemSource.ts — the exactly-one-source rule for a KitItem.
 *
 * Spec: "A KitItem sets one of the five foreign keys, or none of them plus a
 * label." This module is PURE (no Prisma, no clock) so the API (Task 3), the
 * kit page and the picker (Task 6) can share one implementation instead of
 * drifting into three re-derivations of "is this line valid".
 *
 * The five field names are never restated here — they are read from
 * KIT_ITEM_SOURCES in kit.ts, the one place that list is allowed to exist.
 */
import { KIT_ITEM_SOURCES, type KitItemSourceField } from "@/lib/kit";

/**
 * Raw input for a KitItem's source, as it arrives from an API body or a form
 * — untyped, since either may hand this unknown values (a number, a boolean,
 * undefined) rather than a clean string.
 */
export type KitItemSourceInput = {
  [K in KitItemSourceField]?: unknown;
} & {
  label?: unknown;
};

export type KitItemSourceReason =
  | "multiple-sources"
  | "source-and-label"
  | "no-source";

export type KitItemSourceResult =
  | { ok: true; field: KitItemSourceField | null; id: string | null; label: string | null }
  | { ok: false; reason: KitItemSourceReason; fields: KitItemSourceField[] };

/**
 * A value counts as "set" only once trimmed, matching normalizeAmount's rule
 * elsewhere in this codebase: a cleared form field sent as "" or "   " is
 * absent, not a real value that could collide with a second source or a
 * label.
 */
function isSet(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Resolves a KitItem's source. Returns a discriminated union rather than
 * throwing: the API (Task 3) turns `ok: false` into a 400 with `reason` and
 * `fields`, and the picker (Task 6) uses `ok` to disable an invalid state
 * before the user can submit it. Nothing here rejects or clamps a quantity —
 * that is `allocation.ts`'s job, and it never throws either.
 */
export function resolveKitItemSource(
  input: KitItemSourceInput,
): KitItemSourceResult {
  const setFields = KIT_ITEM_SOURCES.filter((field) => isSet(input[field]));
  const label = isSet(input.label) ? (input.label as string) : null;

  if (setFields.length > 1) {
    return { ok: false, reason: "multiple-sources", fields: setFields };
  }

  if (setFields.length === 1) {
    const field = setFields[0];
    if (label !== null) {
      return { ok: false, reason: "source-and-label", fields: setFields };
    }
    return {
      ok: true,
      field,
      id: (input[field] as string).trim(),
      label: null,
    };
  }

  if (label !== null) {
    return { ok: true, field: null, id: null, label };
  }

  return { ok: false, reason: "no-source", fields: [] };
}
