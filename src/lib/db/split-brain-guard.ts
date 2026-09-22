/**
 * Startup warning for a SQLite install whose .env was switched to PostgreSQL
 * without migrating: the app starts on a new, empty Postgres database while
 * the user's real data sits untouched in vault.db.
 *
 * Exact rule: warn only when the provider is postgres AND /app/data/vault.db
 * exists with size > 0 AND /app/data/.migrated is absent. The migrator writes
 * .migrated only after a verified copy, so with it present vault.db is a known
 * leftover (the rollback copy) and the guard stays silent. A new PostgreSQL
 * install has no vault.db at all.
 *
 * Log only. Never throws, never blocks startup, never changes data.
 */
import { existsSync, statSync } from "node:fs";
import type { DbProvider } from "./provider";

/** Where the app's /app/data mount keeps the SQLite file inside the container. */
export const LEGACY_SQLITE_PATH = "/app/data/vault.db";
/** Written by `npm run migrate:to-postgres` after a verified copy. */
export const MIGRATED_MARKER_PATH = "/app/data/.migrated";

export interface SplitBrainDeps {
  provider: DbProvider;
  /** Size in bytes of the SQLite file, or null when it does not exist. */
  sqliteFileSize: () => number | null;
  /** Whether the migrator's .migrated record exists. */
  migratedMarkerExists: () => boolean;
  warn: (message: string) => void;
}

export function splitBrainWarning(sqlitePath: string, sizeBytes: number): string {
  return [
    "",
    "=====================================================================",
    "  WARNING: BlackVault is running on PostgreSQL, but a SQLite database",
    `  with data exists at ${sqlitePath} (${sizeBytes} bytes) and was never`,
    `  migrated (there is no ${MIGRATED_MARKER_PATH}).`,
    "",
    "  This usually means .env was switched to PostgreSQL by hand. Your data",
    "  is NOT lost: it is still in vault.db, which has not been modified.",
    "",
    "  To go back to your data, stop BlackVault, remove these lines from .env:",
    "    COMPOSE_PROFILES=postgres, BLACKVAULT_DB_PROVIDER=postgres and",
    "    BLACKVAULT_DATABASE_URL=..., then run: docker compose up -d --remove-orphans",
    "",
    "  To move your data to PostgreSQL instead, follow",
    "  \"Moving from SQLite to PostgreSQL\" in README.md.",
    "=====================================================================",
    "",
  ].join("\n");
}

/** Returns true when the warning was logged. Never throws. */
export async function checkSplitBrain(deps: SplitBrainDeps): Promise<boolean> {
  try {
    if (deps.provider !== "postgres") return false;
    const size = deps.sqliteFileSize();
    if (size === null || size <= 0) return false;
    if (deps.migratedMarkerExists()) return false;
    deps.warn(splitBrainWarning(LEGACY_SQLITE_PATH, size));
    return true;
  } catch (error) {
    try {
      console.error("[split-brain-guard] check failed; continuing:", error);
    } catch {
      // Logging itself failed; there is nothing left to do.
    }
    return false;
  }
}

function fileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Wires the real provider and filesystem. Never throws. */
export async function runSplitBrainGuard(): Promise<void> {
  try {
    const { DB_PROVIDER } = await import("./provider");
    await checkSplitBrain({
      provider: DB_PROVIDER,
      sqliteFileSize: () => fileSize(LEGACY_SQLITE_PATH),
      migratedMarkerExists: () => existsSync(MIGRATED_MARKER_PATH),
      warn: (message) => console.warn(message),
    });
  } catch (error) {
    console.error("[split-brain-guard] startup check failed; continuing:", error);
  }
}
