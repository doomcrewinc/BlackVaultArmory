import { promises as fsp } from "node:fs";
import path from "node:path";

/**
 * `--keep N` (spec 3c §2, ruling R18): after a full backup has been made,
 * deletes the oldest published full backups beyond the newest N.
 *
 * It runs INSIDE the container, in the same invocation as the backup
 * (`scripts/entry/full-backup.ts`): the backups are mode 0600 files owned by
 * uid 1001 in a 0700 folder, which the host user running `backup.sh` cannot
 * list or delete on Linux.
 *
 * The caller's side of the contract: call this ONLY after `runFullBackup`
 * resolved, i.e. after this run's archive was verified and published, and
 * pass that archive's file name as `justCreated`. A failed backup (a failed
 * verify included) never reaches this function, so it deletes nothing.
 *
 * What this function guarantees on its own:
 * - Candidates are regular files named EXACTLY
 *   `blackvault-full-<YYYYmmdd-HHMMSS>.bvb`. A work file
 *   (`blackvault-full-<ts>.<16 hex>.bvb.partial`), the lock, a symlink, a
 *   folder, a renamed copy (`blackvault-full-…-offsite.bvb`) or anything else
 *   in the folder is never touched.
 * - Order is by the timestamp in the NAME (fixed width, so name order is
 *   time order), newest first; file times are not used (a copy or a restore
 *   from another disk changes them).
 * - The newest `keep` candidates are kept. `justCreated` is kept as well even
 *   if its name is not among them (a clock that was set back): then `keep + 1`
 *   files remain, which errs on the side of keeping.
 * - If `justCreated` is not a candidate (not there, or not a published
 *   name), NOTHING is deleted and a warning says so: the "a verified new
 *   backup exists" premise does not hold.
 * - A file that cannot be deleted is a warning, not an error; the others are
 *   still deleted.
 */

/** A published full backup's file name; group 1 is `<YYYYmmdd-HHMMSS>`. */
export const PUBLISHED_FULL_BACKUP_NAME = /^blackvault-full-(\d{8}-\d{6})\.bvb$/;

/** Upper bound for `--keep`; far above any real retention, and well inside a safe integer. */
export const MAX_KEEP = 100_000;

export class KeepValueError extends Error {
  constructor() {
    // Deliberately does not echo the value (same rule as the CLI's unknown-argument message).
    super(`--keep needs a whole number from 1 to ${MAX_KEEP}.`);
    this.name = "KeepValueError";
  }
}

/** `--keep`'s value: decimal digits only, 1..MAX_KEEP. Anything else throws KeepValueError. */
export function parseKeep(value: string): number {
  if (!/^[0-9]{1,6}$/.test(value)) throw new KeepValueError();
  const keep = Number(value);
  if (!Number.isInteger(keep) || keep < 1 || keep > MAX_KEEP) throw new KeepValueError();
  return keep;
}

export interface PruneResult {
  /** File names that were deleted, oldest first. */
  deleted: string[];
  /** One message per thing that went wrong; the run is still a success. */
  warnings: string[];
}

const codeOf = (e: unknown): string => (e as NodeJS.ErrnoException | null)?.code ?? (e instanceof Error ? e.message : String(e));

export async function pruneFullBackups(dir: string, keep: number, justCreated: string): Promise<PruneResult> {
  if (!Number.isInteger(keep) || keep < 1) throw new KeepValueError();
  const result: PruneResult = { deleted: [], warnings: [] };

  const candidates: string[] = [];
  for (const name of await fsp.readdir(dir)) {
    if (!PUBLISHED_FULL_BACKUP_NAME.test(name)) continue;
    const stat = await fsp.lstat(path.join(dir, name)).catch(() => null);
    if (stat?.isFile()) candidates.push(name);
  }
  if (!candidates.includes(justCreated)) {
    result.warnings.push(`--keep deleted nothing: the backup just made (${justCreated}) was not found in ${dir}.`);
    return result;
  }

  // Fixed-width timestamps: plain string order is time order. Newest first.
  candidates.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const doomed = candidates.slice(keep).filter((name) => name !== justCreated).reverse();
  for (const name of doomed) {
    try {
      await fsp.unlink(path.join(dir, name));
      result.deleted.push(name);
    } catch (e) {
      if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") continue; // already gone: nothing to warn about
      result.warnings.push(`could not delete the old backup ${name} (${codeOf(e)}); delete it by hand.`);
    }
  }
  return result;
}
