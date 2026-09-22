/**
 * One-way, verified copy of a BlackVault SQLite database into Postgres.
 *
 *   SQLITE_URL=file:/abs/path/vault.db POSTGRES_URL=postgresql://... npm run migrate:to-postgres [-- --dry-run] [-- --force]
 *
 * SQLITE_URL   source; default file:<repo>/data/db/vault.db. Only ever read.
 * POSTGRES_URL target (falls back to DATABASE_URL); must be postgres:// or postgresql://,
 *              already migrated (`prisma migrate deploy`), and empty unless --force.
 * --dry-run    print source row counts and exit; never connects to the target.
 * --force      copy even if the target already has rows (it does not wipe them).
 *
 * Deliberately does NOT load .env: the two URLs are read from the real
 * environment once, here, and handed to each client explicitly, so a DATABASE_URL
 * in .env can never redirect the source or the target.
 */
import fs from "fs";
import path from "path";
import { migrateSqliteToPostgres, type DbClient } from "../src/lib/db/sqlite-to-postgres";

type ClientCtor = new (options: { datasources: { db: { url: string } } }) => DbClient;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
for (const a of args) {
  if (a !== "--dry-run" && a !== "--force") {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}

const repo = path.join(__dirname, "..");
const sqliteUrl = process.env.SQLITE_URL || `file:${path.join(repo, "data", "db", "vault.db")}`;
const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";

function mask(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "<unparseable URL>";
  }
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  console.error("The source SQLite database was not modified.");
  process.exit(1);
}

if (!sqliteUrl.startsWith("file:")) fail(`SQLITE_URL must be a file: URL, got ${sqliteUrl}`);
// Prisma creates a missing SQLite file on connect; refuse rather than "migrate" an empty new file.
const sqlitePath = path.resolve(sqliteUrl.slice("file:".length).split("?")[0]);
if (!fs.existsSync(sqlitePath)) fail(`source SQLite file does not exist: ${sqlitePath}`);

const postgresOk = /^postgres(ql)?:\/\//.test(postgresUrl);
if (!dryRun && !postgresOk) {
  fail("POSTGRES_URL (or DATABASE_URL) must be set to a postgres:// or postgresql:// URL");
}

console.log("BlackVault SQLite -> Postgres migrator (one-way)");
console.log(`  source (SQLite):   file:${sqlitePath}`);
console.log(
  `  target (Postgres): ${postgresOk ? mask(postgresUrl) : "<not set>"}${dryRun ? "  (not contacted: --dry-run)" : ""}`,
);
if (force) console.log("  --force: a non-empty target will not be refused");
console.log("");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SqliteClient: ClientCtor = require(".prisma/client-sqlite").PrismaClient;
const source = new SqliteClient({ datasources: { db: { url: `file:${sqlitePath}` } } });

migrateSqliteToPostgres({
  source,
  connectTarget: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PostgresClient: ClientCtor = require("@prisma/client").PrismaClient;
    return new PostgresClient({ datasources: { db: { url: postgresUrl } } });
  },
  dryRun,
  force,
}).then((code) => process.exit(code));
