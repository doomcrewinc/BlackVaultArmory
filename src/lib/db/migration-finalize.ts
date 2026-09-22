/**
 * What happens around the SQLite -> Postgres copy for a Docker install: the
 * `.migrated` record and the `.env` switch.
 *
 * After a VERIFIED copy into this stack's own Postgres, the migrator:
 *   1. writes ${DATA_DIR}/db/.migrated (the app sees it as /app/data/.migrated,
 *      so the split-brain guard knows vault.db is a known leftover), then
 *   2. switches .env to the four Postgres keys, keeping every other line,
 *      after backing it up to .env.pre-migration.
 *
 * "This stack's own Postgres" is checked, not assumed (see stackTargetCheck):
 * .env must never be switched to a database the app will not actually reach.
 * When the check fails, nothing is written and the exact lines are printed.
 *
 * An existing .migrated makes the migrator refuse to run unless --force.
 */
import fs from "fs";
import path from "path";
import { migrateSqliteToPostgres, type DbClient } from "./sqlite-to-postgres";

export const MARKER_NAME = ".migrated";
export const ENV_BACKUP_NAME = ".env.pre-migration";
/** Host port docker-compose.migrate.yml publishes the stack's database on. */
export const OVERLAY_PORT = "55432";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STACK_USER = "blackvault";
const STACK_DB = "blackvault";

export interface Stack {
  repoDir: string;
  envPath: string;
  envExists: boolean;
  env: Map<string, string>;
  /** Absolute DATA_DIR (from .env, default ./data, relative to the repo). */
  dataDir: string;
  /** ${DATA_DIR}/db/vault.db: the file the app mounts as /app/data/vault.db. */
  stackSqlitePath: string;
  /** ${DATA_DIR}/db/.migrated: the app sees it as /app/data/.migrated. */
  markerPath: string;
}

export interface MigrationRecord {
  migratedAt: string;
  source: string;
  target: string;
  counts: Record<string, number>;
  totalRows: number;
}

/** Minimal .env reader: KEY=VALUE, `#` comments, surrounding quotes/whitespace stripped, last wins. */
export function parseEnv(text: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (m) env.set(m[1], unquote(m[2]));
  }
  return env;
}

function unquote(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

export function resolveStack(repoDir: string): Stack {
  const envPath = path.join(repoDir, ".env");
  const envExists = fs.existsSync(envPath);
  const env = envExists ? parseEnv(fs.readFileSync(envPath, "utf8")) : new Map<string, string>();
  const dataDir = path.resolve(repoDir, env.get("DATA_DIR") || "./data");
  return {
    repoDir,
    envPath,
    envExists,
    env,
    dataDir,
    stackSqlitePath: path.join(dataDir, "db", "vault.db"),
    markerPath: path.join(dataDir, "db", MARKER_NAME),
  };
}

/** URL the migrator uses when POSTGRES_URL is unset: the stack's db through the overlay. */
export function overlayUrl(password: string): string {
  return `postgresql://${STACK_USER}:${encodeURIComponent(password)}@127.0.0.1:${OVERLAY_PORT}/${STACK_DB}`;
}

export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return "<unparseable URL>";
  }
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}

/**
 * Is the copy's target the database the app will reach after the switch, and
 * its source the vault.db the app has been using? Every rule must hold:
 *
 *  - the source is ${DATA_DIR}/db/vault.db, so the marker lands next to the
 *    file that was actually copied;
 *  - .env holds a POSTGRES_PASSWORD, and the target URL authenticates as
 *    blackvault/blackvault with exactly that password. It is random, and it is
 *    what the stack's db container was initialised with, so it ties the target
 *    to this stack. The switched DATABASE_URL uses the same password;
 *  - the target is 127.0.0.1:55432, the port only docker-compose.migrate.yml
 *    publishes, and only on this machine. --write-env skips this one rule, for
 *    a user who reached the stack's db some other way and says so.
 */
