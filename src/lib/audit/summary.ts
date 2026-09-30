import type { AuditEventDto } from "./query";
import { REDACTED, isRedactedField } from "./redact";
import { fieldLabel, modelDisplayName } from "./labels";
import { formatDateOnly, formatDateTime } from "../date";
import { DATE_ONLY_FIELDS } from "../date-only-fields";

/**
 * `summarize(event)` — the one-line description shown in the audit list and
 * item History sections: "Deleted firearm "Glock 19 (9mm)" and 12
 * maintenance entries", "Changed "Glock 19": status Active → Sold", "Jeff
 * signed in", "Failed sign-in for "jef"". One branch per AUDIT_ACTIONS entry
 * (actions.ts); an event never seen in production (a future action added
 * there and not here) still renders something instead of throwing.
 *
 * Every stored `changes` shape came from a specific writer (extension.ts's
 * recordCreate/recordUpdate/recordDelete for CREATE/UPDATE/DELETE, or one of
 * the recordEvent call sites in src/app/api/auth/*, src/lib/auth/admins.ts,
 * src/app/api/settings/direct-access, src/app/api/backup/* for the security
 * actions) — this module reads those shapes back, defensively: `changes` is
 * untyped JSON on the DTO (it round-tripped through JSON.parse in
 * query.ts's toDto), so nothing here assumes a key exists or has the
 * expected type.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The display name half of an `actorName` snapshot: "Jeff (@jeff)" -> "Jeff"; "system"/"anonymous" pass through unchanged. */
function actorDisplayName(actorName: string): string {
  const match = /^(.+?)\s+\(@[^)]*\)$/.exec(actorName);
  return match ? match[1] : actorName;
}

/**
 * True when `entityType.field` is one of the app's date-only columns —
 * DATE_ONLY_FIELDS (src/lib/date-migration.ts), the same DMMF-guarded
 * registry the date-normalisation migration uses, so this list can never
 * drift from the schema without failing that module's own test. Field name
 * alone is ambiguous ("date" is date-only on MaintenanceLog and nothing
 * else; "changedAt" is date-only on BatteryChangeLog but a true instant
 * elsewhere), so classification is always model-scoped.
 */
function isDateOnlyField(entityType: string | null, field: string): boolean {
  if (!entityType) return false;
  return DATE_ONLY_FIELDS.some((f) => f.model === entityType && f.field === field);
}

/** The exact shape `Date#toISOString()` / `JSON.stringify(date)` produces — what a DateTime column becomes after `changes` round-trips through JSON. Anything else (a plain string like "Active", a number, a bare YYYY-MM-DD typed by a human) is left as-is. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function looksLikeIsoInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value);
}

/**
 * A raw before/after/create/delete field value as display text — exported
 * for AuditRow's detail panel. An ISO-instant-shaped string renders through
 * date.ts (formatDateOnly for a date-only field, formatDateTime otherwise —
 * never the raw `…T00:00:00.000Z` text, per date.ts's own contract). An
 * object (RESTORE's `counts`) renders as compact JSON instead of
 * `[object Object]`.
 */
