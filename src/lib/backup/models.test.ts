import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  BACKUP_EXCLUDED_MODELS,
  BACKUP_MODELS,
  REQUIRED_BACKUP_KEYS,
} from "./models";

const schemaModels = Prisma.dmmf.datamodel.models;
const indexOf = (model: string) =>
  BACKUP_MODELS.findIndex((m) => m.model === model);

describe("BACKUP_MODELS registry", () => {
  it("covers every schema model exactly once, registry plus exclusions", () => {
    const registered = [
      ...BACKUP_MODELS.map((m) => m.model),
      ...BACKUP_EXCLUDED_MODELS,
    ].sort();
    const inSchema = schemaModels.map((m) => m.name).sort();
    expect(registered).toEqual(inSchema);
  });

  it("holds every model except AppSettings", () => {
    expect(BACKUP_EXCLUDED_MODELS).toEqual(["AppSettings"]);
    expect(BACKUP_MODELS).toHaveLength(schemaModels.length - 1);
  });

  it("includes the models the hand-maintained lists dropped", () => {
    const names = BACKUP_MODELS.map((m) => m.model);
    expect(names).toContain("MaintenanceLog");
    expect(names).toContain("BatteryChangeLog");
    expect(names).toContain("DateNormalizationAudit");
  });

  it("has unique models, keys, and delegates", () => {
    for (const field of ["model", "key", "delegate"] as const) {
      const values = BACKUP_MODELS.map((m) => m[field]);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  it("uses the camelCase model name as each delegate", () => {
    for (const m of BACKUP_MODELS) {
      expect(m.delegate).toBe(
        m.model.charAt(0).toLowerCase() + m.model.slice(1),
      );
    }
  });

  it.each([
    ["Firearm", "Build"],
    ["Build", "BuildSlot"],
    ["Accessory", "BuildSlot"],
    ["Firearm", "MaintenanceLog"],
    ["Accessory", "BatteryChangeLog"],
    ["RangeSession", "SessionDrill"],
    ["AmmoStock", "AmmoTransaction"],
  ])("orders %s before %s", (parent, child) => {
    expect(indexOf(parent)).toBeGreaterThanOrEqual(0);
    expect(indexOf(child)).toBeGreaterThan(indexOf(parent));
  });

  it("restores Gear before Document, because a document can point at gear", () => {
    const gearIndex = BACKUP_MODELS.findIndex(
      (entry) => entry.model === "Gear",
    );
    const documentIndex = BACKUP_MODELS.findIndex(
      (entry) => entry.model === "Document",
    );
    expect(gearIndex).toBeGreaterThanOrEqual(0);
    expect(gearIndex).toBeLessThan(documentIndex);
  });

  it("does not require gear in an older backup payload", () => {
    expect(REQUIRED_BACKUP_KEYS).not.toContain("gear");
  });

  it("does not require supplies in an older backup payload", () => {
    expect(REQUIRED_BACKUP_KEYS).not.toContain("supplies");
  });

  it("orders every schema FK parent before its child", () => {
    for (const model of schemaModels) {
      if (BACKUP_EXCLUDED_MODELS.includes(model.name)) continue;
      for (const field of model.fields) {
        if (field.kind !== "object" || !field.relationFromFields?.length)
          continue;
        expect(
          indexOf(field.type),
          `${field.type} before ${model.name}`,
        ).toBeLessThan(indexOf(model.name));
      }
    }
  });
});