export function stackTargetCheck(opts: {
  targetUrl: string;
  sqlitePath: string;
  stack: Stack;
  writeEnv: boolean;
}): { ok: boolean; reasons: string[] } {
  const { stack } = opts;
  const reasons: string[] = [];
  if (!samePath(opts.sqlitePath, stack.stackSqlitePath)) {
    reasons.push(`the source is not this install's database (${stack.stackSqlitePath})`);
  }
  const password = stack.env.get("POSTGRES_PASSWORD") ?? "";
  if (!stack.envExists) reasons.push(`there is no .env at ${stack.envPath}`);
  else if (!password) reasons.push(".env has no POSTGRES_PASSWORD");
  let u: URL | undefined;
  try {
    u = new URL(opts.targetUrl);
  } catch {
    reasons.push("the target URL cannot be parsed");
  }
  if (u) {
    if (decodeURIComponent(u.username) !== STACK_USER || u.pathname !== `/${STACK_DB}`) {
      reasons.push(`the target is not the ${STACK_USER} database on user ${STACK_USER}`);
    }
    if (password && decodeURIComponent(u.password) !== password) {
      reasons.push("the target's password is not POSTGRES_PASSWORD from .env");
    }
    if (!opts.writeEnv && !(LOOPBACK.has(u.hostname) && u.port === OVERLAY_PORT)) {
      reasons.push(
        `the target is not 127.0.0.1:${OVERLAY_PORT} (docker-compose.migrate.yml); pass --write-env if it is this stack's database anyway`,
      );
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** The four .env keys of a Postgres install, in the order they are written. */
export function postgresEnv(password: string): [string, string][] {
  return [
    ["COMPOSE_PROFILES", "postgres"],
    ["DB_PROVIDER", "postgres"],
    ["POSTGRES_PASSWORD", password],
    ["DATABASE_URL", `postgresql://${STACK_USER}:${encodeURIComponent(password)}@db:5432/${STACK_DB}`],
  ];
}

function maskValue(key: string, value: string): string {
  if (key === "POSTGRES_PASSWORD") return value ? "****" : "";
  if (key === "DATABASE_URL" && /^postgres(ql)?:\/\//.test(value)) return maskUrl(value);
  return value;
}

function mergeProfiles(current: string): string {
  const profiles = current.split(",").map((p) => p.trim()).filter(Boolean);
  if (!profiles.includes("postgres")) profiles.push("postgres");
  return profiles.join(",");
}

/**
 * Rewrites the given keys in .env text, keeping every other line (comments,
 * blank lines, unrelated keys) and its line endings. The first occurrence of a
 * key is replaced in place, later duplicates are dropped, missing keys are
 * appended. COMPOSE_PROFILES gains "postgres" alongside any profile it had.
 * Returns the new text and a masked, human-readable list of changes.
 */
export function applyEnvUpdates(text: string, updates: [string, string][]): { text: string; changes: string[] } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const wanted = new Map(updates);
  const seen = new Set<string>();
  const changes: string[] = [];
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m || !wanted.has(m[1])) {
      out.push(line);
      continue;
    }
    const key = m[1];
    const old = unquote(m[2]);
    if (seen.has(key)) {
      changes.push(`  removed duplicate ${key}=${maskValue(key, old)}`);
      continue;
    }
    seen.add(key);
    const value = key === "COMPOSE_PROFILES" ? mergeProfiles(old) : wanted.get(key)!;
    out.push(`${key}=${value}`);
    if (old !== value) changes.push(`  ${key}: ${maskValue(key, old) || "(empty)"} -> ${maskValue(key, value)}`);
  }
  const missing = updates.filter(([key]) => !seen.has(key));
  if (missing.length > 0) {
    out.push("# PostgreSQL - written by npm run migrate:to-postgres");
    for (const [key, value] of missing) {
      out.push(`${key}=${value}`);
      changes.push(`  ${key}: (not set) -> ${maskValue(key, value)}`);
    }
  }
  return { text: out.join(eol) + eol, changes };
}

/** Writes via a temp file in the same directory, then renames over the target. */
function writeAtomic(file: string, content: string, mode: number): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}`);
  try {
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** Backs .env up (never over an earlier backup), then switches it atomically, mode 600. */
export function switchEnvFile(stack: Stack, updates: [string, string][], log: (l: string) => void): string {
  const current = fs.readFileSync(stack.envPath, "utf8");
  let backup = path.join(stack.repoDir, ENV_BACKUP_NAME);
  if (fs.existsSync(backup)) backup = `${backup}.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(stack.envPath, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  const { text, changes } = applyEnvUpdates(current, updates);
  writeAtomic(stack.envPath, text, 0o600);
  log(`Switched ${stack.envPath} to PostgreSQL (backup: ${backup}):`);
  for (const c of changes) log(c);
  return backup;
}

export function writeMarker(markerPath: string, record: MigrationRecord): void {
  writeAtomic(markerPath, JSON.stringify(record, null, 2) + "\n", 0o644);
}

