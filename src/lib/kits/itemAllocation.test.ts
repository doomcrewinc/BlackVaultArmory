import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: { kitItem: { findMany: (args: unknown) => findMany(args) } },
}));

import { getItemAllocation } from "./itemAllocation";
import { isOverAllocated } from "./allocation";
import { KIT_ITEM_SOURCES } from "@/lib/kit";

/** A KitItem row as the query selects it: five source keys, quantity, kit. */
function row(
  overrides: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    gearId: null,
    supplyId: null,
    accessoryId: null,
    ammoStockId: null,
    firearmId: null,
    quantity: 1,
    kit: { id: "k1", name: "Bugout Bag" },
    ...overrides,
  };
}

describe("getItemAllocation", () => {
  beforeEach(() => {
    findMany.mockReset().mockResolvedValue([]);
  });

  it("returns null for an item in no kit, rather than a zeroed record", () => {
    // "0 assigned" is a sentence the detail pages must never print: almost
    // nothing a user owns is in a kit, and the component renders nothing for
    // null. A zeroed record would put a line on every item page in the app.
    return expect(getItemAllocation("gearId", "g1", 10)).resolves.toBeNull();
  });

  it("sums the quantity across every kit holding the item", async () => {
    findMany.mockResolvedValue([
      row({ accessoryId: "a1", quantity: 4, kit: { id: "k1", name: "Range" } }),
      row({ accessoryId: "a1", quantity: 8, kit: { id: "k2", name: "Truck" } }),
    ]);

    const result = await getItemAllocation("accessoryId", "a1", 10);

    expect(result?.allocated).toBe(12);
    expect(result?.owned).toBe(10);
    expect(result?.kits).toEqual([
      { kitId: "k1", kitName: "Range", quantity: 4 },
      { kitId: "k2", kitName: "Truck", quantity: 8 },
    ]);
  });

  it("flags over-allocation with the shared predicate's verdict", async () => {
    findMany.mockResolvedValue([
      row({ accessoryId: "a1", quantity: 4 }),
      row({ accessoryId: "a1", quantity: 8, kit: { id: "k2", name: "Truck" } }),
    ]);

    const result = await getItemAllocation("accessoryId", "a1", 10);

    // Pinned against the shared helper, not against a literal: the point of
    // this fix is that the item half and the kit half use ONE rule, so the
    // assertion is stated in terms of that rule.
    expect(result?.overAllocated).toBe(
      isOverAllocated({ allocated: 12, owned: 10 }),
    );
    expect(result?.overAllocated).toBe(true);
  });

  it("does not flag an item packed up to exactly what is owned", async () => {
    findMany.mockResolvedValue([row({ accessoryId: "a1", quantity: 10 })]);
    const result = await getItemAllocation("accessoryId", "a1", 10);
    expect(result?.allocated).toBe(10);
    expect(result?.overAllocated).toBe(false);
  });

  it("never flags an item whose owned quantity is unknown", async () => {
    findMany.mockResolvedValue([row({ gearId: "g1", quantity: 99 })]);
    const result = await getItemAllocation("gearId", "g1", null);
    expect(result?.allocated).toBe(99);
    expect(result?.overAllocated).toBe(false);
  });

  it("filters in the database on the item's own foreign key", async () => {
    findMany.mockResolvedValue([row({ firearmId: "f1" })]);
    await getItemAllocation("firearmId", "f1", 1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({ firearmId: "f1" });
  });

  it("makes exactly ONE query, joining the kit name rather than fetching it", async () => {
    // SQLite here runs with connection_limit=1, so a second await is a second
    // serialized query on a page that is already sequential. The kit name must
    // ride along on this query.
    findMany.mockResolvedValue([row({ gearId: "g1" })]);
    await getItemAllocation("gearId", "g1", 3);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].select.kit).toEqual({
      select: { id: true, name: true },
    });
  });

  it("selects no field that carries a serial number", async () => {
    // The leak that hit the exports route four separate times. A KitItem points
    // at Firearm, Accessory and Gear rows that all carry a serial; this query
    // must name none of them as a relation, and must not name serialNumber.
    findMany.mockResolvedValue([row({ gearId: "g1" })]);
    await getItemAllocation("gearId", "g1", 3);
    const args = findMany.mock.calls[0][0];
    expect(args).not.toHaveProperty("include");
    expect(JSON.stringify(args)).not.toContain("serialNumber");
    for (const relation of ["gear", "supply", "accessory", "ammoStock", "firearm"]) {
      expect(args.select).not.toHaveProperty(relation);
    }
  });

  it("selects all five source columns so attribution matches the kit page", async () => {
    // allocationByItem resolves each row's source first-match-wins over
    // KIT_ITEM_SOURCES. Selecting only the filtered column would attribute a
    // malformed two-key row differently here than on the kit page, and the two
    // surfaces would report different totals for the same item.
    findMany.mockResolvedValue([row({ supplyId: "s1" })]);
    await getItemAllocation("supplyId", "s1", 5);
    const select = findMany.mock.calls[0][0].select;
    for (const field of KIT_ITEM_SOURCES) {
      expect(select[field]).toBe(true);
    }
  });

  it("attributes a malformed two-key row the way the kit page does", async () => {
    // A row with both gearId and supplyId set: the API rejects it, the database
    // does not forbid it, and restore inserts rows unvalidated. gearId comes
    // first in KIT_ITEM_SOURCES, so allocationSourceOf keys it under gear —
    // which means a query filtered on supplyId finds the row but attributes
    // nothing to the supply. Asserted, not wished away: matching the kit page
    // is the requirement, and this documents what matching costs.
    expect(KIT_ITEM_SOURCES.indexOf("gearId")).toBeLessThan(
      KIT_ITEM_SOURCES.indexOf("supplyId"),
    );
    findMany.mockResolvedValue([row({ gearId: "g1", supplyId: "s1", quantity: 7 })]);
    const result = await getItemAllocation("supplyId", "s1", 5);
    expect(result?.allocated).toBe(0);
    expect(result?.overAllocated).toBe(false);
  });
});
