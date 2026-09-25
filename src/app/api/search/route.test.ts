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
import { GEAR_CATEGORIES, GEAR_CATEGORY_LABELS } from "@/lib/gear";
import { gearSectionForItem, sectionHref } from "@/lib/categories";

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
    // Pin the derivation before asserting with it. Both sides of the
    // expectation below are computed the same way, so if no label ever matched
    // "bug" they would collapse to `{ in: [] }` together and the test would
    // pass while asserting nothing.
    const bugCategories = GEAR_CATEGORIES.filter((c) =>
      GEAR_CATEGORY_LABELS[c].toLowerCase().includes("bug"),
    );
    expect(bugCategories).toEqual(["BUGOUT"]);
    expect(where.OR).toEqual([
      { name: containsInsensitive("bug") },
      { manufacturer: containsInsensitive("bug") },
      { model: containsInsensitive("bug") },
      { category: containsInsensitive("bug") },
      // "bug" matches the BUGOUT label, so the label clause fires too. Derived
      // from GEAR_CATEGORY_LABELS rather than hardcoded: the phase-4 comment on
      // gearCategoriesMatchingLabel predicted this would start firing "the day"
      // a matching category was added, and phase 5 added it — but this
      // expectation was a literal, so it broke instead of covering the case.
      { category: { in: bugCategories } },
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

  // Derived from GEAR_CATEGORIES, not a hardcoded pair. Today's two labels
  // ("Knife", "Case") differ from their tokens only by case, so this passes
  // pre-fix for them; it is here so the day phase 5 adds a multi-word
  // category (FIRST_AID -> "First Aid") it is covered without anyone
  // remembering to extend the test.
  it.each([...GEAR_CATEGORIES])(
    "finds the %s gear category by its human label",
    async (category) => {
      await GET(request(GEAR_CATEGORY_LABELS[category]));

      const where = mocks.findGear.mock.calls[0][0].where;
      const inClause = where.OR.find(
        (clause: Record<string, unknown>) =>
          typeof clause.category === "object" &&
          clause.category !== null &&
          "in" in (clause.category as object),
      );
      expect(inClause).toBeDefined();
      expect(inClause.category.in).toContain(category);
    },
  );

  it("adds a gear category-label clause the same way supplies does", async () => {
    await GET(request("knife"));

    const where = mocks.findGear.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: containsInsensitive("knife") },
      { manufacturer: containsInsensitive("knife") },
      { model: containsInsensitive("knife") },
      { category: containsInsensitive("knife") },
      { category: { in: ["KNIFE"] } },
    ]);
  });

  it("omits the gear category-label clause when no label matches", async () => {
    await GET(request("zzzz"));

    const where = mocks.findGear.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { name: containsInsensitive("zzzz") },
      { manufacturer: containsInsensitive("zzzz") },
      { model: containsInsensitive("zzzz") },
      { category: containsInsensitive("zzzz") },
    ]);
  });
  // ─── Phase 5's eighteen new categories ───────────────────────────────────
  // The derivation was PREDICTED to cover them (see the comment on
  // gearCategoriesMatchingLabel). These verify it rather than trusting it.

  it("finds an ARMOR gear item when searching for armor", async () => {
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-plate",
        name: "Front Plate",
        manufacturer: "PlateCo",
        model: "III+",
        category: "ARMOR",
      },
    ]);

    const response = await GET(request("armor"));
    const json = await response.json();

    // The query reached the label clause...
    const where = mocks.findGear.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ category: { in: ["ARMOR"] } });
    // ...and the row comes back rendered, not just matched.
    expect(json.gear).toEqual([
      {
        id: "gear-plate",
        name: "Front Plate",
        subtitle: "PlateCo · Armor",
        url: "/gear/item/gear-plate",
      },
    ]);
  });

  it("serves 'medical kit' on the label path, and the token spelling on the column path", async () => {
    // The exact shape the supplies bug had: the column stores MEDICAL_KIT and
    // every surface shows "Medical Kit", so a substring match on the column
    // alone finds nothing for what the user typed.
    //
    // The negative control is a SECOND CALL THROUGH THE ROUTE rather than a
    // statement about strings: an earlier version of this test asserted
    // `"MEDICAL_KIT".toLowerCase().includes("medical kit") === false`, which is
    // literal-on-literal and could not fail whatever the route did. Driving the
    // route with the token spelling instead shows the two paths are genuinely
    // distinct — and fails if the route ever started label-matching tokens, or
    // if the label clause leaked into every query.
    await GET(request("medical kit"));
    await GET(request("medical_kit"));

    const inClauseOf = (where: { OR: Record<string, unknown>[] }) =>
      where.OR.find(
        (clause) =>
          typeof clause.category === "object" &&
          clause.category !== null &&
          "in" in (clause.category as object),
      );

    const labelWhere = mocks.findGear.mock.calls[0][0].where;
    const tokenWhere = mocks.findGear.mock.calls[1][0].where;

    // The label spelling reaches the label clause...
    expect(inClauseOf(labelWhere)).toEqual({ category: { in: ["MEDICAL_KIT"] } });
    // ...alongside the column clause, which is kept for a category a restore
    // stored outside the enum and which therefore has no label.
    expect(labelWhere.OR).toContainEqual({
      category: containsInsensitive("medical kit"),
    });

    // The token spelling reaches ONLY the column clause: no label contains
    // "medical_kit", so the route emits no `in` clause at all for it. That is
    // what makes the assertion above specifically about the label path.
    expect(inClauseOf(tokenWhere)).toBeUndefined();
    expect(tokenWhere.OR).toContainEqual({
      category: containsInsensitive("medical_kit"),
    });
  });

  it("keeps the gear item URL at /gear/item/<id> for a category whose section moved under /prep", async () => {
    // ARMOR's SECTION now lives under /prep, but the item route is not
    // section-scoped, so the search result must not follow the section there.
    // Asserted against the registry rather than a literal, so a later
    // re-grouping of ARMOR keeps this test honest.
    const section = gearSectionForItem({ category: "ARMOR" });
    expect(section).toBeDefined();
    expect(sectionHref(section!)).toMatch(/^\/prep\//);

    mocks.findGear.mockResolvedValue([
      {
        id: "gear-plate",
        name: "Front Plate",
        manufacturer: null,
        model: null,
        category: "ARMOR",
      },
    ]);

    const json = await (await GET(request("armor"))).json();

    expect(json.gear[0].url).toBe("/gear/item/gear-plate");
  });

  it("points every gear category at the same unscoped item route", async () => {
    // Fourteen of the twenty categories now sit in a /prep section and six do
    // not. One route serves all of them; this fails the moment a url starts
    // being derived from the section.
    //
    // The id is the SAME literal for every category, and the expectation is
    // that literal spelled out. An earlier version built the id from the
    // category and asserted `/gear/item/gear-${category}`, so both sides moved
    // together and only the prefix was really being checked.
    for (const category of GEAR_CATEGORIES) {
      mocks.findGear.mockResolvedValue([
        {
          id: "fixed-gear-id",
          name: `A ${category}`,
          manufacturer: null,
          model: null,
          category,
        },
      ]);

      const json = await (
        await GET(request(GEAR_CATEGORY_LABELS[category]))
      ).json();

      expect(json.gear[0].url).toBe("/gear/item/fixed-gear-id");
    }
  });
});
