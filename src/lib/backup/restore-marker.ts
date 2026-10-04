/**
 * The names the full-restore program gives its work folders under the uploads
 * root, and the one rule for what is a restore marker. Kept apart from
 * ./full-restore.ts so that the app's start (src/lib/files/startup.ts) can
 * ask "is a marker there?" without loading the restore engine.
 *
 * No imports: this module is loaded by the app, by the bundled CLIs and by
 * scripts under plain ts-node.
 */

/** `<uploads>/.restore-<stamp>/`: the staging folder. */
export const RESTORE_STAGING_PREFIX = ".restore-";

/**
 * `<uploads>/.restore-<stamp>.db-started`: the database-step marker (see
 * DB_STEP_MARKER_SUFFIX in ./full-restore.ts for when it is created and
 * removed).
 */
export const DB_STEP_MARKER_SUFFIX = ".db-started";

/** The only stamps the restore program accepts and so the only ones it ever creates a marker for: `YYYYmmdd-HHMMSS`, optionally `-<n>`. */
export const RESTORE_STAMP = /^\d{8}-\d{6}(-\d{1,10})?$/;

export const dbStepMarkerName = (stamp: string): string => `${RESTORE_STAGING_PREFIX}${stamp}${DB_STEP_MARKER_SUFFIX}`;

/**
 * The stamp in a marker's name, or null when `name` is not a marker's name.
 * ANY non-empty text between the prefix and the suffix counts, not only a
 * stamp of the RESTORE_STAMP shape: whatever carries that name blocks the
 * app's start, and the rollback script (scripts/snapshot-restore.sh) goes by
 * the name alone too. Callers that derive something else from the stamp (a
 * recovery file's name) check RESTORE_STAMP themselves.
 */
/** Orders strings by UTF-16 code unit (never by locale), like `<` on strings. For the restore program's stamps that is oldest first. */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function markerStamp(name: string): string | null {
  if (!name.startsWith(RESTORE_STAGING_PREFIX) || !name.endsWith(DB_STEP_MARKER_SUFFIX)) return null;
  const stamp = name.slice(RESTORE_STAGING_PREFIX.length, name.length - DB_STEP_MARKER_SUFFIX.length);
  return stamp.length > 0 ? stamp : null;
}
