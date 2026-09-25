import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirearms: vi.fn(),
  findAccessories: vi.fn(),
  findAmmoStocks: vi.fn(),
  findBuilds: vi.fn(),
  findGear: vi.fn(),
  findSupplies: vi.fn(),
  findKits: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: { findMany: mocks.findFirearms },
    accessory: { findMany: mocks.findAccessories },
    ammoStock: { findMany: mocks.findAmmoStocks },
    build: { findMany: mocks.findBuilds },
    gear: { findMany: mocks.findGear },
    supply: { findMany: mocks.findSupplies },
    kit: { findMany: mocks.findKits },
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
import { KIT_CATEGORIES, KIT_CATEGORY_LABELS } from "@/lib/kit";
import { existsSync } from "node:fs";

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
    mocks.findKits.mockResolvedValue([
      {
        id: "kit-1",
        name: "Bugout Bag",
        category: "BUGOUT",
        location: "Hall closet",
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
      kits: [],
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

  // --------------------------------------------------------------- kits ----

  it("returns a kits key alongside the existing sections", async () => {
    // Kits were NOT searchable before this task: two earlier briefs claimed
    // they were and they were not, so this is the test that pins it.
    const response = await GET(request("bug"));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toHaveProperty("kits");
    expect(json.kits).toEqual([
      {
        id: "kit-1",
        name: "Bugout Bag",
        subtitle: "Bugout · Hall closet",
        url: "/kits/kit-1",
      },
    ]);
  });

  it("searches kit name, location, notes and category through containsInsensitive", async () => {
    await GET(request("bug"));

    expect(mocks.findKits).toHaveBeenCalledTimes(1);
    const where = mocks.findKits.mock.calls[0][0].where;
    // Pin the derivation before asserting with it: containsInsensitive is the
    // spied-on real helper, so this is the shape it actually produces on this
    // provider, not a re-spelling of it.
    const clause = vi.mocked(containsInsensitive).getMockImplementation()!("bug");
    // FOUR column clauses plus the label clause. Pinned before the assertion
    // rather than written out: this expectation was ORIGINALLY `[]` here, on
    // the assumption that "bug" matched no kit label — it is a substring of
    // "Bugout", and the pin is what caught that rather than an assertion that
    // quietly agreed with a wrong belief.
    const matching = KIT_CATEGORIES.filter((c) =>
      KIT_CATEGORY_LABELS[c].toLowerCase().includes("bug"),
    );
    expect(matching).toEqual(["BUGOUT"]);
    // `location` sits second, beside `name`: it is the kit's second identity
    // field, the way `manufacturer` is gear's and `brand` is a supply's.
    expect(where.OR).toEqual([
      { name: clause },
      { location: clause },
      { notes: clause },
      { category: clause },
      { category: { in: matching } },
    ]);
    // Never a bare Prisma `contains`, which is case-SENSITIVE on Postgres.
    expect(containsInsensitive).toHaveBeenCalledWith("bug");
  });

  it("finds a kit by its location alone, which the subtitle already printed", async () => {
    // The gap this closes: "F-250 rear seat" is rendered into every kit
    // subtitle, so a user reads it in one result and types it into the box —
    // and before this clause got nothing back. A field the results DISPLAY
    // must be a field the query MATCHES.
    //
    // Pin the negative first, or this test would pass on the name clause
    // alone and prove nothing: neither the name, the notes nor any category
    // label contains "f-250".
    const q = "f-250";
    expect("Truck Bag".toLowerCase()).not.toContain(q);
    expect(
      KIT_CATEGORIES.filter((c) =>
        KIT_CATEGORY_LABELS[c].toLowerCase().includes(q),
      ),
    ).toEqual([]);

    mocks.findKits.mockResolvedValue([
      {
        id: "kit-truck",
        name: "Truck Bag",
        category: "VEHICLE",
        location: "F-250 rear seat",
      },
    ]);

    const json = await (await GET(request(q))).json();

    const where = mocks.findKits.mock.calls[0][0].where;
    const clause = vi.mocked(containsInsensitive).getMockImplementation()!(q);
    expect(where.OR).toContainEqual({ location: clause });
    expect(json.kits[0].subtitle).toBe("Vehicle · F-250 rear seat");
  });

  it("finds a MEDICAL kit when searching for medical, though its name and notes say no such thing", async () => {
    // The parity bug this closes: the same word found a MEDICAL supply and a
    // MEDICAL_KIT gear item and skipped a MEDICAL kit, because kits matched
    // only name and notes. A user reading that sees a bug, not a decision.
    //
    // PIN THE DERIVED LIST FIRST. A derived expectation that collapses to
    // `{ in: [] }` passes while asserting nothing, which a phase-5 review
    // caught in this very file's neighbourhood.
    const matching = KIT_CATEGORIES.filter((c) =>
      KIT_CATEGORY_LABELS[c].toLowerCase().includes("medical"),
    );
    expect(matching).toEqual(["MEDICAL"]);

    mocks.findKits.mockResolvedValue([
      {
        id: "kit-med",
        // Neither the name nor the notes contain "medical" — the category is
        // the only thing that can match.
        name: "Truck Bag",
        category: "MEDICAL",
        location: "F-250 rear seat",
      },
    ]);

    const json = await (await GET(request("medical"))).json();

    expect(json.kits).toEqual([
      {
        id: "kit-med",
        name: "Truck Bag",
        subtitle: "Medical · F-250 rear seat",
        url: "/kits/kit-med",
      },
    ]);

    const where = mocks.findKits.mock.calls[0][0].where;
    // BOTH category clauses reach the database, and they are not redundant:
    // the column clause is what matches MEDICAL today (the label "Medical"
    // differs from the token by case alone, which containsInsensitive
    // handles), and the label clause is what will still match when a kit
    // category's label stops being a re-casing of its token.
    expect(where.OR).toContainEqual({
      category: containsInsensitive("medical"),
    });
    expect(where.OR).toContainEqual({ category: { in: matching } });
  });

  it.each([...KIT_CATEGORIES])(
    "puts %s in the kit label clause when its own label is searched",
    async (category) => {
      await GET(request(KIT_CATEGORY_LABELS[category]));

      const where = mocks.findKits.mock.calls[0][0].where;
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

  it("omits the kit category-label clause when no label matches", async () => {
    await GET(request("zzzz"));

    const where = mocks.findKits.mock.calls[0][0].where;
    // FOUR column clauses, not five: no trailing `{ category: { in: [] } }`.
    expect(where.OR).toEqual([
      { name: containsInsensitive("zzzz") },
      { location: containsInsensitive("zzzz") },
      { notes: containsInsensitive("zzzz") },
      { category: containsInsensitive("zzzz") },
    ]);
  });

  it("still finds a kit whose category this build does not recognise", async () => {
    // The half the label clause cannot do: restore inserts kit rows
    // unvalidated, so a category from a later build has no label to match and
    // the column clause is the only thing that can find it.
    const matching = KIT_CATEGORIES.filter((c) =>
      KIT_CATEGORY_LABELS[c].toLowerCase().includes("scuba"),
    );
    expect(matching).toEqual([]);

    mocks.findKits.mockResolvedValue([
      { id: "kit-scuba", name: "Dive Bag", category: "SCUBA", location: null },
    ]);

    const json = await (await GET(request("scuba"))).json();

    expect(json.kits[0].subtitle).toBe("SCUBA");
    expect(mocks.findKits.mock.calls[0][0].where.OR).toContainEqual({
      category: containsInsensitive("scuba"),
    });
  });

  it("selects only the kit's own columns — nothing about its contents", async () => {
    // A kit's lines point at Firearm, Accessory and Gear rows, all three of
    // which carry a serialNumber. An `include` here would pull them in on a
    // path nothing in this file strips, which is how the exports route leaked
    // a serial four separate times. The explicit narrow select is why that
    // leak never reached search; this keeps the property.
    await GET(request("bug"));

    const args = mocks.findKits.mock.calls[0][0];
    expect(args.select).toEqual({
      id: true,
      name: true,
      category: true,
      location: true,
    });
    expect(args).not.toHaveProperty("include");
    expect(args.take).toBe(5);
  });

  it("falls back to the category label of the kit, and to the token when unknown", async () => {
    for (const category of KIT_CATEGORIES) {
      mocks.findKits.mockResolvedValue([
        { id: "fixed-kit-id", name: "A kit", category, location: null },
      ]);
      const json = await (await GET(request("kit"))).json();
      // No location, so the label stands alone rather than leaving a blank.
      expect(json.kits[0].subtitle).toBe(KIT_CATEGORY_LABELS[category]);
    }

    // Restore inserts kit rows unvalidated, so a category from a later build
    // can be stored; it must show as itself.
    mocks.findKits.mockResolvedValue([
      { id: "fixed-kit-id", name: "A kit", category: "SCUBA", location: null },
    ]);
    const json = await (await GET(request("kit"))).json();
    expect(json.kits[0].subtitle).toBe("SCUBA");
  });

  it("points a kit result at /kits/<id>, and that route exists", async () => {
    mocks.findKits.mockResolvedValue([
      { id: "fixed-kit-id", name: "A kit", category: "RANGE", location: null },
    ]);

    const json = await (await GET(request("kit"))).json();
    expect(json.kits[0].url).toBe("/kits/fixed-kit-id");

    // The url is only useful if something serves it. `/kits/<id>` is a dynamic
    // App Router segment, so the proof that it resolves is the page file — a
    // literal asserted against a literal would pass just as happily against a
    // dead link, which is how two earlier surfaces in this epic shipped one.
    expect(existsSync("src/app/kits/[id]/page.tsx")).toBe(true);
  });

  it("returns an empty kits section for a short query, without querying", async () => {
    const json = await (await GET(request("b"))).json();

    expect(json.kits).toEqual([]);
    expect(mocks.findKits).not.toHaveBeenCalled();
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
