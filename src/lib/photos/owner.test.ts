import { describe, expect, it } from "vitest";
import { isPhotoEntityType, ownerOf, ownerWhere } from "./owner";

const NONE = {
  firearmId: null,
  accessoryId: null,
  gearId: null,
  kitId: null,
  ammoStockId: null,
  supplyId: null,
};

describe("photo owner helper", () => {
  it.each([
    ["firearm", { firearmId: "a1" }],
    ["accessory", { accessoryId: "a1" }],
    ["gear", { gearId: "a1" }],
    ["kit", { kitId: "a1" }],
    ["ammo", { ammoStockId: "a1" }],
    ["supply", { supplyId: "a1" }],
  ] as const)("maps %s to its owner column, both ways", (type, where) => {
    expect(ownerWhere(type, "a1")).toEqual(where);
    expect(ownerOf({ ...NONE, ...where })).toEqual({ type, id: "a1" });
  });

  it("throws when two owner columns are set", () => {
    expect(() => ownerOf({ ...NONE, gearId: "g", kitId: "k" })).toThrow();
  });

  it("throws when no owner column is set", () => {
    expect(() => ownerOf(NONE)).toThrow();
  });

  it.each([
    ["build", false],
    ["ammo", true],
    [undefined, false],
    [3, false],
  ])("isPhotoEntityType(%s) is %s", (value, expected) => {
    expect(isPhotoEntityType(value)).toBe(expected);
  });
});
