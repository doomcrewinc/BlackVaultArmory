import { describe, expect, it, vi } from "vitest";
import {
  BATCH_SIZE,
  MIGRATION_MODELS,
  SOURCE_UNTOUCHED,
  migrateSqliteToPostgres,
  type DbClient,
  type FindManyArgs,
  type Row,
} from "./sqlite-to-postgres";
import { BACKUP_MODELS } from "../backup/models";

/** In-memory stand-in for one Prisma model delegate. */
class FakeDelegate {
  rows: Row[] = [];
  countShortBy = 0;
  /** Only applied outside a transaction: simulates the committed state drifting from what was verified. */
  countShortOutsideTx = 0;
  owner?: { inTx: boolean };
  createManyCalls: number[] = [];
  writeShortBy = 0;

  async count() {
    const outside = this.owner?.inTx ? 0 : this.countShortOutsideTx;
    return Math.max(0, this.rows.length - this.countShortBy - outside);
  }

  async findMany(args: FindManyArgs) {
    let rows = [...this.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (args.where) rows = rows.filter((r) => args.where!.id.in.includes(r.id));
    if (args.cursor) rows = rows.slice(rows.findIndex((r) => r.id === args.cursor!.id));
    if (args.skip) rows = rows.slice(args.skip);
    if (args.take !== undefined) rows = rows.slice(0, args.take);
    return rows.map((r) => ({ ...r }));
  }

  async createMany({ data }: { data: Row[] }) {
    this.createManyCalls.push(data.length);
    const kept = data.slice(0, data.length - this.writeShortBy);
    this.rows.push(...kept.map((r) => ({ ...r })));
    return { count: kept.length };
  }
}

class FakeClient {
  disconnected = false;
  inTx = false;
  delegates: Record<string, FakeDelegate> = {};
  order: string[] = [];

  constructor() {
    for (const m of MIGRATION_MODELS) {
      const d = new FakeDelegate();
      d.owner = this;
      const origCreate = d.createMany.bind(d);
      d.createMany = async (args) => {
        this.order.push(m.model);
        return origCreate(args);
      };
      this.delegates[m.delegate] = d;
      (this as unknown as Record<string, FakeDelegate>)[m.delegate] = d;
    }
  }

  async $disconnect() {
    this.disconnected = true;
  }