export function displayValue(value: unknown, dateOnly = false): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (looksLikeIsoInstant(value)) return dateOnly ? formatDateOnly(value) : formatDateTime(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function joinWithAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * One entry per changed field in an UPDATE's `changes` (or the key fields of
 * a CREATE, or a DELETE's removed-row snapshot) — `{ field: [before, after]
 * }` becomes a "diff" entry, a bare value becomes a "value" entry. Exported
 * for AuditRow's expanded detail panel, which needs the raw before/after
 * pair (never just the summary string) to render each row. `_nested`
 * (nested-write data) and `_children` (DELETE's cascade counts — see
 * `childEntries`) are not field entries and are skipped.
 */
export type AuditDetailEntry =
  | { field: string; label: string; kind: "diff"; redacted: boolean; dateOnly: boolean; before: unknown; after: unknown }
  | { field: string; label: string; kind: "value"; redacted: boolean; dateOnly: boolean; value: unknown };

/**
 * `entityType` (the Prisma model this event's row belongs to) drives two
 * things per field: whether it is a date-only column (`isDateOnlyField`) and
 * — belt and suspenders alongside query.ts's own read-path redaction
 * (`redactStoredChanges`) — whether its NAME alone marks it sensitive
 * (`isRedactedField`), so a value is never shown in clear even if some
 * future path reaches this function without going through the DTO mapper.
 */
export function detailEntries(changes: unknown, entityType: string | null = null): AuditDetailEntry[] {
  if (!isRecord(changes)) return [];
  const entries: AuditDetailEntry[] = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === "_nested" || field === "_children") continue;
    const dateOnly = isDateOnlyField(entityType, field);
    if (Array.isArray(value) && value.length === 2) {
      const [before, after] = value;
      const redacted = isRedactedField(field) || before === REDACTED || after === REDACTED;
      entries.push({ field, label: fieldLabel(field), kind: "diff", redacted, dateOnly, before, after });
    } else {
      const redacted = isRedactedField(field) || value === REDACTED;
      entries.push({ field, label: fieldLabel(field), kind: "value", redacted, dateOnly, value });
    }
  }
  return entries;
}

/** One fragment per `detailEntries` diff row: "status Active → Sold", or "serial number changed" when redacted. */
function changeFragments(changes: unknown, entityType: string | null): string[] {
  return detailEntries(changes, entityType)
    .filter((e): e is Extract<AuditDetailEntry, { kind: "diff" }> => e.kind === "diff")
    .map((e) => (e.redacted ? `${e.label} changed` : `${e.label} ${displayValue(e.before, e.dateOnly)} → ${displayValue(e.after, e.dateOnly)}`));
}

/**
 * DELETE's cascaded-child counts, model name and raw count — exported for
 * AuditRow's expanded panel. "Log" is stripped from the model name
 * (MaintenanceLog -> "maintenance", so it reads "12 maintenance entries" via
 * `childFragments`, not "12 maintenance log entries" — "entry"/"entries"
 * already says what these rows are). Zero counts never appear in
 * `_children` (extension.ts's countCascadedChildren only keeps non-zero
 * totals), but one is skipped defensively rather than rendered as "0 ...
 * entries".
 */
export type AuditChildEntry = { model: string; label: string; count: number };

export function childEntries(changes: unknown): AuditChildEntry[] {
  if (!isRecord(changes)) return [];
  const children = changes._children;
  if (!isRecord(children)) return [];
  const entries: AuditChildEntry[] = [];
  for (const [model, count] of Object.entries(children)) {
    if (typeof count !== "number" || count <= 0) continue;
    const stripped = model.endsWith("Log") ? model.slice(0, -3) : model;
    entries.push({ model, label: modelDisplayName(stripped) || model.toLowerCase(), count });
  }
  return entries;
}

/** `childEntries` as "N <kind> entries" fragments, for the one-line summary. */
function childFragments(changes: unknown): string[] {
  return childEntries(changes).map((e) => `${e.count} ${e.label} ${e.count === 1 ? "entry" : "entries"}`);
}

function quoted(label: string | null): string {
  return `"${label ?? "item"}"`;
}

export function summarize(event: AuditEventDto): string {
  const who = actorDisplayName(event.actorName);
  const kind = event.entityType ? modelDisplayName(event.entityType) : "item";

  switch (event.action) {
    case "CREATE":
      return `Created ${kind} ${quoted(event.entityLabel)}`;

    case "UPDATE": {
      const fragments = changeFragments(event.changes, event.entityType);
      return fragments.length
        ? `Changed ${quoted(event.entityLabel)}: ${fragments.join(", ")}`
        : `Changed ${quoted(event.entityLabel)}`;
    }

    case "DELETE": {
      const base = `Deleted ${kind} ${quoted(event.entityLabel)}`;
      const children = childFragments(event.changes);
      return children.length ? `${base} and ${joinWithAnd(children)}` : base;
    }

    case "LOGIN":
      return `${who} signed in`;

    case "LOGIN_FAILED": {
      const username = isRecord(event.changes) ? asString(event.changes.username) : undefined;
      return `Failed sign-in for "${username ?? "unknown user"}"`;
    }

    case "LOGOUT": {
      const allSessions = isRecord(event.changes) && event.changes.allSessions === true;
      return allSessions ? `${who} signed out of all sessions` : `${who} signed out`;
    }

    case "INVITE_CREATED": {
      const role = isRecord(event.changes) ? asString(event.changes.role) : undefined;
      return `${who} created a${role ? ` ${role}` : ""} invite`;
    }

    case "INVITE_REDEEMED": {
      const role = isRecord(event.changes) ? asString(event.changes.role) : undefined;
      const name = event.entityLabel ? actorDisplayName(event.entityLabel) : who;
      return `${name} joined${role ? ` as ${role}` : ""}`;
    }

    case "ROLE_CHANGED": {
      const from = isRecord(event.changes) ? asString(event.changes.from) : undefined;
      const to = isRecord(event.changes) ? asString(event.changes.to) : undefined;
      return `Changed ${quoted(event.entityLabel)} role: ${from ?? "?"} → ${to ?? "?"}`;
    }

    case "USER_DISABLED":
      return `Disabled ${quoted(event.entityLabel)}`;

    case "USER_ENABLED":
      return `Enabled ${quoted(event.entityLabel)}`;

    case "RESET_LINK_ISSUED":
      return `Issued a reset link for ${quoted(event.entityLabel)}`;

    case "PASSWORD_CHANGED":
      return `Changed the password for ${quoted(event.entityLabel)}`;

    case "DIRECT_ACCESS_CHANGED": {
      const to = isRecord(event.changes) ? event.changes.to : undefined;
      return `Direct access ${to === true ? "enabled" : "disabled"}`;
    }

    case "BACKUP_CREATED": {
      const file = isRecord(event.changes) ? asString(event.changes.file) : undefined;
      return `Created backup${file ? ` ${file}` : ""}`;
    }

    case "RESTORE": {
      const file = isRecord(event.changes) ? asString(event.changes.file) : undefined;
      return `Restored the database from backup${file ? ` ${file}` : ""}`;
    }

    default:
      // A future action added to actions.ts without a branch here — never
      // throw; still say who did what to which item.
      return `${event.action} — ${who}${event.entityLabel ? ` — ${quoted(event.entityLabel)}` : ""}`;
  }
}
