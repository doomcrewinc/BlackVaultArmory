"use client";

export type TypeOption = { value: string; label: string };

type Props = Readonly<{
  id: string;
  label: string;
  options: readonly TypeOption[];
  value: string;
  onChange: (value: string) => void;
  /** Adds an empty first option with this text. */
  placeholder?: string;
  /**
   * Show the one allowed value as text instead of a choice. The value is
   * still submitted, through a hidden input, so the form reads it like any
   * other field.
   */
  fixed?: boolean;
  inputClassName: string;
  labelClassName: string;
}>;

/**
 * The type or category field of an add form. A form opened from a section
 * limits `options` to what the section holds; when that is a single value
 * there is nothing to choose and the field is fixed.
 */
export function TypeSelectField({
  id,
  label,
  options,
  value,
  onChange,
  placeholder,
  fixed = false,
  inputClassName,
  labelClassName,
}: Props) {
  if (fixed) {
    const shown = options.find((option) => option.value === value);
    return (
      <div>
        <p className={labelClassName}>{label}</p>
        <p
          data-testid={`${id}-fixed`}
          className={`${inputClassName} cursor-default text-vault-text-muted`}
        >
          {shown?.label ?? value}
        </p>
        <input type="hidden" id={id} name={id} value={value} readOnly />
      </div>
    );
  }
  return (
    <div>
      <label htmlFor={id} className={labelClassName}>
        {label}
      </label>
      <select
        id={id}
        name={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClassName}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
