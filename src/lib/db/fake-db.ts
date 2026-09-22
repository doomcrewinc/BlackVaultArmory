/**
 * In-memory Prisma stand-ins for the migrator tests. Test-only: nothing in the
 * app imports this file.
 */
import { MIGRATION_MODELS, type DbClient, type FindManyArgs, type Row } from "./sqlite-to-postgres";

/** In-memory stand-in for one Prisma model delegate. */
export class FakeDelegate {
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

export class FakeClient {
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

export function seeded(): FakeClient {
  const c = new FakeClient();
  for (const m of MIGRATION_MODELS) {
    c.delegates[m.delegate].rows = [
      { id: `${m.delegate}-1`, createdAt: new Date("2024-03-01T00:00:00.000Z"), name: "a" },
      { id: `${m.delegate}-2`, createdAt: new Date("2024-03-02T06:00:00.123Z"), name: null },
    ];
  }
  return c;
}
