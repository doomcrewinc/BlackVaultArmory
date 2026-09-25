import { describe, expect, it } from "vitest";
import {
  allocationByItem,
  allocationKey,
  allocationSourceOf,
  isOverAllocated,
  kitExpiryRollup,
  kitRollupHasExpiryBadges,
  missingQuantity,
} from "./allocation";
import { KIT_ITEM_SOURCES } from "@/lib/kit";
import { resolveKitItemSource } from "./kitItemSource";

describe("allocation across kits", () => {
  it("sums one item's quantity over every kit that holds it", () => {
    const rows = [
      { accessoryId: "a1", quantity: 4 },
      { accessoryId: "a1", quantity: 8 },
      { accessoryId: "a2", quantity: 1 },
    ];
    expect(allocationByItem(rows).get("accessoryId:a1")).toBe(12);
    expect(allocationByItem(rows).get("accessoryId:a2")).toBe(1);
  });

  it("keys by source AND id, so two tables sharing an id cannot collide", () => {
    // cuid collisions across tables are vanishingly unlikely, but a bare id
    // key would make the bug silent and unfalsifiable if one ever happened.
    const rows = [
      { gearId: "x1", quantity: 2 },
      { supplyId: "x1", quantity: 5 },
    ];
    const allocation = allocationByItem(rows);
    expect(allocation.get("gearId:x1")).toBe(2);
    expect(allocation.get("supplyId:x1")).toBe(5);
  });

  it("ignores label-only lines, which allocate nothing", () => {
    expect(allocationByItem([{ label: "cash", quantity: 3 }]).size).toBe(0);
  });

  it("flags over-allocation without blocking it", () => {
    // Spec: "14 of 12 assigned" is shown, never refused.
    expect(isOverAllocated({ allocated: 14, owned: 12 })).toBe(true);
    expect(isOverAllocated({ allocated: 12, owned: 12 })).toBe(false);
    expect(isOverAllocated({ allocated: 4, owned: 12 })).toBe(false);
  });

  it("treats an unknown owned quantity as not over-allocated", () => {
    // A label-only line owns nothing measurable; flagging it would cry wolf.
    expect(isOverAllocated({ allocated: 3, owned: null })).toBe(false);
  });

  it("reports missing only when the target exceeds what is packed", () => {
    expect(missingQuantity({ quantity: 2, targetQuantity: 5 })).toBe(3);
    expect(missingQuantity({ quantity: 5, targetQuantity: 5 })).toBe(0);
    expect(missingQuantity({ quantity: 7, targetQuantity: 5 })).toBe(0);
    expect(missingQuantity({ quantity: 2, targetQuantity: null })).toBe(0);
  });
});

describe("allocationSourceOf", () => {
  it("resolves each of the five sources, and none for a label-only line", () => {
    // Driven off KIT_ITEM_SOURCES rather than five hand-written cases, so a
    // sixth source cannot be added with this test still claiming full cover.
    for (const field of KIT_ITEM_SOURCES) {
      expect(allocationSourceOf({ [field]: "id1", quantity: 1 })).toEqual({
        field,
        id: "id1",
      });
    }
    expect(allocationSourceOf({ label: "cash", quantity: 1 })).toBeNull();
  });

  it("treats a blank or whitespace foreign key as unset", () => {
    // Matches normalizeAmount's rule elsewhere: a cleared field is absent,
    // not a value. Without this, a "" id would key allocations as
    // "gearId:" and pool every blank line into one phantom item.
    expect(allocationSourceOf({ gearId: "   ", quantity: 1 })).toBeNull();
    expect(allocationSourceOf({ gearId: "", supplyId: "s1", quantity: 1 }))
      .toEqual({ field: "supplyId", id: "s1" });
  });

  it("agrees with allocationByItem on a row with two sources set", () => {
    // The regression this function exists to prevent. The API refuses such a
    // row, but the database does not forbid it, and the detail page groups
    // its lines by source while reading their totals out of
    // allocationByItem's map. If the page resolved "which source" any
    // differently, the line would render under one heading with the
    // allocation of another item entirely.
    const row = { gearId: "g1", supplyId: "s1", quantity: 3 };

    const source = allocationSourceOf(row);
    expect(source).toEqual({ field: "gearId", id: "g1" });

    const totals = allocationByItem([row]);
    expect(totals.size).toBe(1);
    expect(totals.get(allocationKey(source!))).toBe(3);

    // And the strict write-path rule still REFUSES it, rather than having
    // been loosened to match the read path.
    expect(resolveKitItemSource(row).ok).toBe(false);
  });

  it("builds the map key the sum was stored under", () => {
    expect(allocationKey({ field: "accessoryId", id: "a1" })).toBe(
      "accessoryId:a1",
    );
  });
});

describe("kitExpiryRollup", () => {
  const today = new Date(Date.UTC(2026, 5, 15));

  it("reports the earliest expiry and counts each state", () => {
    const rollup = kitExpiryRollup(
      [
        { expirationDate: new Date(Date.UTC(2026, 5, 1)) },
        { expirationDate: new Date(Date.UTC(2026, 6, 1)) },
        { expirationDate: null },
      ],
      today,
      90,
    );
    expect(rollup.earliest).toEqual(new Date(Date.UTC(2026, 5, 1)));
    expect(rollup.expired).toBe(1);
    expect(rollup.soon).toBe(1);
  });

  it("returns a null earliest and zero counts for a kit with no dated contents", () => {
    expect(kitExpiryRollup([{ expirationDate: null }], today, 90)).toEqual({
      earliest: null,
      expired: 0,
      soon: 0,
    });
  });

  it("counts an item expiring TODAY as soon, not expired", () => {
    // The off-by-one this epic paid for: `today` is a calendar day, and an
    // item expiring on it has not expired yet.
    const rollup = kitExpiryRollup([{ expirationDate: today }], today, 90);
    expect(rollup.expired).toBe(0);
    expect(rollup.soon).toBe(1);
  });

  it("returns an empty rollup for an empty kit", () => {
    expect(kitExpiryRollup([], today, 90)).toEqual({
      earliest: null,
      expired: 0,
      soon: 0,
    });
  });
});

describe("kitRollupHasExpiryBadges", () => {
  const rollup = (expired: number, soon: number, earliest: Date | null = null) => ({
    earliest,
    expired,
    soon,
  });

  it("is true when either count is above zero", () => {
    expect(kitRollupHasExpiryBadges(rollup(1, 0))).toBe(true);
    expect(kitRollupHasExpiryBadges(rollup(0, 1))).toBe(true);
    expect(kitRollupHasExpiryBadges(rollup(2, 3))).toBe(true);
  });

  it("is false for a kit with nothing expired or expiring", () => {
    expect(kitRollupHasExpiryBadges(rollup(0, 0))).toBe(false);
  });

  it("is false for a kit that has a date but no verdict", () => {
    // The case that mattered: a bag whose nearest expiry is years out renders
    // `exp 2030-01-01` and no EXPIRED/SOON badge, so the notice explaining
    // those badges must not appear. `earliest` is not part of the rule.
    expect(
      kitRollupHasExpiryBadges(rollup(0, 0, new Date(Date.UTC(2030, 0, 1)))),
    ).toBe(false);
  });
});