  /** Snapshot/rollback like a real transaction. */
  async $transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const snapshot = Object.fromEntries(Object.entries(this.delegates).map(([k, d]) => [k, [...d.rows]]));
    this.inTx = true;
    try {
      return await fn(this as unknown as DbClient);
    } catch (err) {
      // Discard every write made inside the callback, as a real rollback would.
      for (const [k, rows] of Object.entries(snapshot)) this.delegates[k].rows = rows;
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  asDb() {
    return this as unknown as DbClient;
  }
}

function seeded(): FakeClient {
  const c = new FakeClient();
  for (const m of MIGRATION_MODELS) {
    c.delegates[m.delegate].rows = [
      { id: `${m.delegate}-1`, createdAt: new Date("2024-03-01T00:00:00.000Z"), name: "a" },
      { id: `${m.delegate}-2`, createdAt: new Date("2024-03-02T06:00:00.123Z"), name: null },
    ];
  }
  return c;
}

async function run(source: FakeClient, target: FakeClient, extra: { dryRun?: boolean; force?: boolean } = {}) {
  const lines: string[] = [];
  const connectTarget = vi.fn(() => target.asDb());
  const code = await migrateSqliteToPostgres({
    source: source.asDb(),
    connectTarget,
    dryRun: extra.dryRun ?? false,
    force: extra.force ?? false,
    log: (l) => lines.push(l),
  });
  return { code, lines, out: lines.join("\n"), connectTarget };
}

describe("MIGRATION_MODELS", () => {
  it("is AppSettings followed by every backup model, in registry order (16 total)", () => {
    expect(MIGRATION_MODELS.map((m) => m.model)).toEqual(["AppSettings", ...BACKUP_MODELS.map((m) => m.model)]);
    expect(MIGRATION_MODELS).toHaveLength(16);
  });
});

describe("migrateSqliteToPostgres", () => {
  it("copies every model parent-first and verifies", async () => {
    const source = seeded();
    const target = new FakeClient();
    const { code, out } = await run(source, target);

    expect(code).toBe(0);
    expect(out).toContain("VERIFIED: all 16 models match");
    for (const m of MIGRATION_MODELS) {
      expect(target.delegates[m.delegate].rows).toEqual(source.delegates[m.delegate].rows);
    }
    expect([...new Set(target.order)]).toEqual(MIGRATION_MODELS.map((m) => m.model));
    expect(source.order).toEqual([]); // source never written
    expect(source.disconnected && target.disconnected).toBe(true);
  });

  it("dry run reports counts and never connects to the target", async () => {
    const source = seeded();
    const { code, out, connectTarget } = await run(source, new FakeClient(), { dryRun: true });
    expect(code).toBe(0);
    expect(connectTarget).not.toHaveBeenCalled();
    expect(out).toContain("32 rows across 16 models would be copied");
  });

  it("refuses a non-empty target without --force and writes nothing", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.dateNormalizationAudit.rows = [{ id: "existing" }];
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("REFUSING");
    expect(out).toContain("DateNormalizationAudit: 1 rows");
    expect(out).toContain(SOURCE_UNTOUCHED);
    expect(target.order).toEqual([]);
  });

  it("copies in batches of 500", async () => {
    const source = new FakeClient();
    source.delegates.firearm.rows = Array.from({ length: 1201 }, (_, i) => ({ id: `f${String(i).padStart(5, "0")}` }));
    const target = new FakeClient();
    const { code } = await run(source, target);

    expect(code).toBe(0);
    expect(BATCH_SIZE).toBe(500);
    expect(target.delegates.firearm.createManyCalls).toEqual([500, 500, 201]);
    expect(target.delegates.firearm.rows).toHaveLength(1201);
  });

  it("exits 1 with a mismatch message when a target count comes back short", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.batteryChangeLog.countShortBy = 1;
    const { code, out, lines } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("MISMATCH");
    expect(lines.some((l) => l.includes("BatteryChangeLog") && l.includes("expected 2") && l.includes("found 1"))).toBe(true);
    expect(out).toContain(SOURCE_UNTOUCHED);
    // The target must end as it started: a failed verification rolls the copy back.
    for (const m of MIGRATION_MODELS) expect(target.delegates[m.delegate].rows).toEqual([]);
    expect(out).toContain("rolled back");
    expect(target.disconnected).toBe(true);
  });

  it("exits 1 when a copied DateTime differs by even one millisecond", async () => {
    const source = seeded();
    const target = new FakeClient();
    const orig = target.delegates.firearm.createMany.bind(target.delegates.firearm);
    target.delegates.firearm.createMany = async ({ data }) =>
      orig({ data: data.map((r) => ({ ...r, createdAt: new Date((r.createdAt as Date).getTime() + 1) })) });
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("Firearm: 2 row(s) missing or different on target");
    // The target must end as it started: a failed verification rolls the copy back.
    for (const m of MIGRATION_MODELS) expect(target.delegates[m.delegate].rows).toEqual([]);
    expect(out).toContain("rolled back");
  });

  it("rolls the target back and exits 1 when a batch is written short", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.build.writeShortBy = 1;
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    // The target must end as it started: a failed verification rolls the copy back.
    for (const m of MIGRATION_MODELS) expect(target.delegates[m.delegate].rows).toEqual([]);
    expect(out).toContain("rolled back");
    expect(source.disconnected && target.disconnected).toBe(true);
  });

  it("exits 1 when the committed target no longer matches what was verified", async () => {
    const source = seeded();
    const target = new FakeClient();
    target.delegates.sessionDrill.countShortOutsideTx = 1;
    const { code, out } = await run(source, target);

    expect(code).toBe(1);
    expect(out).toContain("POST-COMMIT CHECK FAILED");
    expect(out).toContain("SessionDrill: verified 2, now 1");
  });

  it("disconnects both clients when the source fails", async () => {
    const source = seeded();
    source.delegates.appSettings.count = async () => {
      throw new Error("boom");
    };
    const target = new FakeClient();
    const { code, out } = await run(source, target);
    expect(code).toBe(1);
    expect(out).toContain("FAILED: boom");
    expect(source.disconnected).toBe(true);
  });
});
