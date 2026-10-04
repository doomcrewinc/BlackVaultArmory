import { chmodSync, existsSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { ENCRYPTED_FIELDS } from "./fields";
import { resolveProvider, type DbProvider } from "../db/provider";

/**
 * The app's own snapshot before the FIRST encryption of existing data.
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
 * - PostgreSQL: the app cannot dump its own server. It says so, and that
 *   ./update.sh / update.bat take one in backups/ before starting a new
 *   version — the app cannot tell whether they did — then continues. No
 *   pg_dump command is printed: by the time anyone could
 *   run it, the data is already encrypted.
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

/** A FINAL snapshot name; `.partial` files (a copy that never finished) never match. */
const FINAL_NAME = /^pre-encryption-\d{8}-\d{6}(-\d+)?\.db$/;
const PARTIAL_NAME = /^pre-encryption-\d{8}-\d{6}(-\d+)?\.db\.partial$/;

/**
 * True when `file` is a complete SQLite copy of this database: it attaches,
 * `PRAGMA quick_check` says ok, and it holds the Firearm table. (A VACUUM
 * INTO killed part-way can leave a file that opens as an EMPTY database and
 * passes quick_check; the table check catches that.) Read-only; on the one
 * raw connection, outside any transaction.
 */
async function isCompleteSnapshot(raw: SnapshotClient, file: string): Promise<boolean> {
  try {
    await raw.$executeRawUnsafe(`ATTACH DATABASE ${sqlLiteral(file)} AS bv_snapshot_check`);
  } catch {
    return false;
  }
  try {
    const check = await raw.$queryRawUnsafe<Array<Record<string, unknown>>>("PRAGMA bv_snapshot_check.quick_check");
    if (check.length !== 1 || Object.values(check[0])[0] !== "ok") return false;
    const tables = await raw.$queryRawUnsafe<unknown[]>(
      "SELECT 1 AS hit FROM bv_snapshot_check.sqlite_master WHERE type = 'table' AND name = 'Firearm'",
    );
    return tables.length === 1;
  } catch {
    return false;
  } finally {
    await raw.$executeRawUnsafe("DETACH DATABASE bv_snapshot_check").catch(() => undefined);
  }
}

/**
 * The newest complete pre-encryption snapshot in `dir` younger than
 * SNAPSHOT_REUSE_MS, or null. Only final names are considered, and each
 * candidate must pass isCompleteSnapshot.
 */
async function recentSnapshot(raw: SnapshotClient, dir: string, now: Date, warn: (line: string) => void): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((name) => FINAL_NAME.test(name))
    .map((name) => ({ file: path.join(dir, name), mtime: statSync(path.join(dir, name)).mtimeMs }))
    .filter((c) => now.getTime() - c.mtime < SNAPSHOT_REUSE_MS)
    .sort((a, b) => b.mtime - a.mtime);
  for (const c of candidates) {
    if (await isCompleteSnapshot(raw, c.file)) return c.file;
    warn(`[encryption] Ignoring an incomplete or damaged earlier snapshot: ${c.file}`);
  }
  return null;
}

/** Removes `.partial` leftovers of copies that never finished (plaintext, and useless). */
function removeStalePartials(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (PARTIAL_NAME.test(name)) rmSync(path.join(dir, name), { force: true });
  }
}

/**
 * Where the snapshot is on the HOST. In the container the
 * database folder is /app/data, which docker-compose.yml mounts from
 * ${DATA_DIR}/db and passes as BLACKVAULT_HOST_DB_DIR. Outside a container
 * the path is already a host path.
 */
export function hostPathOf(file: string, env: Record<string, string | undefined> = process.env): string {
  const inContainerDir = "/app/data/";
  if (!file.startsWith(inContainerDir)) return file;
  const hostDir = (env.BLACKVAULT_HOST_DB_DIR ?? "").trim();
  if (hostDir) return path.posix.join(hostDir.replace(/\\/g, "/"), file.slice(inContainerDir.length));
  return `${file} (in the container; on the host it is in the db/ folder of your BlackVault data directory)`;
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
    // The app cannot know whether update.sh/update.bat
    // took a snapshot, so it says both cases honestly, and prints no pg_dump
    // command — a dump taken after this line would hold only ciphertext.
    warn(
      "[encryption] Encrypting existing serial numbers and NFA records now. The app cannot snapshot its own PostgreSQL server. " +
        "If this version was started by ./update.sh or update.bat, they saved a plaintext snapshot in backups/ " +
        "(blackvault-<timestamp>.sql) first; otherwise no snapshot exists, and a dump taken from now on holds only encrypted values.",
    );
    return { kind: "postgres-not-taken" };
  }

  let target: string;
  try {
    const dbFile = await sqliteDatabaseFile(raw);
    const dir = path.dirname(dbFile);
    const reuse = await recentSnapshot(raw, dir, now, warn);
    if (reuse) {
      log(`[encryption] Keeping the pre-encryption snapshot taken earlier: ${hostPathOf(reuse)}`);
      return { kind: "reused", file: reuse };
    }
    removeStalePartials(dir);
    target = path.join(dir, `${SNAPSHOT_PREFIX}${snapshotStamp(now)}.db`);
    if (existsSync(target)) target = path.join(dir, `${SNAPSHOT_PREFIX}${snapshotStamp(now)}-${process.pid}.db`);
    // Written under a .partial name and renamed only once
    // complete, so a copy killed part-way never carries a final name.
    const partial = `${target}.partial`;
    rmSync(partial, { force: true });
    try {
      // Created EMPTY and mode 0600 BEFORE any data is written
      // (VACUUM INTO accepts an existing empty file); chmod as well, since a
      // default ACL on the folder can override the creation mode.
      writeFileSync(partial, "", { mode: 0o600, flag: "wx" });
      chmodSync(partial, 0o600);
      await raw.$executeRawUnsafe(`VACUUM INTO ${sqlLiteral(partial)}`);
      renameSync(partial, target);
    } catch (e) {
      rmSync(partial, { force: true });
      throw e;
    }
  } catch (e) {
    throw new Error(
      "Could not take the pre-encryption database snapshot, so nothing was encrypted " +
        `(${e instanceof Error ? e.message : String(e)}). Free disk space or fix the data folder's permissions.`,
      { cause: e },
    );
  }
  log(`[encryption] Snapshot taken before encrypting existing data: ${hostPathOf(target)}`);
  log(
    "[encryption] It is a PLAINTEXT copy of your database. Delete it once BlackVault is confirmed working. " +
      "On Linux it is owned by the container user (uid 1001): delete it with sudo rm.",
  );
  return { kind: "taken", file: target };
}
