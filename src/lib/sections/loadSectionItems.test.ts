import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CATEGORY_SECTIONS, sectionBySlug } from "@/lib/categories";

const mocks = vi.hoisted(() => ({
  findAppSettings: vi.fn(),
  findFirearms: vi.fn(),
  findAccessories: vi.fn(),
  findGear: vi.fn(),
  findSupplies: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findAppSettings },
    firearm: { findMany: mocks.findFirearms },
    accessory: { findMany: mocks.findAccessories },
    gear: { findMany: mocks.findGear },
    supply: { findMany: mocks.findSupplies },
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

  it("never issues a query with no where clause", async () => {
    // `?? undefined` on a where-builder has caused two live bugs in this
    // epic: it turns "matches nothing here" into "match everything". Every
    // query this loader issues carries a filter.
    for (const section of CATEGORY_SECTIONS) {
      vi.clearAllMocks();
      await loadSectionItems(section);
      for (const delegate of [
        prisma.firearm,
        prisma.accessory,
        prisma.gear,
        prisma.supply,
      ]) {
        for (const call of (delegate.findMany as unknown as Mock).mock.calls) {
          expect(call[0]?.where).toBeTruthy();
        }
      }
    }
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
});
