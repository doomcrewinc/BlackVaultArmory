/**
 * Which uploaded-file names a full backup may hold (ruling R26). ONE rule,
 * used by all three sides, so that a backup that verifies always restores:
 * - the backup walk (./full-backup.ts) SKIPS a file this refuses and records
 *   it in `manifest.skipped` ("unsupported file name");
 * - `verifyFullBackup` (./full-verify.ts) refuses an archive that holds one;
 * - the restore (./full-restore.ts) refuses it too, before any change.
 *
 * `entryPath` is an archive path, already valid by the tar rule
 * (`validateEntryPath`: relative, `/` only, no `.`/`..`/empty segment, no
 * NUL, no backslash). On top of that a name is refused when
 * - it is not under `files/images/` or `files/documents/`;
 * - it contains a control character (C0, DEL, C1);
 * - any segment is hidden (starts with `.`): `.pre-restore-*`, `.restore-*`
 *   and `.pre-encryption-*` are folders the app skips;
 * - it ends in `.tmp` (the startup sweep deletes interrupted writes) or
 *   `.rot` (key-rotation staging, which startup would rename over a file);
 * - it COLLIDES with a name already accepted: the two would be one file on
 *   a filesystem that ignores case or Unicode normalisation (macOS, Windows,
 *   many NAS shares), or one is a file where the other needs a folder
 *   (`a` and `a/b`).
 *
 * Collisions need the whole set, hence the class. WHICH of two colliding
 * names is kept: the one added FIRST. The backup walk adds names in archive
 * order — `images` before `documents`, and inside every folder by code-unit
 * order of the name, depth first — so the outcome is the same on every run:
 * `A.jpg` is kept and `a.jpg` skipped; a folder `A/` is kept whole and a
 * file `a` skipped.
 */

export const ENTRY_FILE_ROOTS = ["files/images/", "files/documents/"] as const;

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_CHARS_ALL = /[\u0000-\u001f\u007f-\u009f]/g;

/** `s` with every control character shown as `?`: safe for a terminal, a log line or the audit log. */
export function printableName(s: string): string {
  return s.replace(CONTROL_CHARS_ALL, "?");
}

/** Why this one name can never be in a backup, or null. Does not look at other names. */
export function entryNameRefusal(entryPath: string): string | null {
  if (!ENTRY_FILE_ROOTS.some((root) => entryPath.startsWith(root))) return "it does not belong in a backup (not under files/images/ or files/documents/)";
  if (CONTROL_CHARS.test(entryPath)) return "its name contains a control character";
  const segments = entryPath.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return "it is a hidden file or folder";
  const name = segments[segments.length - 1];
  if (name.endsWith(".tmp") || name.endsWith(".rot")) return "it is a work file (*.tmp / *.rot)";
  return null;
}

/** The names accepted so far. `add` returns why a name is refused (and does not add it), or null. */
export class EntryNameSet {
  private readonly files = new Map<string, string>();
  private readonly folders = new Map<string, string>();

  add(entryPath: string): string | null {
    const refusal = entryNameRefusal(entryPath);
    if (refusal) return refusal;
    const key = entryPath.normalize("NFC").toLowerCase();
    const clash = this.files.get(key) ?? this.folders.get(key);
    if (clash !== undefined) return this.collision(clash);
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) {
      const asFile = this.files.get(parts.slice(0, i).join("/"));
      if (asFile !== undefined) return this.collision(asFile);
    }
    for (let i = 1; i < parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      if (!this.folders.has(prefix)) this.folders.set(prefix, entryPath);
    }
    this.files.set(key, entryPath);
    return null;
  }

  private collision(other: string): string {
    return `it would be the same file or folder as "${printableName(other)}" on a system that ignores case or accents`;
  }
}
