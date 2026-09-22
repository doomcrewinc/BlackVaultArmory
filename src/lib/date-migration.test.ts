import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DATE_ONLY_FIELDS,
  isValidTimeZone,
  normalizeInstant,
  runLegacyDateMigration,
  runStartupDateMigration,
  USER_EDITED,
} from "./date-migration";

const iso = (d: Date) => d.toISOString();

// runStartupDateMigration imports the real client; tests swap in a fake.
const mockPrisma = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return mockPrisma.current;
  },
}));

describe("isValidTimeZone", () => {
  it("accepts IANA zones", () => {
    expect(isValidTimeZone("America/Denver")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("normalizeInstant", () => {
  const instant = new Date("2026-09-21T01:30:00.000Z");

  it("uses the calendar day in the given zone", () => {
    expect(iso(normalizeInstant(instant, "America/Denver"))).toBe("2026-09-20T00:00:00.000Z");
    expect(iso(normalizeInstant(instant, "UTC"))).toBe("2026-09-21T00:00:00.000Z");
    expect(iso(normalizeInstant(instant, "Pacific/Auckland"))).toBe("2026-09-21T00:00:00.000Z");
  });

  it("handles a DST transition day", () => {
    // US DST ended 2026-11-01 at 02:00 local. 07:30Z that day is 00:30 MST / 01:30 MDT.
    expect(iso(normalizeInstant(new Date("2026-11-01T07:30:00.000Z"), "America/Denver"))).toBe(
      "2026-11-01T00:00:00.000Z"
    );
  });

  it("keeps years below 100 out of the 1900s", () => {
    expect(iso(normalizeInstant(new Date("0050-03-04T05:00:00.000Z"), "UTC"))).toBe(
      "0050-03-04T00:00:00.000Z"
    );
  });

  it("always returns exact UTC midnight", () => {
    expect(normalizeInstant(instant, "America/Denver").getTime() % 86_400_000).toBe(0);
  });
});

describe("DATE_ONLY_FIELDS", () => {
  it("covers all ten date-only fields", () => {
    expect(DATE_ONLY_FIELDS.map((f) => `${f.model}.${f.field}`).sort()).toEqual(
      [
        "Accessory.acquisitionDate",
        "Accessory.lastBatteryChangeDate",
        "AmmoStock.purchaseDate",
        "AmmoTransaction.purchaseDate",
        "BatteryChangeLog.changedAt",
        "Firearm.acquisitionDate",
        "Firearm.lastMaintenanceDate",
        "MaintenanceLog.date",
        "RangeSession.sessionDate",
        "SessionDrill.drillDate",
      ].sort()
    );
  });
});

// ── in-memory fake ───────────────────────────────────────────
type Row = Record<string, unknown> & { id: string };

/**
 * Called on every row write before its `where` is checked, so a test can make
 * the row change under the migration (a concurrent edit) or make a write throw.
 */
type OnWrite = (table: string, id: string, row: Row | undefined) => void;

const sameValue = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

function fakePrisma(seed: Record<string, Row[]>, onWrite: OnWrite = () => {}) {
  const tables: Record<string, Row[]> = { dateNormalizationAudit: [], ...seed };
  let nextId = 1;
  const delegate = (name: string) => {
    tables[name] ??= [];
    return {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        tables[name]
          .filter((r) => Object.entries(args?.where ?? {}).every(([k, v]) => sameValue(r[k], v)))
          .map((r) => ({ ...r })), // a snapshot, as a real query returns
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tables[name].find((r) => r.id === where.id);
        onWrite(name, where.id, row);
        if (!row) throw new Error(`${name} ${where.id} not found`);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown> & { id: string };
        data: Record<string, unknown>;
      }) => {
        onWrite(name, where.id, tables[name].find((r) => r.id === where.id));
        const hits = tables[name].filter((r) =>
          Object.entries(where).every(([k, v]) => sameValue(r[k], v))
        );
        for (const row of hits) Object.assign(row, data);
        return { count: hits.length };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `audit-${nextId++}`, ...data } as Row;
        tables[name].push(row);
        return row;
      },
    };
  };
  const client: Record<string, unknown> = {
    // Interactive form only: the migration must read its writes' counts inside
    // the transaction. The array form would throw here.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  for (const f of DATE_ONLY_FIELDS) client[f.delegate] = delegate(f.delegate);
  client.dateNormalizationAudit = delegate("dateNormalizationAudit");
  return { client: client as never, tables };
}

const LEGACY = new Date("2026-09-21T01:30:00.000Z"); // written 7:30pm Sep 20 in Denver
const MIDNIGHT = new Date("2026-09-20T00:00:00.000Z"); // written from a date picker

describe("runLegacyDateMigration", () => {
  it("normalizes a legacy row and audits its original", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    const summary = await runLegacyDateMigration(client, "UTC");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-09-21T00:00:00.000Z");
    expect(tables.dateNormalizationAudit).toHaveLength(1);
    expect(iso(tables.dateNormalizationAudit[0].originalValue as Date)).toBe(iso(LEGACY));
    expect(summary.normalized).toBe(1);
  });

  it("never touches or audits a value already at UTC midnight", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: MIDNIGHT }] });
    const summary = await runLegacyDateMigration(client, "UTC");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(MIDNIGHT));
    expect(tables.dateNormalizationAudit).toHaveLength(0);
    expect(summary.normalized).toBe(0);
  });

  it("skips null values", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", lastMaintenanceDate: null }] });
    await runLegacyDateMigration(client, "UTC");
    expect(tables.dateNormalizationAudit).toHaveLength(0);
  });

  it("is idempotent for the same zone", async () => {
    const { client } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const second = await runLegacyDateMigration(client, "UTC");
    expect(second).toMatchObject({ normalized: 0, reconverted: 0, skippedEdited: 0 });
  });

  it("re-converts from the original when the zone changes", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const summary = await runLegacyDateMigration(client, "America/Denver");

    // 01:30Z on the 21st is 7:30pm on the 20th in Denver
    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-09-20T00:00:00.000Z");
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe("America/Denver");
    expect(summary.reconverted).toBe(1);
  });

  it("never overwrites a date the user edited after migration", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const edited = new Date("2026-08-01T00:00:00.000Z");
    tables.firearm[0].acquisitionDate = edited; // the user changed it

    const summary = await runLegacyDateMigration(client, "America/Denver");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(edited));
    expect(summary).toMatchObject({ reconverted: 0, skippedEdited: 1 });
  });

  it("releases an edited row so later runs skip it silently", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    tables.firearm[0].acquisitionDate = new Date("2026-08-01T00:00:00.000Z");

    const first = await runLegacyDateMigration(client, "America/Denver");
    const second = await runLegacyDateMigration(client, "America/Denver");

    expect(first.skippedEdited).toBe(1);
    expect(second).toMatchObject({ normalized: 0, reconverted: 0, skippedEdited: 0 });
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe(USER_EDITED);
  });

  it("never re-converts a released row, even if edited back to the migrated value", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const migrated = tables.firearm[0].acquisitionDate as Date;

    tables.firearm[0].acquisitionDate = new Date("2026-08-01T00:00:00.000Z");
    await runLegacyDateMigration(client, "America/Denver"); // detects the edit, releases the row

    tables.firearm[0].acquisitionDate = migrated; // user edits it back to exactly what we wrote
    const summary = await runLegacyDateMigration(client, "Pacific/Auckland");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(migrated));
    expect(summary.reconverted).toBe(0);
  });

  it("re-normalizes a legacy value restored under an existing audit (same zone)", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "America/Denver");
    const restored = new Date("2026-06-10T22:15:00.000Z"); // a pre-upgrade backup's value
    tables.firearm[0].acquisitionDate = restored;

    const summary = await runLegacyDateMigration(client, "America/Denver");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-06-10T00:00:00.000Z");
    expect(summary).toMatchObject({ normalized: 1, reconverted: 0, skippedEdited: 0 });
    expect(tables.dateNormalizationAudit).toHaveLength(1);
    expect(tables.dateNormalizationAudit[0]).toMatchObject({ appliedZone: "America/Denver" });
    expect(iso(tables.dateNormalizationAudit[0].originalValue as Date)).toBe(iso(restored));
    expect(iso(tables.dateNormalizationAudit[0].appliedValue as Date)).toBe(
      "2026-06-10T00:00:00.000Z"
    );
  });

  it("reclaims and normalizes a legacy value restored onto a released row (new zone)", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    tables.firearm[0].acquisitionDate = new Date("2026-08-01T00:00:00.000Z");
    await runLegacyDateMigration(client, "UTC"); // same zone: nothing yet
    await runLegacyDateMigration(client, "America/Denver"); // detects the edit, releases
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe(USER_EDITED);

    tables.firearm[0].acquisitionDate = LEGACY; // restore brings back the legacy instant
    const summary = await runLegacyDateMigration(client, "Pacific/Auckland");

    // 01:30Z on the 21st is 1:30pm on the 21st in Auckland
    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-09-21T00:00:00.000Z");
    expect(summary).toMatchObject({ normalized: 1, reconverted: 0, skippedEdited: 0 });
    expect(tables.dateNormalizationAudit).toHaveLength(1);
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe("Pacific/Auckland");
    expect(iso(tables.dateNormalizationAudit[0].originalValue as Date)).toBe(iso(LEGACY));
  });

  it("never overwrites a concurrent edit on first-time normalization", async () => {
    const edit = new Date("2026-08-01T00:00:00.000Z");
    const { client, tables } = fakePrisma(
      { firearm: [{ id: "f1", acquisitionDate: LEGACY }] },
      (table, _id, row) => {
        if (table === "firearm" && row) row.acquisitionDate = edit; // another device saves
      }
    );
    const summary = await runLegacyDateMigration(client, "UTC");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(edit));
    expect(tables.dateNormalizationAudit).toHaveLength(0);
    expect(summary).toMatchObject({ normalized: 0, skippedConcurrent: 1 });
  });

  it("never overwrites a concurrent edit during re-conversion", async () => {
    const edit = new Date("2026-08-01T00:00:00.000Z");
    let editing = false;
    const { client, tables } = fakePrisma(
      { firearm: [{ id: "f1", acquisitionDate: LEGACY }] },
      (table, _id, row) => {
        if (editing && table === "firearm" && row) row.acquisitionDate = edit;
      }
    );
    await runLegacyDateMigration(client, "UTC");
    editing = true;
    const summary = await runLegacyDateMigration(client, "America/Denver");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(edit));
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe("UTC"); // audit untouched
    expect(summary).toMatchObject({ reconverted: 0, skippedConcurrent: 1 });
  });

  it("isolates a failing row and keeps processing the rest", async () => {
    const { client, tables } = fakePrisma(
      {
        firearm: [
          { id: "f1", acquisitionDate: LEGACY },
          { id: "f2", acquisitionDate: LEGACY },
        ],
      },
      (table, id) => {
        if (table === "firearm" && id === "f1") throw new Error("disk I/O error");
      }
    );
    const summary = await runLegacyDateMigration(client, "UTC");

    expect(summary).toMatchObject({ failed: 1, normalized: 1 });
    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(LEGACY));
    expect(iso(tables.firearm[1].acquisitionDate as Date)).toBe("2026-09-21T00:00:00.000Z");
    expect(tables.dateNormalizationAudit.map((a) => a.recordId)).toEqual(["f2"]);
  });
});

describe("runStartupDateMigration", () => {
  afterEach(() => vi.restoreAllMocks());

  const withSettings = (timezone: string | null) => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    (client as Record<string, unknown>).appSettings = {
      findUnique: async () => ({ id: "singleton", timezone }),
    };
    mockPrisma.current = client;
    return tables;
  };

  it("skips the run entirely when the configured zone is invalid", async () => {
    const tables = withSettings("Mars/Olympus_Mons");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runStartupDateMigration();

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(LEGACY));
    expect(tables.dateNormalizationAudit).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(
      '[date-migration] configured timezone "Mars/Olympus_Mons" is invalid; skipping migration'
    );
  });

  it("falls back to UTC only when no zone is set", async () => {
    const tables = withSettings(null);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runStartupDateMigration();

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-09-21T00:00:00.000Z");
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe("UTC");
  });
});
