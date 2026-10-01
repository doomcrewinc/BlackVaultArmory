import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { ENCRYPTED_FIELDS } from "./fields";
import { resolveProvider, type DbProvider } from "../db/provider";

/**
 * The app's own snapshot before the FIRST encryption of existing data
 * (Task 7, carry N4 in the field-encryption ledger).
 *
 * Why the app does this, not only the update scripts: `update.sh` git-pulls
 * itself, so the first upgrade INTO field encryption runs the OLD copy of
 * the script, which takes no snapshot (memory note "old script runs on
 * upgrade"). Any start that is about to encrypt plaintext rows therefore
 * snapshots first, whoever launched it:
 * - SQLite: `VACUUM INTO <dir of the database>/pre-encryption-<ts>.db`, on
 *   the raw client, BEFORE the migration transaction opens (VACUUM cannot
 *   run inside a transaction, and with `connection_limit=1` there is only
 *   the one connection). A snapshot failure refuses to start: nothing is
 *   encrypted without a copy to go back to.
 * - PostgreSQL: the app cannot dump its own server, so it logs loudly that no
 *   snapshot was taken and prints the exact pg_dump command, then continues.
 *
 * The copy is PLAINTEXT and stays on the data volume until deleted; the log
 * says so. Imports stay relative (no `@/`), as in startup.ts.
 */

export const SNAPSHOT_PREFIX = "pre-encryption-";

/**
 * A snapshot this recent is reused, not repeated. Without this a start that
 * keeps failing AFTER the snapshot (a refused migration under
 * `restart: unless-stopped`) would copy the whole database on every restart
 * and fill the disk.
 */
export const SNAPSHOT_REUSE_MS = 24 * 60 * 60 * 1000;

/** The exact command printed for PostgreSQL, run on the host next to docker-compose.yml. */
export const PG_DUMP_COMMAND =
  "docker compose exec -T db pg_dump -U blackvault -d blackvault > backups/blackvault-pre-encryption.sql";

type SnapshotClient = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

export type SnapshotResult =
  | { kind: "none" } // nothing to encrypt
  | { kind: "taken"; file: string }
  | { kind: "reused"; file: string }
  | { kind: "postgres-not-taken" };

/** `YYYYmmdd-HHMMSS` in UTC — the same stamp as the update scripts' backups/blackvault-<ts>.*. */
export function snapshotStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-` +
    `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`
  );
}

/**
 * True when some registered field holds a non-null value not yet in `bv2:`
 * form — exactly the rows runEncryptionMigration would convert. Read-only;
 * plain SQL so a required column and a nullable one
 * are tested the same way. No @@map in the schema: table = model name.
 */
export async function hasPlaintextValues(raw: SnapshotClient): Promise<boolean> {
  for (const d of ENCRYPTED_FIELDS) {
    const rows = await raw.$queryRawUnsafe<unknown[]>(
      `SELECT 1 AS hit FROM "${d.model}" WHERE "${d.field}" IS NOT NULL AND substr("${d.field}", 1, 4) <> 'bv2:' LIMIT 1`,
    );
    if (rows.length > 0) return true;
  }
  return false;
}

/** The absolute path of the open SQLite database, from SQLite itself (handles relative `file:` URLs). */
async function sqliteDatabaseFile(raw: SnapshotClient): Promise<string> {
  const rows = await raw.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list");
  const main = rows.find((r) => r.name === "main");
  if (!main?.file) throw new Error("SQLite reported no file for the main database (in-memory database?).");
  return main.file;
}

/** The newest pre-encryption snapshot in `dir` younger than SNAPSHOT_REUSE_MS, or null. */
function recentSnapshot(dir: string, now: Date): string | null {
  if (!existsSync(dir)) return null;
  let best: { file: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(SNAPSHOT_PREFIX) || !name.endsWith(".db")) continue;
    const file = path.join(dir, name);
    const mtime = statSync(file).mtimeMs;
    if (now.getTime() - mtime < SNAPSHOT_REUSE_MS && (!best || mtime > best.mtime)) best = { file, mtime };
  }
  return best?.file ?? null;
}

/** SQL string literal (single quotes doubled). */
function sqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Takes the pre-encryption snapshot when the database holds plaintext values
 * to encrypt. Throws (the caller refuses to start) when an SQLite snapshot
 * cannot be written.
 */
export async function takePreEncryptionSnapshot(
  raw: SnapshotClient,
  options: { provider?: DbProvider; now?: Date; log?: (line: string) => void; warn?: (line: string) => void } = {},
): Promise<SnapshotResult> {
  const provider = options.provider ?? resolveProvider(process.env.DB_PROVIDER, process.env.DATABASE_URL);
  const now = options.now ?? new Date();
  const log = options.log ?? ((line: string) => console.log(line));
  const warn = options.warn ?? ((line: string) => console.error(line));

  if (!(await hasPlaintextValues(raw))) return { kind: "none" };

  if (provider === "postgres") {
    warn("[encryption] WARNING: existing serial numbers and NFA records are about to be encrypted, and NO database");
    warn("[encryption] snapshot was taken first: the app cannot dump its own PostgreSQL server. ./update.sh and");
    warn("[encryption] update.bat take one in backups/ before starting a new version; this start did not come");
    warn("[encryption] through them. To keep a copy, run this on the host next to docker-compose.yml:");
    warn(`[encryption]   ${PG_DUMP_COMMAND}`);
    warn("[encryption] Continuing.");
    return { kind: "postgres-not-taken" };
  }

  let target: string;
  try {
    const dbFile = await sqliteDatabaseFile(raw);
    const dir = path.dirname(dbFile);
    const reuse = recentSnapshot(dir, now);
    if (reuse) {
      log(`[encryption] Keeping the pre-encryption snapshot taken earlier: ${reuse}`);
      return { kind: "reused", file: reuse };
    }
    target = path.join(dir, `${SNAPSHOT_PREFIX}${snapshotStamp(now)}.db`);
    if (existsSync(target)) target = path.join(dir, `${SNAPSHOT_PREFIX}${snapshotStamp(now)}-${process.pid}.db`);
    await raw.$executeRawUnsafe(`VACUUM INTO ${sqlLiteral(target)}`);
    chmodSync(target, 0o600);
  } catch (e) {
    throw new Error(
      "Could not take the pre-encryption database snapshot, so nothing was encrypted " +
        `(${e instanceof Error ? e.message : String(e)}). Free disk space or fix the data folder's permissions.`,
      { cause: e },
    );
  }
  log(`[encryption] Snapshot taken before encrypting existing data: ${target}`);
  log("[encryption] It is a PLAINTEXT copy of your database. Delete it once BlackVault is confirmed working.");
  return { kind: "taken", file: target };
}
