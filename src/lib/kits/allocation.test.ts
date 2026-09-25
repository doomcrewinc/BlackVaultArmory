import { describe, expect, it } from "vitest";
import {
  allocationByItem,
  isOverAllocated,
  kitExpiryRollup,
  missingQuantity,
} from "./allocation";

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
