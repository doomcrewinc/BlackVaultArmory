"use client";

import { GEAR_CATEGORIES, GEAR_CATEGORY_LABELS } from "@/lib/gear";
import { SUPPLY_CATEGORIES, SUPPLY_CATEGORY_LABELS } from "@/lib/supply";
import { SLOT_TYPES, SLOT_TYPE_LABELS } from "@/lib/types";
import type { AddFormState } from "./useAddFormContext";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

/** The field each kind of form edits: its name, label and every value it offers. */
const FIELDS = {
  accessory: {
    id: "type",
    label: "Type / Slot",
    placeholder: "Select slot type...",
    values: SLOT_TYPES as readonly string[],
    labels: SLOT_TYPE_LABELS as Readonly<Record<string, string>>,
  },
  gear: {
    id: "category",
    label: "Category",
    placeholder: undefined,
    values: GEAR_CATEGORIES as readonly string[],
    labels: GEAR_CATEGORY_LABELS as Readonly<Record<string, string>>,
  },
  supply: {
    id: "category",
    label: "Category",
    placeholder: undefined,
    values: SUPPLY_CATEGORIES as readonly string[],
    labels: SUPPLY_CATEGORY_LABELS as Readonly<Record<string, string>>,
  },
} as const;

type Props = Readonly<{
  form: AddFormState;
  value: string;
  onChange: (value: string) => void;
}>;

/**
 * The type or category field of an add form. A form opened from a section
 * offers only what the section holds; a single value is shown in a read-only
 * labelled input instead of a choice and is still submitted, through a hidden
 * input, so the form reads it like any other field. Without a section it offers everything, and
 * the accessory form starts empty.
 */
export function TypeSelectField({ form, value, onChange }: Props) {
  const { id, label, placeholder, values, labels } = FIELDS[form.kind];
  const allowed = form.context?.allowedValues;
  const offered = allowed ? values.filter((v) => allowed.includes(v)) : values;
  if (allowed && offered.length === 1) {
    return (
      <div>
        <label htmlFor={`${id}-fixed`} className={LABEL_CLASS}>
          {label}
        </label>
        <input
          id={`${id}-fixed`}
          data-testid={`${id}-fixed`}
          type="text"
          readOnly
          value={labels[offered[0]] ?? offered[0]}
          className={`${INPUT_CLASS} cursor-default text-vault-text-muted`}
        />
        <input type="hidden" id={id} name={id} value={offered[0]} />
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <select
        id={id}
        name={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={INPUT_CLASS}
      >
        {placeholder !== undefined && !allowed && (
          <option value="">{placeholder}</option>
        )}
        {offered.map((v) => (
          <option key={v} value={v}>
            {labels[v] ?? v}
          </option>
        ))}
      </select>
    </div>
  );
}
