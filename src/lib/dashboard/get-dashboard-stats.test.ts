import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findAppSettings: vi.fn(),
  findSupplies: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findAppSettings },
    supply: { findMany: mocks.findSupplies },
    firearm: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    accessory: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ammoStock: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { getDashboardStats } from "./get-dashboard-stats";

function supply(overrides: Record<string, unknown> = {}) {
  return {
    id: "supply-1",
    name: "Water Jug",
    category: "WATER",
    quantity: 1,
    unit: "GAL",
    lowStockAlert: null,
    expirationDate: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.findAppSettings.mockReset().mockResolvedValue(null);
  mocks.findSupplies.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getDashboardStats — supply timezone reporting", () => {
  it("reports the timezone as unconfigured when AppSettings has none", async () => {
    // The default state of a fresh install: NULL. The dashboard needs to know,
    // because the expiry counts below were then resolved in the SERVER's zone.
    const stats = await getDashboardStats();
    expect(stats.supplies.timezoneConfigured).toBe(false);
  });

  it("reports the timezone as unconfigured when it is stored blank", async () => {
    mocks.findAppSettings.mockResolvedValue({
      timezone: "",
      expiryWarningDays: null,
    });
    const stats = await getDashboardStats();
    expect(stats.supplies.timezoneConfigured).toBe(false);
  });

  it("reports the timezone as configured once one is saved", async () => {
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: null,
    });
    const stats = await getDashboardStats();
    expect(stats.supplies.timezoneConfigured).toBe(true);
  });
});

describe("getDashboardStats — supply counts", () => {
  it("counts low stock, expired and expiring-soon separately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({
      timezone: "UTC",
      expiryWarningDays: 10,
    });
    mocks.findSupplies.mockResolvedValue([
      supply({ id: "low", quantity: 1, lowStockAlert: 5 }),
      supply({
        id: "expired",
        expirationDate: new Date("2026-06-14T00:00:00.000Z"),
      }),
      supply({
        id: "soon",
        expirationDate: new Date("2026-06-20T00:00:00.000Z"),
      }),
      supply({
        id: "fine",
        expirationDate: new Date("2026-12-01T00:00:00.000Z"),
      }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.supplies.lowStockCount).toBe(1);
    expect(stats.supplies.lowStockItems.map((item) => item.id)).toEqual([
      "low",
    ]);
    expect(stats.supplies.expiredCount).toBe(1);
    expect(stats.supplies.expiringSoonCount).toBe(1);
  });
});
