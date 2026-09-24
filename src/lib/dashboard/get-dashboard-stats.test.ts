import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expiryStatus } from "@/lib/supply";

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

/**
 * 21:00 on June 15 in Denver is already 03:00 on June 16 in UTC, so `now`'s
 * own UTC calendar day is the 16th while the user's day is still the 15th.
 * A supply expiring on the 15th is `soon` for the user and `expired` for the
 * raw instant — which is what makes the boundary tests below able to fail.
 */
const EVENING_IN_DENVER = new Date("2026-06-16T03:00:00.000Z");
const EXPIRES_TODAY_IN_DENVER = new Date("2026-06-15T00:00:00.000Z");

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

describe("getDashboardStats — the expiry timezone boundary", () => {
  it("resolves today from the SETTINGS timezone, not the raw instant", async () => {
    // expiredCount and expiringSoonCount are the numbers the user reads
    // first. A caller handing `new Date()` straight to expiryStatus — the
    // regression this phase spent a fix round preventing — would report
    // expired: 1, soon: 0 here. Nothing else in the suite covered this path.
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: 90,
    });
    mocks.findSupplies.mockResolvedValue([
      supply({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.supplies.expiringSoonCount).toBe(1);
    expect(stats.supplies.expiredCount).toBe(0);
    // The negative control: the verdict a bypassed helper would produce.
    expect(expiryStatus(EXPIRES_TODAY_IN_DENVER, EVENING_IN_DENVER, 90)).toBe(
      "expired",
    );
  });

  it("resolves today from the host timezone when no timezone is saved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue(null);
    mocks.findSupplies.mockResolvedValue([
      supply({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.supplies.expiringSoonCount).toBe(1);
    expect(stats.supplies.expiredCount).toBe(0);
  });
});
