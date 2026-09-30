/**
 * Redaction rules shared by the audit log's write path (never store a secret
 * in AuditEvent.changes) and its read path (never render one, even one that
 * predates this rule).
 */
export const REDACTED = "[redacted]";

/** Sensitive field names that don't otherwise match the pattern below. */
const EXPLICIT_REDACTED_FIELDS: ReadonlySet<string> = new Set(["serialNumber"]);

/** Anything that looks like a secret, token, password or API key, by name. */
const REDACTED_FIELD_PATTERN = /secret|token|password|apikey/i;

export function isRedactedField(field: string): boolean {
  return EXPLICIT_REDACTED_FIELDS.has(field) || REDACTED_FIELD_PATTERN.test(field);
}

/** Replaces every sensitive field's value with REDACTED; leaves everything else as-is. */
export function redactRecord(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = isRedactedField(key) ? REDACTED : value;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Redacts a STORED `AuditEvent.changes` value on its way OUT to the UI/CSV —
 * the read-path half of the contract this file's header describes ("never
 * render one, even one that predates this rule"). Every writer today already
 * redacts (extension.ts's recordCreate/recordUpdate/recordDelete, and
 * diffRecords above), so this is defense in depth: a row written before this
 * rule existed, or by something outside the audited client, must still never
 * leak a sensitive value here.
 *
 * Shape-aware: a sensitive field's value can be a bare value (a CREATE/DELETE
 * snapshot field) or a `[before, after]` pair (an UPDATE diff) — a pair is
 * redacted ELEMENT-WISE, to `[REDACTED, REDACTED]`, never collapsed into a
 * single value, so the UI can still tell a diff apart from a snapshot field
 * after redaction. Non-sensitive keys are walked recursively (nested writes),
 * so a sensitive field nested inside `_nested` is still caught; `_children`
 * (DELETE's cascade counts) holds model names as keys, none of which can
 * match `isRedactedField`, so it passes through unchanged.
 */
export function redactStoredChanges(changes: unknown): unknown {
  if (!isPlainObject(changes)) return changes;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (isRedactedField(key)) {
      out[key] = Array.isArray(value) && value.length === 2 ? [REDACTED, REDACTED] : REDACTED;
    } else if (isPlainObject(value)) {
      out[key] = redactStoredChanges(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (isPlainObject(v) ? redactStoredChanges(v) : v));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** True for two values that are the same for audit-diff purposes. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true; // null and undefined are equal here
  const aTime = a instanceof Date ? a.getTime() : undefined;
  const bTime = b instanceof Date ? b.getTime() : undefined;
  if (aTime !== undefined || bTime !== undefined) return aTime === bTime;
  return false;
}

/**
 * The fields that changed between two snapshots of the same row, as
 * `{ field: [before, after] }`. `updatedAt` is never included — it changes
 * on every save and says nothing about what changed. A changed sensitive
 * field is reported as `[REDACTED, REDACTED]`: the fact that it changed is
 * audited, never the value.
 */
export function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  keys.delete("updatedAt");

  const diff: Record<string, [unknown, unknown]> = {};
  for (const key of keys) {
    const a = before[key];
    const b = after[key];
    if (sameValue(a, b)) continue;
    diff[key] = isRedactedField(key) ? [REDACTED, REDACTED] : [a, b];
  }
  return diff;
}
