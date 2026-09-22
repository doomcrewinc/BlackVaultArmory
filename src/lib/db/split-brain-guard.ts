/**
 * Startup warning for an existing SQLite install that was brought up on the
 * PostgreSQL compose file by mistake: the app starts on a new, empty Postgres
 * database while the user's real data sits untouched in vault.db.
 *
 * Log only. Never throws, never blocks startup, never changes data.
 */
import { statSync } from "node:fs";
import type { DbProvider } from "./provider";

/** Where docker-compose.sqlite.yml keeps the SQLite file inside the container. */
export const LEGACY_SQLITE_PATH = "/app/data/vault.db";

export interface SplitBrainDeps {
  provider: DbProvider;
  countFirearms: () => Promise<number>;
  /** Size in bytes of the SQLite file, or null when it does not exist. */
  sqliteFileSize: () => number | null;
  warn: (message: string) => void;
}

export function splitBrainWarning(sqlitePath: string, sizeBytes: number): string {
  return [
    "",
    "=====================================================================",
    "  WARNING: BlackVault is running on an EMPTY PostgreSQL database,",
    `  but a SQLite database with data exists at ${sqlitePath} (${sizeBytes} bytes).`,
    "",
    "  This usually means an existing SQLite install was started with the",
    "  PostgreSQL compose file (docker-compose.yml). Your data is NOT lost:",
    "  it is still in vault.db, which has not been modified.",
    "",
    "  To go back to your data, stop this stack and start the SQLite one:",
    "    docker compose down",
    "    docker compose -f docker-compose.sqlite.yml up -d",
    "  and make sure .env has DB_PROVIDER=sqlite (or no DB_PROVIDER line).",
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
    if ((await deps.countFirearms()) !== 0) return false;
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

/** Wires the real provider, Prisma client and filesystem. Never throws. */
export async function runSplitBrainGuard(): Promise<void> {
  try {
    const { DB_PROVIDER } = await import("./provider");
    // Cheap checks first: never load Prisma when the guard cannot apply.
    if (DB_PROVIDER !== "postgres" || !fileSize(LEGACY_SQLITE_PATH)) return;
    const { prisma } = await import("@/lib/prisma");
    await checkSplitBrain({
      provider: DB_PROVIDER,
      countFirearms: () => prisma.firearm.count(),
      sqliteFileSize: () => fileSize(LEGACY_SQLITE_PATH),
      warn: (message) => console.warn(message),
    });
  } catch (error) {
    console.error("[split-brain-guard] startup check failed; continuing:", error);
  }
}
