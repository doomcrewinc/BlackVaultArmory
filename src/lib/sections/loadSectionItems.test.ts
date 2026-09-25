import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CATEGORY_SECTIONS,
  UNFILTERED_SECTION_SOURCES,
  accessoryWhereForSection,
  sectionBySlug,
  sectionSources,
  type CategorySection,
  type SectionSource,
} from "@/lib/categories";

const mocks = vi.hoisted(() => ({
  findAppSettings: vi.fn(),
  findFirearms: vi.fn(),
  findAccessories: vi.fn(),
  findGear: vi.fn(),
  findSupplies: vi.fn(),
  findKits: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findAppSettings },
    firearm: { findMany: mocks.findFirearms },
    accessory: { findMany: mocks.findAccessories },
    gear: { findMany: mocks.findGear },
    supply: { findMany: mocks.findSupplies },
    kit: { findMany: mocks.findKits },
  },
}));

import { prisma } from "@/lib/prisma";
import { loadSectionItems } from "./loadSectionItems";

beforeEach(() => {
  mocks.findAppSettings.mockReset().mockResolvedValue(null);
  mocks.findFirearms.mockReset().mockResolvedValue([]);
  mocks.findAccessories.mockReset().mockResolvedValue([]);
  mocks.findGear.mockReset().mockResolvedValue([]);
  mocks.findSupplies.mockReset().mockResolvedValue([]);
  mocks.findKits.mockReset().mockResolvedValue([]);
});

