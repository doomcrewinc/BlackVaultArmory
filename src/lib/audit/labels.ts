/**
 * A short, human-readable label for a row in an audit event — what shows up
 * in the audit log UI instead of a bare id. Per-model rules use whatever
 * that model's own fields actually are (see prisma/schema.base.prisma);
 * anything without a specific rule, or missing the field(s) its rule needs,
 * falls back to `"<Model> <id>"`.
 */
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asDateOnly(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return undefined;
}

function fallback(model: string, row: Record<string, unknown>): string {
  const id = asString(row.id) ?? String(row.id ?? "");
  return `${model} ${id}`.trim();
}

export function labelFor(model: string, row: Record<string, unknown>): string {
  switch (model) {
    case "Firearm": {
      const name = asString(row.name);
      const caliber = asString(row.caliber);
      if (name && caliber) return `${name} (${caliber})`;
      if (name) return name;
      return fallback(model, row);
    }
    case "Accessory": {
      const name = asString(row.name);
      const type = asString(row.type);
      if (name && type) return `${name} (${type})`;
      if (name) return name;
      return fallback(model, row);
    }
    case "AmmoStock": {
      const caliber = asString(row.caliber);
      const brand = asString(row.brand);
      if (caliber && brand) return `${caliber} ${brand}`;
      if (caliber) return caliber;
      return fallback(model, row);
    }
    case "Gear":
    case "Supply":
    case "Kit":
    case "Build":
    case "Document": {
      const name = asString(row.name);
      return name ?? fallback(model, row);
    }
    case "Photo": {
      const label = asString(row.label);
      return label ? `Photo "${label}"` : "Photo";
    }
    case "MaintenanceLog": {
      const date = asDateOnly(row.date);
      return date ? `Maintenance ${date}` : fallback(model, row);
    }
    case "RangeSession": {
      const date = asDateOnly(row.sessionDate);
      const location = asString(row.location);
      if (date && location) return `${date} – ${location}`;
      if (date) return date;
      if (location) return location;
      return fallback(model, row);
    }
    case "AppSettings":
      // The app has exactly one settings row (id "singleton"); "AppSettings
      // singleton" (the fallback) is technically correct and reads like an
      // error message. The label is stored at write time, so this only
      // changes new rows — existing rows keep the old text, which is fine.
      return "Settings";
    default:
      return fallback(model, row);
  }
}

/**
 * Splits a camelCase or PascalCase identifier into its words: "serialNumber"
 * -> ["serial", "Number"], "AmmoStock" -> ["Ammo", "Stock"]. Used to humanize
 * both field names (`fieldLabel`) and Prisma model names (`modelDisplayName`)
 * for display in the audit log's one-line summaries — see summary.ts.
 */
function splitWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Fields whose label is the wording the forms use rather than the split column name. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  fullAutoRating: "full-auto rated",
  fullAutoLimitedTo: "full-auto rated for",
};

/** A changed field's name for display: "serialNumber" -> "serial number". */
export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? splitWords(field).join(" ").toLowerCase();
}

/** A Prisma model name for display: "AmmoStock" -> "ammo stock". */
export function modelDisplayName(model: string): string {
  return splitWords(model).join(" ").toLowerCase();
}

/**
 * A Prisma model name Title Cased, for a dropdown OPTION rather than
 * mid-sentence prose: "AmmoStock" -> "Ammo Stock". `modelDisplayName`
 * (lowercase) is for summarize()'s sentences ("Deleted firearm …"); this is
 * for the item-type filter, whose options read like a list of nouns.
 */
export function modelFilterLabel(model: string): string {
  return splitWords(model)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
