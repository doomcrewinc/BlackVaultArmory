import { describe, expect, it } from "vitest";
import { fieldLabel, labelFor, modelDisplayName, modelFilterLabel } from "./labels";

describe("labelFor", () => {
  it("labels a Firearm as name (caliber)", () => {
    expect(labelFor("Firearm", { id: "f1", name: "Glock 19", caliber: "9mm" })).toBe("Glock 19 (9mm)");
  });

  it("falls back to '<Model> <id>' for an unknown model", () => {
    expect(labelFor("Widget", { id: "abc123" })).toBe("Widget abc123");
  });

  it("falls back to '<Model> <id>' when the name is missing", () => {
    expect(labelFor("Firearm", { id: "f1", caliber: "9mm" })).toBe("Firearm f1");
  });

  it("labels an Accessory as name (type)", () => {
    expect(labelFor("Accessory", { id: "a1", name: "Holosun 507C", type: "OPTIC" })).toBe(
      "Holosun 507C (OPTIC)",
    );
  });

  it("labels AmmoStock as caliber and brand", () => {
    expect(labelFor("AmmoStock", { id: "s1", caliber: "9mm", brand: "Federal" })).toBe("9mm Federal");
  });

  it("labels Gear, Supply, Kit, Build and Document by name", () => {
    expect(labelFor("Gear", { id: "g1", name: "Trauma kit" })).toBe("Trauma kit");
    expect(labelFor("Supply", { id: "s1", name: "CLP" })).toBe("CLP");
    expect(labelFor("Kit", { id: "k1", name: "Bugout bag" })).toBe("Bugout bag");
    expect(labelFor("Build", { id: "b1", name: "Home defense AR" })).toBe("Home defense AR");
    expect(labelFor("Document", { id: "d1", name: "Form 4473.pdf" })).toBe("Form 4473.pdf");
  });

  it("labels a RangeSession as date and location", () => {
    expect(
      labelFor("RangeSession", {
        id: "r1",
        sessionDate: new Date("2026-05-01T00:00:00.000Z"),
        location: "Local Range",
      }),
    ).toBe("2026-05-01 – Local Range");
  });

  it("labels a MaintenanceLog by date", () => {
    expect(
      labelFor("MaintenanceLog", { id: "m1", date: new Date("2026-05-01T00:00:00.000Z") }),
    ).toBe("Maintenance 2026-05-01");
  });

  it("falls back for models with no label rule", () => {
    expect(labelFor("BuildSlot", { id: "bs1" })).toBe("BuildSlot bs1");
  });

  it("labels AppSettings as Settings, not the bare 'AppSettings singleton' fallback", () => {
    expect(labelFor("AppSettings", { id: "singleton" })).toBe("Settings");
  });
});

describe("fieldLabel", () => {
  it("humanizes a camelCase field name, lowercased", () => {
    expect(fieldLabel("serialNumber")).toBe("serial number");
    expect(fieldLabel("purchasePrice")).toBe("purchase price");
  });

  it("leaves a single-word field lowercased", () => {
    expect(fieldLabel("status")).toBe("status");
    expect(fieldLabel("notes")).toBe("notes");
  });
});

describe("modelDisplayName", () => {
  it("humanizes a PascalCase model name, lowercased", () => {
    expect(modelDisplayName("Firearm")).toBe("firearm");
    expect(modelDisplayName("AmmoStock")).toBe("ammo stock");
    expect(modelDisplayName("MaintenanceLog")).toBe("maintenance log");
    expect(modelDisplayName("RangeSessionAmmoLink")).toBe("range session ammo link");
  });
});

describe("modelFilterLabel", () => {
  it("humanizes a PascalCase model name, Title Cased — for a dropdown option, not mid-sentence prose", () => {
    expect(modelFilterLabel("Firearm")).toBe("Firearm");
    expect(modelFilterLabel("AmmoStock")).toBe("Ammo Stock");
    expect(modelFilterLabel("RangeSessionAmmoLink")).toBe("Range Session Ammo Link");
  });

  it("Title Cases User too, for the item-type filter's security-events option", () => {
    expect(modelFilterLabel("User")).toBe("User");
  });
});
