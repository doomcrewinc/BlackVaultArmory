import { describe, expect, it } from "vitest";
import {
  DATE_ONLY_FIELDS,
  isValidTimeZone,
  normalizeInstant,
  runLegacyDateMigration,
} from "./date-migration";

const iso = (d: Date) => d.toISOString();

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

function fakePrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { dateNormalizationAudit: [], ...seed };
  let nextId = 1;
  const delegate = (name: string) => {
    tables[name] ??= [];
    return {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        tables[name].filter((r) =>
          Object.entries(args?.where ?? {}).every(([k, v]) => r[k] === v)
        ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tables[name].find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `audit-${nextId++}`, ...data } as Row;
        tables[name].push(row);
        return row;
      },
    };
  };
  const client: Record<string, unknown> = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
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
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe("user-edited");
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
});
