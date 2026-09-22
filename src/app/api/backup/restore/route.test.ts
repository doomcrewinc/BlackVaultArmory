import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BACKUP_MODELS } from "@/lib/backup/models";

type Call = { op: "deleteMany" | "createMany"; delegate: string; data?: unknown[] };

const mocks = vi.hoisted(() => ({
  calls: [] as Call[],
  transaction: vi.fn(),
  runConfiguredDateMigration: vi.fn(),
  appSettings: { deleteMany: vi.fn(), createMany: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));

vi.mock("@/lib/date-migration", () => ({
  runConfiguredDateMigration: mocks.runConfiguredDateMigration,
}));

import { POST } from "./route";

function makeTx() {
  const tx: Record<string, unknown> = { appSettings: mocks.appSettings };
  for (const { delegate } of BACKUP_MODELS) {
    tx[delegate] = {
      deleteMany: vi.fn(async () => {
        mocks.calls.push({ op: "deleteMany", delegate });
        return { count: 0 };
      }),
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => {
        mocks.calls.push({ op: "createMany", delegate, data });
        return { count: data.length };
      }),
    };
  }
  return tx;
}

function restoreRequest(body: unknown) {
  return new NextRequest("http://localhost/api/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const V1_0_KEYS = [
  "firearms", "builds", "buildSlots", "accessories", "documents", "roundCountLogs",
  "ammoStocks", "ammoTransactions", "rangeSessions", "rangeSessionAmmoLinks", "sessionDrills", "imageCache",
];

function v11Payload() {
  return {
    meta: { version: "1.1" },
    ...Object.fromEntries(BACKUP_MODELS.map(({ key }) => [key, [{ id: `${key}-1` }]])),
  };
}

const created = (delegate: string) =>
  mocks.calls.find((c) => c.op === "createMany" && c.delegate === delegate)?.data;

describe("POST /api/backup/restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()));
    mocks.runConfiguredDateMigration.mockResolvedValue(undefined);
  });

  it("restores maintenance, battery, and date-audit rows from a v1.1 payload", async () => {
    const response = await POST(restoreRequest(v11Payload()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(created("maintenanceLog")).toEqual([{ id: "maintenanceLogs-1" }]);
    expect(created("batteryChangeLog")).toEqual([{ id: "batteryChangeLogs-1" }]);
    expect(created("dateNormalizationAudit")).toEqual([{ id: "dateNormalizationAudits-1" }]);
    for (const { key } of BACKUP_MODELS) expect(json.counts[key], key).toBe(1);
  });

  it("accepts a v1.0 payload that lacks the new keys, treating them as empty", async () => {
    const payload = {
      meta: { version: "1.0" },
      ...Object.fromEntries(V1_0_KEYS.map((key) => [key, [{ id: `${key}-1` }]])),
    };

    const response = await POST(restoreRequest(payload));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(created("firearm")).toEqual([{ id: "firearms-1" }]);
    expect(created("maintenanceLog")).toBeUndefined();
    expect(json.counts.maintenanceLogs).toBe(0);
    expect(json.counts.batteryChangeLogs).toBe(0);
    expect(json.counts.dateNormalizationAudits).toBe(0);
  });

  it("rejects a payload with no meta.version", async () => {
    const { meta: _meta, ...noMeta } = v11Payload();
    void _meta;

    const response = await POST(restoreRequest(noMeta));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a payload where a known key is not an array", async () => {
    const response = await POST(restoreRequest({ ...v11Payload(), maintenanceLogs: "nope" }));

    expect(response.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("deletes children before parents, then inserts parents before children", async () => {
    await POST(restoreRequest(v11Payload()));

    const deletes = mocks.calls.filter((c) => c.op === "deleteMany").map((c) => c.delegate);
    const inserts = mocks.calls.filter((c) => c.op === "createMany").map((c) => c.delegate);
    const order = BACKUP_MODELS.map((m) => m.delegate);

    expect(deletes).toEqual([...order].reverse());
    expect(inserts).toEqual(order);
    expect(mocks.calls.findIndex((c) => c.op === "createMany")).toBe(order.length);
    expect(deletes.indexOf("maintenanceLog")).toBeLessThan(deletes.indexOf("firearm"));
    expect(deletes.indexOf("batteryChangeLog")).toBeLessThan(deletes.indexOf("accessory"));
  });

  it("never touches AppSettings", async () => {
    await POST(restoreRequest({ ...v11Payload(), appSettings: [{ id: "singleton" }] }));

    for (const fn of Object.values(mocks.appSettings)) expect(fn).not.toHaveBeenCalled();
  });

  it("runs the post-restore date migration after a successful restore", async () => {
    await POST(restoreRequest(v11Payload()));

    expect(mocks.runConfiguredDateMigration).toHaveBeenCalledTimes(1);
    expect(mocks.runConfiguredDateMigration).toHaveBeenCalledWith("restore");
  });

  it("still reports success when the post-restore migration throws", async () => {
    mocks.runConfiguredDateMigration.mockRejectedValue(new Error("migration boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(restoreRequest(v11Payload()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.error).toBeUndefined();
    spy.mockRestore();
  });

  it("reports 'not modified' and skips the migration when the transaction fails", async () => {
    mocks.transaction.mockRejectedValue(new Error("tx boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(restoreRequest(v11Payload()));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toMatch(/has not been modified/);
    expect(mocks.runConfiguredDateMigration).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
