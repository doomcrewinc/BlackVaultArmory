import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expiryStatus } from "@/lib/supply";

const mocks = vi.hoisted(() => ({
  findAppSettings: vi.fn(),
  findSupplies: vi.fn(),
  findGear: vi.fn(),
  findKits: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findAppSettings },
    supply: { findMany: mocks.findSupplies },
    gear: { findMany: mocks.findGear },
    kit: { findMany: mocks.findKits },
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

/** One KitItem line, as far as the dashboard rollup reads it. */
function kitLine(expirationDate: Date | null, source: "gear" | "supply" = "supply") {
  return {
    gear: source === "gear" ? { expirationDate } : null,
    supply: source === "supply" ? { expirationDate } : null,
  };
}

function kit(overrides: Record<string, unknown> = {}) {
  return {
    id: "kit-1",
    name: "Bugout Bag",
    category: "BUGOUT",
    items: [],
    ...overrides,
  };
}

function gear(overrides: Record<string, unknown> = {}) {
  return {
    id: "gear-1",
    name: "Front Plate",
    category: "ARMOR",
    expirationDate: null,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.findAppSettings.mockReset().mockResolvedValue(null);
  mocks.findSupplies.mockReset().mockResolvedValue([]);
  mocks.findGear.mockReset().mockResolvedValue([]);
  mocks.findKits.mockReset().mockResolvedValue([]);
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

describe("getDashboardStats — expiring gear", () => {
  it("returns expired and expiring-soon gear, and neither the fine nor the dateless", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({
      timezone: "UTC",
      expiryWarningDays: 10,
    });
    // The route narrows `expirationDate: { not: null }` in SQL, so a dateless
    // row never reaches the mapper — the `fine` row does, and must be dropped
    // there.
    mocks.findGear.mockResolvedValue([
      gear({
        id: "plate-expired",
        name: "Front Plate",
        expirationDate: new Date("2026-05-01T00:00:00.000Z"),
      }),
      gear({
        id: "filter-soon",
        name: "CBRN Filter",
        category: "CBRN",
        expirationDate: new Date("2026-06-20T00:00:00.000Z"),
      }),
      gear({
        id: "plate-fine",
        name: "Spare Plate",
        expirationDate: new Date("2027-06-01T00:00:00.000Z"),
      }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.gear.expiredCount).toBe(1);
    expect(stats.gear.expiringSoonCount).toBe(1);
    expect(stats.gear.expiringItems.map((item) => [item.id, item.expiry])).toEqual([
      ["plate-expired", "expired"],
      ["filter-soon", "soon"],
    ]);
    // The human label, as every other gear surface shows it — not the token.
    expect(stats.gear.expiringItems[0].category).toBe("Armor");
    expect(stats.gear.expiringItems[1].category).toBe("CBRN Protection");
  });

  it("asks the database only for gear that carries a date", async () => {
    await getDashboardStats();

    expect(mocks.findGear).toHaveBeenCalledTimes(1);
    expect(mocks.findGear.mock.calls[0][0].where).toEqual({
      expirationDate: { not: null },
    });
  });

  it("falls back to the raw category for one this build does not know", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
    mocks.findGear.mockResolvedValue([
      gear({ category: "EXOSUIT", expirationDate: new Date("2026-05-01T00:00:00.000Z") }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.gear.expiringItems[0].category).toBe("EXOSUIT");
  });

  it("judges gear against the SETTINGS timezone, the same day the supply counts used", async () => {
    // The same boundary the supply tests above pin, for gear: 21:00 on the
    // 15th in Denver is already the 16th in UTC, so a plate expiring on the
    // 15th is `soon` for the user and `expired` for the raw instant. A second
    // resolution of "today" for gear would put an expired plate in the list
    // beside a supply the same date called `soon`.
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: 90,
    });
    mocks.findSupplies.mockResolvedValue([
      supply({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);
    mocks.findGear.mockResolvedValue([
      gear({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.gear.expiringSoonCount).toBe(1);
    expect(stats.gear.expiredCount).toBe(0);
    // Both stores agree, which is the point of the single resolution.
    expect(stats.supplies.expiringSoonCount).toBe(1);
    // The negative control: the verdict a second, raw-instant resolution gives.
    expect(expiryStatus(EXPIRES_TODAY_IN_DENVER, EVENING_IN_DENVER, 90)).toBe(
      "expired",
    );
  });

  it("reads AppSettings exactly once for both stores", async () => {
    await getDashboardStats();
    expect(mocks.findAppSettings).toHaveBeenCalledTimes(1);
  });
});

describe("getDashboardStats — expiring kit contents", () => {
  it("returns the kits whose contents are expiring, and neither the fine nor the dateless", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({
      timezone: "UTC",
      expiryWarningDays: 10,
    });
    mocks.findKits.mockResolvedValue([
      kit({
        id: "kit-expired",
        name: "Vehicle Kit",
        category: "VEHICLE",
        items: [
          kitLine(new Date("2026-05-01T00:00:00.000Z")),
          kitLine(new Date("2026-06-18T00:00:00.000Z")),
        ],
      }),
      kit({
        id: "kit-soon",
        name: "Range Bag",
        category: "RANGE",
        items: [kitLine(new Date("2026-06-20T00:00:00.000Z"), "gear")],
      }),
      kit({
        id: "kit-fine",
        name: "Home Kit",
        category: "HOME",
        items: [kitLine(new Date("2027-06-01T00:00:00.000Z"))],
      }),
      kit({
        // A kit whose only line is a firearm, an accessory, an ammo lot or a
        // bare label has no expiry at all. The SQL `where` keeps most of these
        // out; one that slips through (a kit holding both a dated pouch and an
        // undated optic) must still be judged on its dated lines only.
        id: "kit-undated",
        name: "Optics Case",
        items: [kitLine(null), kitLine(null, "gear")],
      }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.kits.expiredCount).toBe(1);
    expect(stats.kits.expiringSoonCount).toBe(1);
    expect(stats.kits.expiringItems.map((item) => [item.id, item.expiry])).toEqual([
      ["kit-expired", "expired"],
      ["kit-soon", "soon"],
    ]);
    // The human label, as every other kit surface shows it — not the token.
    expect(stats.kits.expiringItems[0].category).toBe("Vehicle");
    expect(stats.kits.expiringItems[1].category).toBe("Range");
    // The EARLIEST dated line, not the one that decided the verdict.
    expect(stats.kits.expiringItems[0].expirationDate).toEqual(
      new Date("2026-05-01T00:00:00.000Z"),
    );
    // Worst verdict wins and the count is that verdict's lines: the vehicle
    // kit has one expired pouch and one expiring one, and reads "1 expired".
    expect(stats.kits.expiringItems[0].lineCount).toBe(1);
  });

  it("counts KITS, not the lines inside them", async () => {
    // Four expired pouches in one bag is ONE thing to go and deal with, and
    // the four pouches are already counted in stats.supplies. Counting them
    // twice would make the widget headline larger than the number of problems.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
    mocks.findKits.mockResolvedValue([
      kit({
        items: [
          kitLine(new Date("2026-05-01T00:00:00.000Z")),
          kitLine(new Date("2026-05-02T00:00:00.000Z")),
          kitLine(new Date("2026-05-03T00:00:00.000Z")),
          kitLine(new Date("2026-05-04T00:00:00.000Z")),
        ],
      }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.kits.expiredCount).toBe(1);
    expect(stats.kits.expiringItems).toHaveLength(1);
    // And the line count is carried, so the widget can still say "4 items
    // expired" on that one row.
    expect(stats.kits.expiringItems[0].lineCount).toBe(4);
  });

  it("asks the database only for kits that hold something with a date", async () => {
    await getDashboardStats();

    expect(mocks.findKits).toHaveBeenCalledTimes(1);
    expect(mocks.findKits.mock.calls[0][0].where).toEqual({
      items: {
        some: {
          OR: [
            { gear: { expirationDate: { not: null } } },
            { supply: { expirationDate: { not: null } } },
          ],
        },
      },
    });
  });

  it("selects nothing that could carry a serial off a kit's lines", async () => {
    // A kit line points at Firearm, Accessory and Gear rows, all three of
    // which carry a serialNumber. The dashboard needs dates and nothing else,
    // and a widened include here would ship serials to a client component.
    await getDashboardStats();

    const select = mocks.findKits.mock.calls[0][0].select;
    expect(select).toEqual({
      id: true,
      name: true,
      category: true,
      items: {
        select: {
          gear: { select: { expirationDate: true } },
          supply: { select: { expirationDate: true } },
        },
      },
    });
  });

  it("falls back to the raw category for one this build does not know", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
    mocks.findKits.mockResolvedValue([
      kit({
        category: "SCUBA",
        items: [kitLine(new Date("2026-05-01T00:00:00.000Z"))],
      }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.kits.expiringItems[0].category).toBe("SCUBA");
  });

  it("judges kits against the SETTINGS timezone, the same day the supply and gear counts used", async () => {
    // The same boundary the supply and gear tests above pin. A second
    // resolution of "today" for kits would put an expired bag on the board
    // beside a supply the same date called `soon` — and the bag and the pouch
    // are THE SAME POUCH.
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: 90,
    });
    mocks.findSupplies.mockResolvedValue([
      supply({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);
    mocks.findGear.mockResolvedValue([
      gear({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);
    mocks.findKits.mockResolvedValue([
      kit({ items: [kitLine(EXPIRES_TODAY_IN_DENVER)] }),
    ]);

    const stats = await getDashboardStats();

    expect(stats.kits.expiringSoonCount).toBe(1);
    expect(stats.kits.expiredCount).toBe(0);
    expect(stats.kits.expiringItems[0].expiry).toBe("soon");
    // All three stores agree, which is the point of the single resolution.
    expect(stats.supplies.expiringSoonCount).toBe(1);
    expect(stats.gear.expiringSoonCount).toBe(1);
    // ONE AppSettings read for all three.
    expect(mocks.findAppSettings).toHaveBeenCalledTimes(1);
    // The negative control: the verdict a second, raw-instant resolution gives.
    expect(expiryStatus(EXPIRES_TODAY_IN_DENVER, EVENING_IN_DENVER, 90)).toBe(
      "expired",
    );
  });
});
