import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { resolveProvider } from "@/lib/db/provider";
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

/**
 * Internal seam for the real-database test: awaited after each table is read,
 * so a second writer can be interleaved deterministically. Never set in
 * production code.
 */
export const backupRecordHooks: { afterRead: ((key: string) => Promise<void>) | null } = { afterRead: null };

/**
 * The read transaction may outlive Prisma's 5 s default on a large install
 * (every table, one connection), and on SQLite it may queue behind a writer.
 * On SQLite the read holds the app's single connection for its whole duration,
 * so every other request waits while it runs; two minutes is far past any
 * realistic read and still bounds that pause if a read stalls.
 */
const READ_TX_TIMEOUT_MS = 120_000;
const READ_TX_MAX_WAIT_MS = 30_000;

/**
 * Every `BACKUP_MODELS` table, keyed by its backup key, read from ONE
 * consistent view: a parent and child written while the backup runs are either
 * both in it or both out.
 * - SQLite: one transaction sees one snapshot; reads are sequential on the
 *   transaction client (a second query path would deadlock `connection_limit=1`).
 * - PostgreSQL: `RepeatableRead`, since the default `READ COMMITTED` takes a
 *   fresh snapshot per statement.
 * The audit layer resolves the actor before the transaction opens, and the
 * transaction client carries the encryption layer, so fields still decrypt.
 * Call this outside any other transaction.
 */
export async function collectBackupRecords(): Promise<BackupRecords> {
  const postgres = resolveProvider(process.env.DB_PROVIDER, process.env.DATABASE_URL) !== "sqlite";
  return prisma.$transaction(
    async (tx) => {
      const delegates = tx as unknown as Record<string, ReadDelegate>;
      const records: BackupRecords = {};
      for (const { delegate, key } of BACKUP_MODELS) {
        records[key] = await delegates[delegate].findMany();
        await backupRecordHooks.afterRead?.(key);
      }
      return records;
    },
    {
      maxWait: READ_TX_MAX_WAIT_MS,
      timeout: READ_TX_TIMEOUT_MS,
      ...(postgres ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead } : {}),
    },
  );
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
