import { promises as fsp } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

/**
 * The walk over the uploaded files, shared by the full backup
 * (src/lib/backup/full-backup.ts) and `reencrypt-files` (./reencrypt.ts), so
 * that both see exactly the same set of files. It imports no database code:
 * the re-encryption tool runs without one.
 *
 * fsp.* is always called through the imported namespace object so tests can
 * `vi.spyOn(fsp, …)` (same rule as ./storage.ts). Imports stay relative.
 */

/** The two folders under the uploads root that hold user files, and where each goes in a full-backup archive. */
export const UPLOAD_FOLDERS = [
  { dir: "images", archive: "files/images" },
  { dir: "documents", archive: "files/documents" },
] as const;

export interface UploadEntry {
  abs: string;
  archivePath: string;
  diskSize: number;
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** `*.tmp` (an interrupted writeAtomic), `*.rot` (key rotation staging) and hidden entries are never backed up. */
export function isExcludedName(name: string): boolean {
  return name.startsWith(".") || name.endsWith(".tmp") || name.endsWith(".rot");
}

/**
 * Every regular file under `<root>/images` and `<root>/documents`, in a
 * stable order. Hidden entries (which covers `.pre-encryption-*`,
 * `.restore-*` and `.pre-restore-*` folders), `*.tmp`, `*.rot` and symlinks —
 * to files or to folders — are left out; a symlink is never followed. A
 * folder that is missing (no uploads yet) or disappears mid-walk is empty.
 */
export async function listUploads(root: string): Promise<UploadEntry[]> {
  const found: UploadEntry[] = [];
  async function visit(dir: string, archiveDir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (codeOf(e) === "ENOENT" || codeOf(e) === "ENOTDIR") return;
      throw e;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (isExcludedName(e.name) || e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const archivePath = `${archiveDir}/${e.name}`;
      if (e.isDirectory()) await visit(abs, archivePath);
      else if (e.isFile()) {
        // A file gone between readdir and lstat stays listed: reading it
        // below is what records it as skipped.
        const diskSize = await fsp.lstat(abs).then((s) => s.size, () => 0);
        found.push({ abs, archivePath, diskSize });
      }
    }
  }
  for (const { dir, archive } of UPLOAD_FOLDERS) {
    const top = path.join(root, dir);
    // The top folder itself must be a real folder, not a link to one.
    const stat = await fsp.lstat(top).catch(() => null);
    if (stat?.isDirectory()) await visit(top, archive);
  }
  return found;
}
