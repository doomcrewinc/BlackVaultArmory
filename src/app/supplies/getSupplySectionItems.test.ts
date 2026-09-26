import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IS_PINNED_HOST_ZONE } from "@/test/host-timezone";
import { expiryStatus } from "@/lib/supply";

const mocks = vi.hoisted(() => ({
  findAppSettings: vi.fn(),
  findSupplies: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findAppSettings },
    supply: { findMany: mocks.findSupplies },
  },
}));

import { getSupplySectionItems } from "./getSupplySectionItems";

/**
 * 21:00 on June 15 in Denver is already 03:00 on June 16 in UTC, so `now`'s
 * own UTC calendar day is the 16th while the user's day is still the 15th.
 * Every assertion below hangs on that gap: a supply expiring on the 15th is
 * `soon` for the user and `expired` for the raw instant.
 */
const EVENING_IN_DENVER = new Date("2026-06-16T03:00:00.000Z");
const EXPIRES_TODAY_IN_DENVER = new Date("2026-06-15T00:00:00.000Z");

function supply(overrides: Record<string, unknown> = {}) {
  return {
    id: "supply-1",
    name: "Water Jug",
    brand: "Aquatainer",
    category: "WATER",
    quantity: 4,
    unit: "GAL",
    storageLocation: "Garage",
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

describe("getSupplySectionItems", () => {
  it("passes the caller's where straight through and orders by name", async () => {
    const where = { category: { in: ["WATER"] } };
    await getSupplySectionItems(where);
    expect(mocks.findSupplies).toHaveBeenCalledWith({
      where,
      orderBy: { name: "asc" },
    });
  });

  it("reads AppSettings once, for the whole page", async () => {
    mocks.findSupplies.mockResolvedValue([
      supply({ id: "a" }),
      supply({ id: "b" }),
      supply({ id: "c" }),
    ]);
    await getSupplySectionItems({});
    expect(mocks.findAppSettings).toHaveBeenCalledTimes(1);
    expect(mocks.findAppSettings).toHaveBeenCalledWith({
      where: { id: "singleton" },
    });
  });

  it("resolves expiry against the SETTINGS timezone's today, not the raw instant", async () => {
    // The regression this phase spent a fix round preventing: a caller
    // handing `new Date()` straight to expiryStatus. That caller returns
    // "expired" here, so this test fails if the helper is ever bypassed.
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: 90,
    });
    mocks.findSupplies.mockResolvedValue([
      supply({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);

    const { items } = await getSupplySectionItems({});

    expect(items[0].expiry).toBe("soon");
    // The negative control: the verdict a bypassed helper would produce.
    expect(expiryStatus(EXPIRES_TODAY_IN_DENVER, EVENING_IN_DENVER, 90)).toBe(
      "expired",
    );
  });

  it.skipIf(!IS_PINNED_HOST_ZONE)("resolves expiry against the host timezone when no timezone is saved", async () => {
    // AppSettings.timezone is NULL out of the box. The suite runs with
    // TZ=America/Denver, so the correct answer here is still the user's day.
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue(null);
    mocks.findSupplies.mockResolvedValue([
      supply({ expirationDate: EXPIRES_TODAY_IN_DENVER }),
    ]);

    const { items } = await getSupplySectionItems({});

    expect(items[0].expiry).toBe("soon");
  });

  it("honors the stored expiry warning window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(EVENING_IN_DENVER);
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: 5,
    });
    mocks.findSupplies.mockResolvedValue([
      // 30 days out: inside the 90-day default, outside a stored 5-day window.
      supply({ expirationDate: new Date("2026-07-15T00:00:00.000Z") }),
    ]);

    const { items } = await getSupplySectionItems({});

    expect(items[0].expiry).toBe("fine");
  });

  it("resolves low stock per row and carries the category through", async () => {
    mocks.findSupplies.mockResolvedValue([
      supply({ id: "low", quantity: 1, lowStockAlert: 5, category: "BATTERY" }),
      supply({ id: "ok", quantity: 9, lowStockAlert: 5 }),
    ]);

    const { items } = await getSupplySectionItems({});

    expect(items.map((item) => [item.id, item.isLow])).toEqual([
      ["low", true],
      ["ok", false],
    ]);
    // The list page badges this; a BATTERY row in the Food & Water catch-all
    // is only honest if the category survives the mapping.
    expect(items[0].category).toBe("BATTERY");
  });

  it("reports the timezone as unconfigured when AppSettings has none", async () => {
    // What the list page's expiry-timezone notice is driven by: the verdicts
    // above were resolved in the host's zone, and the page has to say so.
    mocks.findAppSettings.mockResolvedValue(null);
    mocks.findSupplies.mockResolvedValue([supply()]);

    const result = await getSupplySectionItems({});

    expect(result.timezoneConfigured).toBe(false);
  });

  it("reports the timezone as unconfigured when it is stored blank", async () => {
    mocks.findAppSettings.mockResolvedValue({
      timezone: "",
      expiryWarningDays: null,
    });

    const result = await getSupplySectionItems({});

    expect(result.timezoneConfigured).toBe(false);
  });

  it("reports the timezone as configured once one is saved", async () => {
    mocks.findAppSettings.mockResolvedValue({
      timezone: "America/Denver",
      expiryWarningDays: null,
    });

    const result = await getSupplySectionItems({});

    expect(result.timezoneConfigured).toBe(true);
  });

  it("reports the flag from the SAME AppSettings read that resolved the verdicts", async () => {
    // The flag and the verdicts it describes cannot drift, because the page
    // does not re-read AppSettings for it — one query serves both.
    mocks.findAppSettings.mockResolvedValue(null);
    mocks.findSupplies.mockResolvedValue([supply()]);

    await getSupplySectionItems({});

    expect(mocks.findAppSettings).toHaveBeenCalledTimes(1);
  });
});
