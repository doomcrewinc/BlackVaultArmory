import { describe, expect, it } from "vitest";
import {
  selectVisualEvidence,
  type FullArmoryExportOptions,
  type FullArmoryGearRow,
  type FullArmoryItemRow,
} from "./full-armory";

const OPTIONS: FullArmoryExportOptions = {
  preset: "CLAIMS",
  includeSerialNumbers: true,
  includeAmmo: true,
  includeValue: true,
  includeImages: true,
  includeDocuments: true,
};

function itemRow(
  overrides: Partial<FullArmoryItemRow> = {},
): FullArmoryItemRow {
  return {
    itemId: "firearm-1",
    entityType: "FIREARM",
    category: "RIFLE",
    manufacturer: "Acme",
    model: "M4",
    caliber: "5.56",
    serialNumber: "ABC123",
    hasSerial: true,
    purchaseDate: "2025-01-15",
    purchasePrice: 1200,
    replacementValue: 1450,
    receiptCount: 1,
    documentCount: 1,
    hasPhoto: true,
    imageUrl: "/uploads/images/firearms/firearm-1.jpg",
    missingSerial: false,
    missingReceipt: false,
    missingPhoto: false,
    missingValue: false,
    notes: "",
    ...overrides,
  };
}

function gearRow(
  overrides: Partial<FullArmoryGearRow> = {},
): FullArmoryGearRow {
  return {
    gearId: "gear-1",
    name: "Bugout",
    category: "Knife",
    manufacturer: "Benchmade",
    model: "535",
    serialNumber: "GSN-1",
    quantity: 1,
    purchasePrice: 150,
    currentValue: 130,
    acquisitionDate: "2025-03-01",
    storageLocation: "Safe A",
    receiptCount: 0,
    documentCount: 0,
    hasPhoto: true,
    imageUrl: "/uploads/images/gears/gear-1.jpg",
    missingSerial: false,
    missingReceipt: true,
    missingPhoto: false,
    missingValue: false,
    notes: "",
    ...overrides,
  };
}

describe("selectVisualEvidence", () => {
  it("includes a gear photo alongside the item photos", () => {
    const images = selectVisualEvidence(
      { items: [itemRow()], attachments: [], gear: [gearRow()] },
      OPTIONS,
    );

    expect(images.map((image) => image.id)).toEqual([
      "item:firearm-1",
      "item:gear-1",
    ]);
    expect(images[1]).toEqual({
      id: "item:gear-1",
      source: "ITEM_PHOTO",
      title: "GEAR: Benchmade Bugout",
      imageUrl: "/uploads/images/gears/gear-1.jpg",
      linkedItemId: "gear-1",
      linkedItemName: "Bugout",
    });
  });

  it("skips a gear item with no photo", () => {
    const images = selectVisualEvidence(
      {
        items: [],
        attachments: [],
        gear: [gearRow({ imageUrl: "", hasPhoto: false })],
      },
      OPTIONS,
    );

    expect(images).toEqual([]);
  });

  it("emits no gear photo when images are excluded from the export", () => {
    const images = selectVisualEvidence(
      { items: [itemRow()], attachments: [], gear: [gearRow()] },
      { ...OPTIONS, includeImages: false },
    );

    expect(images).toEqual([]);
  });

  it("tolerates a payload with no gear section at all", () => {
    const images = selectVisualEvidence(
      { items: [itemRow()], attachments: [] },
      OPTIONS,
    );

    expect(images.map((image) => image.id)).toEqual(["item:firearm-1"]);
  });
});
