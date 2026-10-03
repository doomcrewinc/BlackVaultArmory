import { prisma } from "@/lib/prisma";
import { BACKUP_MODELS } from "./models";

/**
 * The one place that reads "everything a backup holds" out of the database.
 * Both the small sealed backup (`POST /api/backup`) and the full backup
 * engine (`./full-backup.ts`, as `db.json`) call these, so the two can never
 * drift apart on which records a backup carries.
 *
 * Reads go through the APP client (`@/lib/prisma`), so encrypted fields come
 * back decrypted — a backup must be restorable under a different key.
 */

type ReadDelegate = { findMany: () => Promise<unknown[]> };

export type BackupRecords = Record<string, unknown[]>;

export interface BackupPayloadMeta {
  version: "1.1";
  createdAt: string;
  includeUploads: boolean;
  counts: Record<string, number>;
}

export type BackupPayload = { meta: BackupPayloadMeta } & BackupRecords;

/** Every `BACKUP_MODELS` table, keyed by its backup key. Sequential on purpose: `connection_limit=1` means `Promise.all` would deadlock. */
export async function collectBackupRecords(): Promise<BackupRecords> {
  const delegates = prisma as unknown as Record<string, ReadDelegate>;
  const records: BackupRecords = {};
  for (const { delegate, key } of BACKUP_MODELS) {
    records[key] = await delegates[delegate].findMany();
  }
  return records;
}

/** Row count per backup key. */
export function backupCounts(records: BackupRecords): Record<string, number> {
  return Object.fromEntries(Object.entries(records).map(([key, rows]) => [key, rows.length]));
}

/** The backup JSON document: `{ meta, ...records }` — the shape `POST /api/backup/restore` reads. */
export function buildBackupPayload(records: BackupRecords, opts: { now: Date; includeUploads: boolean }): BackupPayload {
  const meta: BackupPayloadMeta = {
    version: "1.1",
    createdAt: opts.now.toISOString(),
    includeUploads: opts.includeUploads,
    counts: backupCounts(records),
  };
  return { meta, ...records } as BackupPayload;
}