describe("loadSectionItems", () => {
  it("loads both sources of a mixed section, in declaration order", async () => {
    const payloads = await loadSectionItems(sectionBySlug("medical")!);
    expect(payloads.map((p) => p.kind)).toEqual(["gear", "supply"]);
    expect(prisma.gear.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: { in: ["MEDICAL_KIT"] } } }),
    );
    expect(prisma.supply.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: { in: ["MEDICAL"] } } }),
    );
  });

  it("loads a gear-only section without touching the other tables", async () => {
    const payloads = await loadSectionItems(sectionBySlug("armor")!);
    expect(payloads.map((p) => p.kind)).toEqual(["gear"]);
    expect(prisma.supply.findMany).not.toHaveBeenCalled();
    expect(prisma.accessory.findMany).not.toHaveBeenCalled();
    expect(prisma.firearm.findMany).not.toHaveBeenCalled();
  });

  it("never issues a query with no where clause, except where the spec says all", async () => {
    // `?? undefined` on a where-builder has caused two live bugs in this
    // epic: it turns "matches nothing here" into "match everything".
    //
    // A bare `toBeTruthy()` would pass for `where: {}`, which IS an
    // unfiltered query — the very thing being guarded against — so the key
    // count is asserted too. Phase 6 then registered a section the spec
    // defines as `kit, all`, for which an unfiltered query is the honest
    // intent, and one assertion cannot be true of both.
    //
    // Resolved by exempting the kinds on UNFILTERED_SECTION_SOURCES — a
    // registry constant, not a delegate named in this file — and NOT by
    // deleting the assertion. `categories.test.ts` asserts that list is
    // exactly the set of kinds whose matcher carries an empty `where`, so an
    // accidental `where: {}` on a firearm, accessory, gear or supply matcher
    // still fails here, and a kind exempted without earning it fails there.
    //
    // The delegate list is keyed BY SOURCE KIND and typed
    // Record<SectionSource, …>, so a sixth source kind is a compile error
    // here rather than a table this loop silently walks past — which is what
    // the old bare array did to `kit`.
    const delegates: Record<SectionSource, { findMany: unknown }> = {
      firearm: prisma.firearm,
      accessory: prisma.accessory,
      gear: prisma.gear,
      supply: prisma.supply,
      kit: prisma.kit,
    };
    const exempt = new Set<SectionSource>(UNFILTERED_SECTION_SOURCES);

    for (const section of CATEGORY_SECTIONS) {
      vi.clearAllMocks();
      await loadSectionItems(section);
      for (const [kind, delegate] of Object.entries(delegates) as [
        SectionSource,
        { findMany: unknown },
      ][]) {
        for (const call of (delegate.findMany as Mock).mock.calls) {
          // Asserted for every kind, exempt or not: `{ where: undefined }`
          // is the `?? undefined` coercion itself, and is never acceptable.
          expect(
            call[0]?.where,
            `${section.slug} issued a ${kind} query with no where at all`,
          ).toBeTruthy();
          if (exempt.has(kind)) continue;
          expect(
            Object.keys(call[0].where as object).length,
            `${section.slug} issued a ${kind} query with an empty where`,
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it("passes an empty where straight through to Prisma, unsanitized", async () => {
    // WHY the guard has to exist, stated as behaviour: the loader does not
    // reject, clamp or sanitize an empty `where`. A gear matcher that ships
    // `{}` produces one real query with `where: {}` — an unfiltered read of
    // the whole table — so nothing downstream will save a matcher that gets
    // this wrong. `armor`'s gear source is NOT on
    // UNFILTERED_SECTION_SOURCES, so `{}` here is a defect, not the spec.
    //
    // This test does NOT prove the guard fires. It used to claim that with
    // `expect(() => expect(Object.keys({}).length).toBeGreaterThan(0))
    // .toThrow()`, which only asserts that vitest throws on a failed
    // expectation — true of vitest, silent about this code. Measured: with
    // UNFILTERED_SECTION_SOURCES widened to ["kit", "gear"], this test still
    // passed and exactly one test failed, the derived set-equality one in
    // categories.test.ts. THAT is where the exemption is pinned.
    const forged = {
      ...sectionBySlug("armor")!,
      sources: [{ source: "gear", where: {}, holds: () => true }],
    } as unknown as CategorySection;

    await loadSectionItems(forged);

    const calls = (prisma.gear.findMany as unknown as Mock).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].where).toEqual({});
  });

  it("skips a source whose where-builder returns null", async () => {
    // The loop above cannot reach the `continue` branches: `sectionSources`
    // derives the kinds it reports from the same `sources` array the
    // where-builders search, so every registered section's builders return
    // non-null and the guard is never exercised by real data.
    //
    // This forges the case directly. `accessoryWhereForSection` ends in
    // `?? null`, so a matcher that declares the source but carries no `where`
    // makes it return null while `sectionSources` still reports "accessory".
    // The loader must issue NO accessory query at all. Were the `continue`
    // written as `where ?? undefined`, Prisma would receive
    // `{ where: undefined }` and return every accessory in the database.
    const forged = {
      slug: "forged-null-where",
      label: "Forged",
      description: "A section whose accessory matcher carries no where",
      group: "gear",
      icon: "Package",
      sources: [{ source: "accessory", holds: () => true }],
    } as unknown as CategorySection;

    expect(sectionSources(forged)).toEqual(["accessory"]);
    expect(accessoryWhereForSection(forged)).toBeNull();

    const payloads = await loadSectionItems(forged);

    expect(payloads).toEqual([]);
    expect(prisma.accessory.findMany).not.toHaveBeenCalled();
  });

  it("issues at least one query for every registered section", async () => {
    // A section that queries nothing renders nothing; the loader returning an
    // empty payload list must stay a registry defect, not a quiet blank page.
    for (const section of CATEGORY_SECTIONS) {
      vi.clearAllMocks();
      const payloads = await loadSectionItems(section);
      expect(
        payloads.length,
        `section ${section.slug} loaded no sources`,
      ).toBeGreaterThan(0);
    }
  });

  it("queries sequentially, because sqlite runs connection_limit=1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [];
    };
    mocks.findGear.mockImplementation(track);
    mocks.findSupplies.mockImplementation(track);
    await loadSectionItems(sectionBySlug("medical")!);
    expect(maxInFlight).toBe(1);
  });

  it("resolves the expiry timezone once for the whole section", async () => {
    await loadSectionItems(sectionBySlug("medical")!);
    expect(prisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("gives the gear and supply lists of one section the same today", async () => {
    // 21:00 on June 15 in Denver is already June 16 in UTC. A raw `new Date()`
    // reaching expiryStatus reads an item expiring today as expired; the two
    // lists on one page must also not disagree with each other.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T03:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({
      id: "singleton",
      timezone: "America/Denver",
      expiryWarningDays: 90,
    });
    const expiresToday = new Date("2026-06-15T00:00:00.000Z");
    mocks.findGear.mockResolvedValue([
      { id: "g1", name: "Trauma Kit", expirationDate: expiresToday },
    ]);
    mocks.findSupplies.mockResolvedValue([
      {
        id: "s1",
        name: "Chest Seals",
        brand: null,
        category: "MEDICAL",
        quantity: 2,
        unit: "COUNT",
        storageLocation: null,
        lowStockAlert: null,
        expirationDate: expiresToday,
      },
    ]);

    const payloads = await loadSectionItems(sectionBySlug("medical")!);
    const gearPayload = payloads.find((p) => p.kind === "gear")!;
    const supplyPayload = payloads.find((p) => p.kind === "supply")!;
    expect(gearPayload.kind === "gear" && gearPayload.items[0].expiry).toBe(
      "soon",
    );
    expect(
      supplyPayload.kind === "supply" && supplyPayload.items[0].expiry,
    ).toBe("soon");
    vi.useRealTimers();
  });

  it("reports the timezone as unconfigured on every payload of a section", async () => {
    mocks.findAppSettings.mockResolvedValue({
      id: "singleton",
      timezone: null,
      expiryWarningDays: 90,
    });
    const payloads = await loadSectionItems(sectionBySlug("medical")!);
    for (const payload of payloads) {
      if (payload.kind === "gear" || payload.kind === "supply") {
        expect(payload.timezoneConfigured).toBe(false);
      }
    }
  });

  it("does not read AppSettings for a section with no expiring source", async () => {
    await loadSectionItems(sectionBySlug("optics")!);
    expect(prisma.appSettings.findUnique).not.toHaveBeenCalled();
  });

  it("queries every kit, with its items included, for the kits section", async () => {
    await loadSectionItems(sectionBySlug("kits")!);
    const call = (prisma.kit.findMany as unknown as Mock).mock.calls[0][0];
    // `{}`, on purpose: the spec's section table reads `kit, all`.
    expect(call.where).toEqual({});
    expect(call.orderBy).toEqual({ name: "asc" });
    // ONE query with an include, not a query per kit — sqlite runs
    // connection_limit=1, so N+1 would serialize into N round trips.
    expect(call.include.items.select.gear.select.expirationDate).toBe(true);
    expect(call.include.items.select.supply.select.expirationDate).toBe(true);
  });

  it("rolls a kit's items up into counts and drops the items themselves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T03:00:00.000Z"));
    mocks.findAppSettings.mockResolvedValue({
      id: "singleton",
      timezone: "America/Denver",
      expiryWarningDays: 90,
    });
    mocks.findKits.mockResolvedValue([
      {
        id: "k1",
        name: "Bugout Bag",
        category: "BUGOUT",
        location: "Hall closet",
        notes: null,
        imageUrl: null,
        items: [
          // 2 of a target 5 → 3 missing, and a gear line already expired.
          {
            quantity: 2,
            targetQuantity: 5,
            gear: { expirationDate: new Date("2020-01-01T00:00:00.000Z") },
            supply: null,
          },
          // 1 of a target 2 → 1 missing, and a supply line expiring soon.
          {
            quantity: 1,
            targetQuantity: 2,
            gear: null,
            supply: { expirationDate: new Date("2026-06-15T00:00:00.000Z") },
          },
          // No target → contributes nothing to `missing`, and no expiry row
          // at all (a label-only or firearm/accessory line).
          { quantity: 1, targetQuantity: null, gear: null, supply: null },
        ],
      },
    ]);

    const payloads = await loadSectionItems(sectionBySlug("kits")!);
    expect(payloads.map((p) => p.kind)).toEqual(["kit"]);
    const payload = payloads[0];
    if (payload.kind !== "kit") throw new Error("expected a kit payload");
    const kit = payload.items[0];

    expect(kit.itemCount).toBe(3);
    expect(kit.missing).toBe(4);
    // Off the SAME resolved `today` the gear and supply branches use: 21:00
    // on June 15 in Denver. A raw `new Date()` here would be June 16 UTC and
    // would read the second line as expired rather than soon.
    expect(kit.expiry.expired).toBe(1);
    expect(kit.expiry.soon).toBe(1);
    expect(kit.expiry.earliest).toEqual(new Date("2020-01-01T00:00:00.000Z"));
    // `items` is destructured out: a KitItem's five nullable foreign keys and
    // its joined rows must not cross the server/client boundary for a card
    // that shows three numbers.
    expect("items" in kit).toBe(false);
    vi.useRealTimers();
  });

  it("resolves today ONCE for a page carrying a kit payload", async () => {
    // Two resolutions on one page is how two lists come to disagree about
    // what day it is. The kit branch shares `loadExpiryContext` rather than
    // calling resolveExpiryContext again.
    await loadSectionItems(sectionBySlug("kits")!);
    expect(prisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it("reports an unconfigured timezone on the kit payload too", async () => {
    // A kit card renders "n EXPIRED", so the page must be able to disclose
    // which timezone decided it.
    //
    // NARROWED BY A THROW, never by `&&`. This assertion was written
    // `expect(payloads[0].kind === "kit" && payloads[0].timezoneConfigured)
    // .toBe(false)`, which short-circuits to `false` when the payload is not
    // a kit at all and becomes `expect(false).toBe(false)` — passing
    // precisely when the thing it checks is absent. Exactly the
    // looks-present-does-nothing shape this phase spent itself removing,
    // reintroduced in the test that was meant to hold the line.
    mocks.findAppSettings.mockResolvedValue({
      id: "singleton",
      timezone: null,
      expiryWarningDays: 90,
    });
    const payloads = await loadSectionItems(sectionBySlug("kits")!);
    const payload = payloads[0];
    if (payload?.kind !== "kit") throw new Error("expected a kit payload");
    expect(payload.timezoneConfigured).toBe(false);
  });

  it("skips a section that declares a kit source with no where", async () => {
    // `{}` and null are different answers and the loader must keep them
    // apart: `{}` means all kits, null means this section has no kit matcher.
    const forged = {
      slug: "forged-null-kit-where",
      label: "Forged",
      description: "A section whose kit matcher carries no where",
      group: "prep",
      icon: "Backpack",
      sources: [{ source: "kit", holds: () => true }],
    } as unknown as CategorySection;

    expect(sectionSources(forged)).toEqual(["kit"]);
    const payloads = await loadSectionItems(forged);

    expect(payloads).toEqual([]);
    expect(prisma.kit.findMany).not.toHaveBeenCalled();
  });
});
