import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirearms: vi.fn(),
  findAccessories: vi.fn(),
  findAmmoStocks: vi.fn(),
  findBuilds: vi.fn(),
  findGear: vi.fn(),
  findSupplies: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: { findMany: mocks.findFirearms },
    accessory: { findMany: mocks.findAccessories },
    ammoStock: { findMany: mocks.findAmmoStocks },
    build: { findMany: mocks.findBuilds },
    gear: { findMany: mocks.findGear },
    supply: { findMany: mocks.findSupplies },
  },
}));

// Wrap the real helper in a spy so we can assert the gear query goes through it
// rather than a bare Prisma `contains` — that's the exact case-sensitivity bug
// containsInsensitive exists to prevent from coming back on Postgres.
vi.mock("@/lib/db/text-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/text-search")>();
  return { ...actual, containsInsensitive: vi.fn(actual.containsInsensitive) };
});

import { GET } from "./route";
import { containsInsensitive } from "@/lib/db/text-search";

function request(query: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/search?q=${encodeURIComponent(query)}`,
  );
}

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findFirearms.mockResolvedValue([]);
    mocks.findAccessories.mockResolvedValue([]);
    mocks.findAmmoStocks.mockResolvedValue([]);
    mocks.findBuilds.mockResolvedValue([]);
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-1",
        name: "Benchmade Bugout",
        manufacturer: "Benchmade",
        model: "535",
        category: "KNIFE",
      },
    ]);
    mocks.findSupplies.mockResolvedValue([
      {
        id: "supply-1",
        name: "Bug Out Bandages",
        brand: "MedCo",
        category: "MEDICAL",
      },
    ]);
  });

  it("returns a gear key alongside the existing sections", async () => {
    const response = await GET(request("bug"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toHaveProperty("gear");
    expect(json.gear).toEqual([
      {
        id: "gear-1",
        name: "Benchmade Bugout",
        subtitle: "Benchmade · Knife",
        url: "/gear/item/gear-1",
      },
    ]);
  });

  it("searches gear name, manufacturer, model and category through containsInsensitive", async () => {
    await GET(request("bug"));

    expect(mocks.findGear).toHaveBeenCalledTimes(1);
    const where = mocks.findGear.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: containsInsensitive("bug") },
      { manufacturer: containsInsensitive("bug") },
      { model: containsInsensitive("bug") },
      { category: containsInsensitive("bug") },
    ]);

    // Every field in the gear OR clause was produced by the spied helper, not a
    // bare `{ contains: "bug" }` literal that would bypass Postgres's insensitive mode.
    const gearCallArgs = vi
      .mocked(containsInsensitive)
      .mock.calls.filter(([value]) => value === "bug");
    expect(gearCallArgs.length).toBeGreaterThanOrEqual(4);
  });

  it("returns empty sections including gear for a short query, without querying", async () => {
    const response = await GET(request("a"));
    const json = await response.json();

    expect(json).toEqual({
      firearms: [],
      accessories: [],
      ammo: [],
      builds: [],
      gear: [],
      supplies: [],
    });
    expect(mocks.findGear).not.toHaveBeenCalled();
  });

  it("returns a supplies key alongside the existing sections", async () => {
    const response = await GET(request("bug"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toHaveProperty("supplies");
    expect(json.supplies).toEqual([
      {
        id: "supply-1",
        name: "Bug Out Bandages",
        subtitle: "MedCo · Medical",
        url: "/supplies/item/supply-1",
      },
    ]);
  });

  it("searches supply name, brand, notes and category through containsInsensitive", async () => {
    await GET(request("bug"));

    expect(mocks.findSupplies).toHaveBeenCalledTimes(1);
    const where = mocks.findSupplies.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: containsInsensitive("bug") },
      { brand: containsInsensitive("bug") },
      { notes: containsInsensitive("bug") },
      { category: containsInsensitive("bug") },
    ]);

    // Every field in the supply OR clause was produced by the spied helper, not a
    // bare `{ contains: "bug" }` literal that would bypass Postgres's insensitive mode.
    const supplyCallArgs = vi
      .mocked(containsInsensitive)
      .mock.calls.filter(([value]) => value === "bug");
    expect(supplyCallArgs.length).toBeGreaterThanOrEqual(4);
  });

  it("matches a supply category by its human label, not just the stored token", async () => {
    // "cbrn filter" is what the badge, the detail page and the export all
    // show; the column stores CBRN_FILTER, so a substring match against the
    // column alone found nothing.
    await GET(request("cbrn filter"));

    const where = mocks.findSupplies.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ category: { in: ["CBRN_FILTER"] } });
    // The substring clause on the column stays, for a category stored outside
    // the enum by a restore, which has no label to match.
    expect(where.OR).toContainEqual({
      category: containsInsensitive("cbrn filter"),
    });
  });

  it("matches every category whose label contains the query", async () => {
    await GET(request("filter"));

    const where = mocks.findSupplies.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({
      category: { in: ["FILTER", "CBRN_FILTER"] },
    });
  });

  it("omits the category-label clause when no label matches", async () => {
    await GET(request("zzzz"));

    const where = mocks.findSupplies.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: containsInsensitive("zzzz") },
      { brand: containsInsensitive("zzzz") },
      { notes: containsInsensitive("zzzz") },
      { category: containsInsensitive("zzzz") },
    ]);
  });

  it("does not query supplies for a short query", async () => {
    await GET(request("a"));
    expect(mocks.findSupplies).not.toHaveBeenCalled();
  });
});
