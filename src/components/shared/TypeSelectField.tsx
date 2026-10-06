"use client";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

type Props = Readonly<{
  /** Both the element id and the form field name. */
  id: string;
  label: string;
  /** Every value the field can offer, in display order. */
  values: readonly string[];
  labels: Readonly<Record<string, string>>;
  /**
   * When given, only these values are offered. A single allowed value is shown
   * as text instead of a choice, and is still submitted through a hidden input
   * so the form reads it like any other field.
   */
  allowed?: readonly string[];
  value: string;
  onChange: (value: string) => void;
  /** Adds an empty first option with this text. */
  placeholder?: string;
}>;

/**
 * The type or category field of an add form. A form opened from a section
 * limits it to what the section holds.
 */
export function TypeSelectField({
  id,
  label,
  values,
  labels,
  allowed,
  value,
  onChange,
  placeholder,
}: Props) {
  const offered = allowed ? values.filter((v) => allowed.includes(v)) : values;
  if (allowed && offered.length === 1) {
    return (
      <div>
        <p className={LABEL_CLASS}>{label}</p>
        <p
          data-testid={`${id}-fixed`}
          className={`${INPUT_CLASS} cursor-default text-vault-text-muted`}
        >
          {labels[offered[0]] ?? offered[0]}
        </p>
        <input type="hidden" id={id} name={id} value={offered[0]} readOnly />
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
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {offered.map((v) => (
          <option key={v} value={v}>
            {labels[v] ?? v}
          </option>
        ))}
      </select>
    </div>
  );
}
