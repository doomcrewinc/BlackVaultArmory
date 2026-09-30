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
