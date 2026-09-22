/**
 * One-way SQLite -> Postgres copy with proof that nothing was lost.
 *
 * The guarantee: after a successful run, every one of the 16 models has exactly
 * as many rows on the target as the source had, and every copied row is
 * field-for-field identical (DateTimes compared as exact ISO strings). Anything
 * else exits 1. The source is only ever read — there is no reverse path.
 *
 * The copy runs inside one interactive transaction on the target, so a failure
 * part-way (FK violation, unique conflict, dropped connection) rolls the target
 * back to where it started instead of leaving a half-migrated database.
 *
 * Kept free of Prisma imports so it can be unit-tested with in-memory fakes;
 * scripts/migrate-sqlite-to-postgres.ts supplies the real clients.
 */
import { BACKUP_MODELS } from "../backup/models";

export interface MigrationModel {
  model: string;
  delegate: string;
}

/** AppSettings first, then the backup registry, which is already parent-first. */
export const MIGRATION_MODELS: readonly MigrationModel[] = [
  { model: "AppSettings", delegate: "appSettings" },
  ...BACKUP_MODELS.map(({ model, delegate }) => ({ model, delegate })),
];

export const BATCH_SIZE = 500;

/** One interactive transaction for the whole copy; generous because it holds every model. */
const TRANSACTION_OPTIONS = { maxWait: 30_000, timeout: 60 * 60 * 1000 };

export type Row = Record<string, unknown> & { id: string };

export interface FindManyArgs {
  take?: number;
  skip?: number;
  cursor?: { id: string };
  orderBy?: { id: "asc" };
  where?: { id: { in: string[] } };
}

export interface ModelDelegate {
  count(): Promise<number>;
  findMany(args: FindManyArgs): Promise<Row[]>;
  createMany(args: { data: Row[] }): Promise<{ count: number }>;
}

/** The subset of a PrismaClient (or transaction client) the migrator touches. */
export interface DbClient {
  $disconnect(): Promise<void>;
  $transaction<T>(fn: (tx: DbClient) => Promise<T>, options?: typeof TRANSACTION_OPTIONS): Promise<T>;
}

export interface MigrateOptions {
  source: DbClient;
  /** Only called on a real run — a dry run never constructs or connects to the target. */
  connectTarget: () => DbClient;
  dryRun: boolean;
  force: boolean;
  log?: (line: string) => void;
}

export const SOURCE_UNTOUCHED = "The source SQLite database was not modified.";

function delegateOf(client: DbClient, delegate: string): ModelDelegate {
  const d = (client as unknown as Record<string, ModelDelegate | undefined>)[delegate];
  if (!d) throw new Error(`Client has no model delegate "${delegate}"`);
  return d;
}

/** Stable, exact comparison form: sorted keys, Dates as ISO strings (ms precision). */
function normalize(row: Row): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const value = row[key];
    out[key] = value instanceof Date ? `Date(${value.toISOString()})` : value;
  }
  return JSON.stringify(out);
}

/** Pages a delegate in id order, BATCH_SIZE at a time. */
async function* pages(delegate: ModelDelegate): AsyncGenerator<Row[]> {
  let cursor: string | undefined;
  for (;;) {
    const page = await delegate.findMany({
      take: BATCH_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) return;
    yield page;
    if (page.length < BATCH_SIZE) return;
    cursor = page[page.length - 1].id;
  }
}

async function countAll(client: DbClient): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const m of MIGRATION_MODELS) counts.set(m.model, await delegateOf(client, m.delegate).count());
  return counts;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  "));
}

/** Copies every model; throws (rolling the transaction back) on any short write. */
async function copyAll(source: DbClient, tx: DbClient, log: (l: string) => void): Promise<Map<string, number>> {
  const copied = new Map<string, number>();
  for (const m of MIGRATION_MODELS) {
    const from = delegateOf(source, m.delegate);
    const to = delegateOf(tx, m.delegate);
    let n = 0;
    for await (const page of pages(from)) {
      const { count } = await to.createMany({ data: page });
      if (count !== page.length) {
        throw new Error(`${m.model}: createMany wrote ${count} of ${page.length} rows`);
      }
      n += count;
    }
    copied.set(m.model, n);
    log(`  copied ${m.model}: ${n}`);
  }
  return copied;
}

