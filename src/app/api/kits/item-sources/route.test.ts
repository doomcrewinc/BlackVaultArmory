import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(),
  findGear: vi.fn(),
  findSupplies: vi.fn(),
  findAccessories: vi.fn(),
  findAmmoStocks: vi.fn(),
  findFirearms: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.settings },
    gear: { findMany: mocks.findGear },
    supply: { findMany: mocks.findSupplies },
    accessory: { findMany: mocks.findAccessories },
    ammoStock: { findMany: mocks.findAmmoStocks },
    firearm: { findMany: mocks.findFirearms },
  },
}));

// The real helper, wrapped in a spy: the assertion is that the picker's
// queries go through it rather than a bare Prisma `contains`, which is the
// exact Postgres case-sensitivity bug containsInsensitive exists to prevent.
vi.mock("@/lib/db/text-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/text-search")>();
  return { ...actual, containsInsensitive: vi.fn(actual.containsInsensitive) };
});

import { GET } from "./route";
import { containsInsensitive } from "@/lib/db/text-search";
import { KIT_ITEM_SOURCES } from "@/lib/kit";
import { FIREARM_OWNED_QUANTITY } from "@/lib/kits/sourceDisplay";

function request(q: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/kits/item-sources?q=${encodeURIComponent(q)}`,
  );
}

describe("GET /api/kits/item-sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.mockResolvedValue({
      id: "singleton",
      timezone: "America/Chicago",
      expiryWarningDays: 30,
    });
    mocks.findGear.mockResolvedValue([]);
    mocks.findSupplies.mockResolvedValue([]);
    mocks.findAccessories.mockResolvedValue([]);
    mocks.findAmmoStocks.mockResolvedValue([]);
    mocks.findFirearms.mockResolvedValue([]);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns no groups and issues no query for a one-character query", async () => {
    const response = await GET(request("a"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ groups: [] });
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.findGear).not.toHaveBeenCalled();
    expect(mocks.findFirearms).not.toHaveBeenCalled();
  });

  it("searches case-insensitively through the shared helper", async () => {
    await GET(request("bugout"));

    expect(containsInsensitive).toHaveBeenCalledWith("bugout");
  });

  it("groups results in KIT_ITEM_SOURCES order and drops empty kinds", async () => {
    // Deliberately only the FIRST and LAST source kinds, so an ordering that
    // happened to follow query order would still be caught.
    mocks.findFirearms.mockResolvedValue([
      { id: "f1", name: "Scout", manufacturer: "Ruger", model: "Gunsite" },
    ]);
    mocks.findGear.mockResolvedValue([
      {
        id: "g1",
        name: "Bugout",
        manufacturer: "Benchmade",
        model: "535",
        quantity: 3,
        expirationDate: null,
      },
    ]);

    const response = await GET(request("scout"));
    const json = await response.json();

    expect(json.groups.map((g: { field: string }) => g.field)).toEqual([
      "gearId",
      "firearmId",
    ]);
    // The order the page's own content blocks use.
    expect(KIT_ITEM_SOURCES.indexOf("gearId")).toBeLessThan(
      KIT_ITEM_SOURCES.indexOf("firearmId"),
    );
    expect(json.groups[0].label).toBe("Gear");
    expect(json.groups[0].results[0]).toMatchObject({
      field: "gearId",
      id: "g1",
      name: "Bugout",
      detail: "Benchmade · 535",
      owned: 3,
      expiry: "none",
    });
  });

  it("reports a firearm as one owned, since the table has no quantity column", async () => {
    mocks.findFirearms.mockResolvedValue([
      { id: "f1", name: "Scout", manufacturer: "Ruger", model: null },
    ]);

    const json = await (await GET(request("scout"))).json();

    expect(json.groups[0].results[0].owned).toBe(FIREARM_OWNED_QUANTITY);
    expect(json.groups[0].results[0].detail).toBe("Ruger");
  });

  it("never selects a serial number", async () => {
    await GET(request("scout"));

    const firearmArgs = mocks.findFirearms.mock.calls[0][0];
    expect(firearmArgs.select).toEqual({
      id: true,
      name: true,
      manufacturer: true,
      model: true,
    });
    expect(firearmArgs.select.serialNumber).toBeUndefined();
    expect(firearmArgs.include).toBeUndefined();
  });

  it("decides the expiry verdict server-side, from the stored settings", async () => {
    mocks.findSupplies.mockResolvedValue([
      {
        id: "s1",
        name: "Water",
        brand: "Store",
        quantity: 12,
        unit: "GAL",
        // Unambiguously in the past in every timezone.
        expirationDate: new Date("2020-01-01T00:00:00.000Z"),
      },
      {
        id: "s2",
        name: "Water Reserve",
        brand: null,
        quantity: 4,
        unit: "GAL",
        expirationDate: new Date("2999-01-01T00:00:00.000Z"),
      },
    ]);

    const json = await (await GET(request("water"))).json();

    expect(mocks.settings).toHaveBeenCalledWith({
      where: { id: "singleton" },
    });
    const results = json.groups[0].results;
    expect(results[0].expiry).toBe("expired");
    expect(results[1].expiry).toBe("fine");
    // The column stores the token; every surface shows the label.
    expect(results[0].unit).toBe("gal");
  });

  it("labels ammo with its implied unit and no expiry", async () => {
    mocks.findAmmoStocks.mockResolvedValue([
      { id: "a1", brand: "Federal", caliber: "9mm", quantity: 500 },
    ]);

    const json = await (await GET(request("federal"))).json();

    expect(json.groups[0].results[0]).toMatchObject({
      field: "ammoStockId",
      name: "Federal 9mm",
      owned: 500,
      unit: "rounds",
      expiry: "none",
    });
  });

  it("500s when a query throws", async () => {
    mocks.findGear.mockRejectedValue(new Error("db down"));

    const response = await GET(request("bugout"));

    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Failed to search inventory");
  });
});