export interface RunMigrationOptions {
  stack: Stack;
  sqlitePath: string;
  postgresUrl: string;
  dryRun: boolean;
  force: boolean;
  writeEnv: boolean;
  source: DbClient;
  connectTarget: () => DbClient;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Prints the exact .env lines for a manual switch without printing the
 * password: DATABASE_URL refers to ${POSTGRES_PASSWORD}, which Compose expands
 * from the line above it in .env.
 */
function manualSteps(opts: RunMigrationOptions, hasPassword: boolean, log: (l: string) => void): void {
  log("To finish by hand, set these four lines in .env (keep only one of each):");
  log("  COMPOSE_PROFILES=postgres");
  log("  DB_PROVIDER=postgres");
  log(`  POSTGRES_PASSWORD=${hasPassword ? "<already in your .env; keep it>" : "<the target database's password>"}`);
  log(`  DATABASE_URL=postgresql://${STACK_USER}:\${POSTGRES_PASSWORD}@db:5432/${STACK_DB}`);
  log("That DATABASE_URL is the stack's own database (db:5432). If your data went to another");
  log("server, use a URL BlackVault's container can reach instead.");
  log(`Then create ${opts.stack.markerPath} (any content) so the startup check knows`);
  log("vault.db is a leftover, and run: docker compose up -d --build");
}

/**
 * The whole migrator run: refuse an already-migrated install, copy and verify,
 * then (real run, verified, this stack's own database only) write .migrated and
 * switch .env. Returns the process exit code.
 */
export async function runMigration(opts: RunMigrationOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const { stack } = opts;

  if (fs.existsSync(stack.markerPath) && !opts.force) {
    let when = "";
    try {
      const rec = JSON.parse(fs.readFileSync(stack.markerPath, "utf8")) as Partial<MigrationRecord>;
      if (rec.migratedAt) when = ` on ${rec.migratedAt}`;
    } catch {
      // Unreadable marker: it still means this install was migrated.
    }
    log(`REFUSING: this install has already been migrated to PostgreSQL${when}.`);
    log(`  ${stack.markerPath} exists. vault.db is kept only as a rollback copy.`);
    log("Nothing was read or written. To copy again anyway, pass --force.");
    await opts.source.$disconnect().catch(() => {});
    return 1;
  }

  const check = stackTargetCheck({
    targetUrl: opts.postgresUrl,
    sqlitePath: opts.sqlitePath,
    stack,
    writeEnv: opts.writeEnv,
  });
  if (check.ok) {
    log(`After a verified copy: write ${stack.markerPath} and switch .env to PostgreSQL.`);
  } else {
    log("After a verified copy, .env will NOT be switched and no .migrated will be written, because:");
    for (const r of check.reasons) log(`  - ${r}`);
  }
  if (opts.writeEnv) log("  --write-env: the host/port check is skipped; you are vouching this is the stack's database.");
  log("");

  let verified: { counts: ReadonlyMap<string, number>; total: number } | undefined;
  const code = await migrateSqliteToPostgres({
    source: opts.source,
    connectTarget: opts.connectTarget,
    dryRun: opts.dryRun,
    force: opts.force,
    log,
    onVerified: (counts, total) => {
      verified = { counts, total };
    },
  });
  if (code !== 0 || opts.dryRun || !verified) {
    if (opts.dryRun && code === 0) log("Dry run: nothing written (no .migrated, .env unchanged).");
    return code;
  }

  log("");
  const password = stack.env.get("POSTGRES_PASSWORD") ?? "";
  if (!check.ok) {
    log("The copy is verified, but .env was NOT switched (see the reasons above).");
    manualSteps(opts, password !== "", log);
    return 0;
  }

  const record: MigrationRecord = {
    migratedAt: (opts.now ?? (() => new Date()))().toISOString(),
    source: opts.sqlitePath,
    target: maskUrl(opts.postgresUrl),
    counts: Object.fromEntries(verified.counts),
    totalRows: verified.total,
  };
  try {
    writeMarker(stack.markerPath, record);
    log(`Wrote ${stack.markerPath}`);
  } catch (err) {
    log(`ERROR: the copy is verified and committed, but ${stack.markerPath} could not be written:`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
    log(".env was NOT switched; BlackVault still runs on SQLite. Fix the folder's permissions");
    log("(e.g. sudo), or finish by hand:");
    manualSteps(opts, password !== "", log);
    return 1;
  }
  try {
    switchEnvFile(stack, postgresEnv(password), log);
  } catch (err) {
    log(`ERROR: the copy is verified and .migrated was written, but .env could not be switched:`);
    log(`  ${err instanceof Error ? err.message : String(err)}`);
    manualSteps(opts, password !== "", log);
    return 1;
  }
  log("");
  log("Next: docker compose up -d --build");
  return 0;
}