/** Re-reads every source row and compares it with the target row of the same id. Returns bad-row counts. */
async function verifyContent(source: DbClient, target: DbClient): Promise<Map<string, number>> {
  const bad = new Map<string, number>();
  for (const m of MIGRATION_MODELS) {
    const to = delegateOf(target, m.delegate);
    let n = 0;
    for await (const page of pages(delegateOf(source, m.delegate))) {
      const found = await to.findMany({ where: { id: { in: page.map((r) => r.id) } } });
      const byId = new Map(found.map((r) => [r.id, normalize(r)]));
      for (const row of page) if (byId.get(row.id) !== normalize(row)) n++;
    }
    bad.set(m.model, n);
  }
  return bad;
}

/** Returns the process exit code: 0 on a verified copy (or dry run), 1 otherwise. */
export async function migrateSqliteToPostgres(opts: MigrateOptions): Promise<number> {
  const log = opts.log ?? console.log;
  const { source } = opts;
  let target: DbClient | undefined;

  try {
    const sourceCounts = await countAll(source);
    const total = [...sourceCounts.values()].reduce((a, b) => a + b, 0);

    if (opts.dryRun) {
      log("Dry run — source row counts (target not contacted):");
      for (const line of table([["Model", "Source"], ...MIGRATION_MODELS.map((m) => [m.model, String(sourceCounts.get(m.model))])])) {
        log(`  ${line}`);
      }
      log(`  ${total} rows across ${MIGRATION_MODELS.length} models would be copied.`);
      return 0;
    }

    target = opts.connectTarget();
    const before = await countAll(target);
    const occupied = MIGRATION_MODELS.filter((m) => (before.get(m.model) ?? 0) > 0);
    if (occupied.length > 0 && !opts.force) {
      log("REFUSING: the target Postgres database is not empty:");
      for (const m of occupied) log(`  ${m.model}: ${before.get(m.model)} rows`);
      log("Nothing was written. Point POSTGRES_URL at an empty, migrated database, or pass --force.");
      log(SOURCE_UNTOUCHED);
      return 1;
    }
    if (occupied.length > 0) log(`--force: target already has rows in ${occupied.length} model(s); copying alongside them.`);

    log(`Copying ${total} rows across ${MIGRATION_MODELS.length} models (batches of ${BATCH_SIZE})...`);
    const src = source;
    let copied: Map<string, number>;
    try {
      copied = await target.$transaction((tx) => copyAll(src, tx, log), TRANSACTION_OPTIONS);
    } catch (err) {
      log(`COPY FAILED — the target transaction was rolled back: ${err instanceof Error ? err.message : String(err)}`);
      log(SOURCE_UNTOUCHED);
      return 1;
    }

    // Verification: every model is re-counted on both sides after commit.
    const finalSource = await countAll(source);
    const after = await countAll(target);
    const bad = await verifyContent(source, target);

    const rows: string[][] = [["Model", "Source", "Copied", "Target", "Content", "Status"]];
    const failures: string[] = [];
    for (const m of MIGRATION_MODELS) {
      const s = finalSource.get(m.model) ?? 0;
      const c = copied.get(m.model) ?? 0;
      const t = (after.get(m.model) ?? 0) - (before.get(m.model) ?? 0);
      const b = bad.get(m.model) ?? 0;
      const countsOk = s === sourceCounts.get(m.model) && c === s && t === s;
      const ok = countsOk && b === 0;
      if (!countsOk) {
        failures.push(
          `${m.model}: expected ${sourceCounts.get(m.model)} (source now ${s}), copied ${c}, found ${t} on target`,
        );
      }
      if (b > 0) failures.push(`${m.model}: ${b} row(s) missing or different on target`);
      rows.push([m.model, String(s), String(c), String(t), b === 0 ? "identical" : `${b} differ`, ok ? "OK" : "MISMATCH"]);
    }
    for (const line of table(rows)) log(`  ${line}`);

    if (failures.length > 0) {
      log(`MISMATCH — ${failures.length} model(s) failed verification:`);
      for (const f of failures) log(`  ${f}`);
      log(SOURCE_UNTOUCHED);
      return 1;
    }
    log(`VERIFIED: all ${MIGRATION_MODELS.length} models match (${total} rows). ${SOURCE_UNTOUCHED}`);
    return 0;
  } catch (err) {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    log(SOURCE_UNTOUCHED);
    return 1;
  } finally {
    await Promise.allSettled([source.$disconnect(), target?.$disconnect()]);
  }
}
