import { describe, expect, it } from "vitest";
import { KIT_ITEM_SOURCES } from "@/lib/kit";
import { resolveKitItemSource } from "./kitItemSource";

describe("resolveKitItemSource", () => {
  it("accepts exactly one foreign key", () => {
    expect(resolveKitItemSource({ gearId: "g1" })).toEqual({
      ok: true,
      field: "gearId",
      id: "g1",
      label: null,
    });
  });

  it("accepts no foreign key plus a label", () => {
    expect(resolveKitItemSource({ label: "spare keys" })).toEqual({
      ok: true,
      field: null,
      id: null,
      label: "spare keys",
    });
  });

  it("rejects two foreign keys, naming both", () => {
    const result = resolveKitItemSource({ gearId: "g1", supplyId: "s1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields).toEqual(["gearId", "supplyId"]);
      expect(result.reason).toBe("multiple-sources");
    }
  });

  it("rejects a foreign key together with a label", () => {
    const result = resolveKitItemSource({ gearId: "g1", label: "spare keys" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source-and-label");
  });

  it("rejects nothing at all", () => {
    const result = resolveKitItemSource({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-source");
  });

  it("treats a blank or whitespace-only label as absent", () => {
    expect(resolveKitItemSource({ label: "   " }).ok).toBe(false);
  });

  it("treats a blank or whitespace-only foreign key as absent", () => {
    // A form field that was cleared but sent as "" (or whitespace) must not
    // count as "set" — otherwise a cleared picker field would look like a
    // real source and collide with a label or a second real source.
    expect(resolveKitItemSource({ gearId: "   ", label: "spare keys" })).toEqual(
      {
        ok: true,
        field: null,
        id: null,
        label: "spare keys",
      },
    );
  });

  it("rejects every PAIR of the five, derived rather than hand-listed", () => {
    // Derived from KIT_ITEM_SOURCES so a sixth foreign key is covered the day
    // it is added — the five-name list lives in kit.ts and nowhere else.
    for (const a of KIT_ITEM_SOURCES) {
      for (const b of KIT_ITEM_SOURCES) {
        if (a === b) continue;
        const result = resolveKitItemSource({ [a]: "x", [b]: "y" });
        expect(result.ok, `${a}+${b} was accepted`).toBe(false);
      }
    }
  });
});
