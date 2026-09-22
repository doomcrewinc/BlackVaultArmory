/**
 * One-way, verified copy of a BlackVault SQLite database into Postgres, then
 * (for this Docker stack's own database) the .migrated record and .env switch.
 *
 *   npm run migrate:to-postgres [-- --dry-run] [-- --force] [-- --write-env]
 *
 * Arguments are command-line environment variables for THIS run, not .env
 * keys (docker-compose.yml never reads them):
 *
 * SQLITE_URL   source; default file:${DATA_DIR}/db/vault.db, DATA_DIR from .env
 *              (default ./data). Only ever read.
 * POSTGRES_URL target. Defaults to the stack's database through
 *              docker-compose.migrate.yml: 127.0.0.1:55432 with
 *              BLACKVAULT_POSTGRES_PASSWORD from .env. Must be postgres:// or
 *              postgresql://, already migrated (`prisma migrate deploy`), and
 *              empty unless --force. DATABASE_URL is never read: it is
 *              commonly exported in a shell for other Prisma projects.
 * --dry-run    print source row counts and exit; never connects to the target,
 *              never writes .migrated or .env.
 * --force      copy even if the target already has rows (it does not wipe them),
 *              or if ${DATA_DIR}/db/.migrated says this install already migrated.
 * --write-env  switch .env even though the target is not 127.0.0.1:55432. Every
 *              other check still applies (see stackTargetCheck).
 *
 * After a VERIFIED copy into the stack's own database it writes
 * ${DATA_DIR}/db/.migrated and switches .env (backup: .env.pre-migration).
 * Otherwise it prints the lines to add by hand. See src/lib/db/migration-finalize.ts.
 *
 * Deliberately does NOT load .env into the environment: .env is only parsed for
 * DATA_DIR and BLACKVAULT_POSTGRES_PASSWORD, and the two URLs are handed to each
 * client explicitly, so nothing in .env can redirect the source or target.
 */
import fs from "fs";
import path from "path";
import type { DbClient } from "../src/lib/db/sqlite-to-postgres";
import { ENV_PASSWORD, maskUrl, overlayUrl, resolveStack, runMigration } from "../src/lib/db/migration-finalize";

type ClientCtor = new (options: { datasources: { db: { url: string } } }) => DbClient;

const FLAGS = ["--dry-run", "--force", "--write-env"];
const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!FLAGS.includes(a)) {
    console.error(`Unknown argument: ${a}`);
    process.exit(2);
  }
}
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const writeEnv = args.has("--write-env");

const repo = path.join(__dirname, "..");
const stack = resolveStack(repo);
const stackPassword = stack.env.get(ENV_PASSWORD) ?? "";
const sqliteUrl = process.env.SQLITE_URL || `file:${stack.stackSqlitePath}`;
const isPostgresUrl = (url: string) => /^postgres(ql)?:\/\//.test(url);
const [postgresUrl, postgresUrlFrom] = process.env.POSTGRES_URL
  ? [process.env.POSTGRES_URL, "POSTGRES_URL"]
  : stackPassword
    ? [overlayUrl(stackPassword), `${ENV_PASSWORD} in .env`]
    : ["", ""];

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  console.error("The source SQLite database was not modified.");
  process.exit(1);
}

if (!sqliteUrl.startsWith("file:")) fail(`SQLITE_URL must be a file: URL, got ${sqliteUrl}`);
// Prisma creates a missing SQLite file on connect; refuse rather than "migrate" an empty new file.
const sqlitePath = path.resolve(sqliteUrl.slice("file:".length).split("?")[0]);
if (!fs.existsSync(sqlitePath)) fail(`source SQLite file does not exist: ${sqlitePath}`);

const postgresOk = isPostgresUrl(postgresUrl);
if (!dryRun && !postgresOk) {
  fail(`POSTGRES_URL (or ${ENV_PASSWORD} in .env) must give a postgres:// or postgresql:// URL`);
}

console.log("BlackVault SQLite -> Postgres migrator (one-way)");
console.log(`  source (SQLite):   file:${sqlitePath}`);
console.log(
  `  target (Postgres): ${postgresOk ? `${maskUrl(postgresUrl)}  (from ${postgresUrlFrom})` : "<not set>"}${dryRun ? "  (not contacted: --dry-run)" : ""}`,
);
if (process.env.DATABASE_URL) {
  console.log("  (DATABASE_URL in this shell is ignored; use POSTGRES_URL to pick a target)");
}
if (force) console.log("  --force: a non-empty target or an existing .migrated will not be refused");
console.log("");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const SqliteClient: ClientCtor = require(".prisma/client-sqlite").PrismaClient;
const source = new SqliteClient({ datasources: { db: { url: `file:${sqlitePath}` } } });

runMigration({
  stack,
  sqlitePath,
  postgresUrl,
  dryRun,
  force,
  writeEnv,
  source,
  connectTarget: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PostgresClient: ClientCtor = require("@prisma/client").PrismaClient;
    return new PostgresClient({ datasources: { db: { url: postgresUrl } } });
  },
})
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
