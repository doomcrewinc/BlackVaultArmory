import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_MODELS } from "@/lib/backup/models";

const mocks = vi.hoisted(() => ({
  findManyCalls: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  settingsFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", async () => {
  const { BACKUP_MODELS: models } = await vi.importActual<typeof import("@/lib/backup/models")>(
    "@/lib/backup/models"
  );
  const prisma: Record<string, unknown> = {
    appSettings: { findUnique: mocks.settingsFindUnique },
  };
  for (const m of models) {
    prisma[m.delegate] = {
      findMany: vi.fn(async () => {
        mocks.findManyCalls.push(m.delegate);
        mocks.inFlight += 1;
        mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
        await new Promise((r) => setTimeout(r, 1));
        mocks.inFlight -= 1;
        return [{ id: `${m.delegate}-1` }];
      }),
    };
  }
  return { prisma };
});

import { POST } from "./route";

describe("POST /api/backup", () => {
  beforeEach(() => {
    mocks.findManyCalls.length = 0;
    mocks.inFlight = 0;
    mocks.maxInFlight = 0;
    mocks.settingsFindUnique.mockResolvedValue({ includeUploadsInBackup: true, backupDestinationPath: null });
  });

  it("exports every registered model, including the ones restore used to destroy", async () => {
    const response = await POST();
    const json = await response.json();

    expect(response.status).toBe(200);
    for (const { key, delegate } of BACKUP_MODELS) {
      expect(json.data[key], key).toEqual([{ id: `${delegate}-1` }]);
    }
    expect(json.data.maintenanceLogs).toHaveLength(1);
    expect(json.data.batteryChangeLogs).toHaveLength(1);
    expect(json.data.dateNormalizationAudits).toHaveLength(1);
    expect(Object.keys(json.data).sort()).toEqual(BACKUP_MODELS.map((m) => m.key).sort());
  });

  it("stamps version 1.1 and counts every key", async () => {
    const json = await (await POST()).json();

    expect(json.meta.version).toBe("1.1");
    expect(Object.keys(json.meta.counts).sort()).toEqual(BACKUP_MODELS.map((m) => m.key).sort());
    for (const { key } of BACKUP_MODELS) expect(json.meta.counts[key]).toBe(1);
  });

  it("queries sequentially, never concurrently (SQLite connection_limit=1)", async () => {
    await POST();

    expect(mocks.findManyCalls).toHaveLength(BACKUP_MODELS.length);
    expect(mocks.maxInFlight).toBe(1);
  });

  it("never exports AppSettings", async () => {
    const json = await (await POST()).json();
    expect(json.data.appSettings).toBeUndefined();
    expect(json.data.settings).toBeUndefined();
  });
});
