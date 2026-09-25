import { describe, expect, it } from "vitest";
import {
  buildFullArmoryPdfModel,
  collectModelText,
  isMergeablePdf,
  toPdfSafeText,
  EMPTY_CELL,
  WITHHELD,
  type PdfBlock,
} from "@/lib/exports/full-armory-pdf-model";
import type {
  FullArmoryExportOptions,
  FullArmoryExportResponse,
} from "@/lib/exports/full-armory";

const SECRET_FIREARM_SERIAL = "ZZSERIAL-FIREARM-9911";
const SECRET_GEAR_SERIAL = "ZZSERIAL-GEAR-4422";
const SECRET_CONTROL_NUMBER = "ZZNFA-CONTROL-7733";

function options(overrides: Partial<FullArmoryExportOptions> = {}): FullArmoryExportOptions {
  return {
    preset: "CLAIMS",
    includeSerialNumbers: true,
    includeAmmo: true,
    includeValue: true,
    includeImages: true,
    includeDocuments: true,
    ...overrides,
  };
}

/**
 * A payload that carries a serial in EVERY place the schema has one, whether or
 * not the route would have blanked it.
 *
 * Built deliberately "hot": the route blanks serials server-side when the
 * toggle is off, so a fixture built the way the route would emit it could never
 * catch the renderer printing one. Handing the renderer a payload that still
 * has the serials, with the toggle off, is the only way to test that the
 * renderer itself honours the toggle rather than relying on someone upstream.
 */
function payload(overrides: Partial<FullArmoryExportResponse> = {}): FullArmoryExportResponse {
  return {
    meta: {
      generatedAt: "2026-03-04T17:05:09.123Z",
      preset: "CLAIMS",
      includesAllUploadedReceipts: true,
      exportOptions: options(),
      expiryTimezone: "America/Denver",
      expiryTimezoneFromSetting: true,
      expiryEvaluatedOn: "2026-03-04",
    },
    summary: {
      totalItems: 3,
      totalFirearms: 1,
      totalAccessories: 0,
      totalGear: 1,
      totalSupplies: 1,
      totalKits: 1,
      totalDocuments: 2,
      totalReceipts: 1,
      totalAmmoStocks: 1,
      totalPurchaseValue: 2400,
      totalReplacementValue: 2900,
      missingEvidence: { missingReceipts: 1, missingPhotos: 0, missingValues: 1, missingSerials: 0 },
    },
    items: [
      {
        itemId: "item-1",
        entityType: "FIREARM",
        category: "RIFLE",
        manufacturer: "Knight's Armament",
        model: "SR-15 Mod2 Carbine",
        caliber: "5.56 NATO",
        serialNumber: SECRET_FIREARM_SERIAL,
        hasSerial: true,
        purchaseDate: "2024-08-01",
        purchasePrice: 2400,
        replacementValue: 2900,
        receiptCount: 1,
        documentCount: 2,
        hasPhoto: true,
        imageUrl: "/uploads/images/firearms/item-1.jpg",
        missingSerial: false,
        missingReceipt: false,
        missingPhoto: false,
        missingValue: false,
        notes: "",
        nfaTransferMethod: "FORM_4",
        nfaControlNumber: SECRET_CONTROL_NUMBER,
        nfaApprovalDate: "2025-01-09",
        nfaTaxPaid: 200,
        nfaRegisteredTo: "Trust",
        nfaClass: "SBR",
      },
    ],
    attachments: [
      {
        documentId: "doc-1",
        type: "RECEIPT",
        name: "Purchase receipt",
        linkedItemId: "item-1",
        linkedItemType: "FIREARM",
        linkedItemName: "SR-15",
        mimeType: "application/pdf",
        fileSize: 12345,
        fileUrl: "/api/files/documents/receipt-1.pdf",
        uploadedAt: "2024-08-02T12:00:00.000Z",
      },
      {
        documentId: "doc-2",
        type: "PHOTO",
        name: "Left profile",
        linkedItemId: "item-1",
        linkedItemType: "FIREARM",
        linkedItemName: "SR-15",
        mimeType: "image/jpeg",
        fileSize: 4321,
        fileUrl: "/api/files/documents/photo-2.jpg",
        uploadedAt: "2024-08-02T12:05:00.000Z",
      },
    ],
    ammo: [
      {
        ammoId: "ammo-1",
        brand: "IMI",
        caliber: "5.56 NATO",
        quantity: 1200,
        lowStockAlert: 200,
        purchasePrice: 540,
        notes: "",
      },
    ],
    gear: [
      {
        gearId: "gear-1",
        name: "Front Plate",
        category: "Armor",
        manufacturer: "Hesco",
        model: "4401",
        serialNumber: SECRET_GEAR_SERIAL,
        quantity: 2,
        purchasePrice: 300,
        currentValue: 260,
        acquisitionDate: "2023-05-01",
        expirationDate: "2028-05-01",
        expiryStatus: "fine",
        protectionLevel: "NIJ III+",
        armorSize: "SAPI M",
        storageLocation: "Closet",
        receiptCount: 0,
        documentCount: 0,
        hasPhoto: false,
        imageUrl: "",
        missingSerial: false,
        missingReceipt: true,
        missingPhoto: true,
        missingValue: false,
        notes: "",
      },
    ],
    supplies: [
      {
        supplyId: "sup-1",
        name: "Chest seals",
        brand: "HyFin",
        category: "Medical",
        quantity: 4,
        unit: "ea",
        lowStockAlert: 2,
        expirationDate: "2027-02-01",
        expiryStatus: "fine",
        purchasePrice: null,
        purchaseDate: "",
        storageLocation: "IFAK",
        missingValue: true,
        notes: "",
      },
    ],
    kits: [
      {
        kitId: "kit-1",
        name: "Bugout Bag",
        category: "Bugout",
        location: "Garage",
        itemCount: 6,
        missingCount: 2,
        earliestExpiry: "2027-02-01",
        expiryStatus: "fine",
        expiredLineCount: 0,
        expiringSoonLineCount: 1,
        notes: "",
      },
    ],
    ...overrides,
  };
}

function tableRows(blocks: PdfBlock[], heading: string): string[][] {
  const headingIndex = blocks.findIndex((b) => b.kind === "heading" && b.text === heading);
  expect(headingIndex, `no "${heading}" heading in the model`).toBeGreaterThanOrEqual(0);
  const table = blocks.slice(headingIndex).find((b) => b.kind === "table");
  expect(table, `no table after "${heading}"`).toBeDefined();
  return (table as Extract<PdfBlock, { kind: "table" }>).rows;
}

describe("buildFullArmoryPdfModel — serial number toggle", () => {
  /**
   * The load-bearing test. This project has leaked serial numbers four times,
   * twice through a nested object nobody thought to check, and this renderer
   * emits inventory rows, gear rows, NFA control numbers, document names and
   * image captions — several layers of nesting each.
   *
   * So the assertion is not "the serial column is blank". It is: NO string this
   * document will print contains the serial, anywhere, at any depth. A new
   * section added later is covered the moment it is added.
   */
  it("prints no serial anywhere in the document when serials are excluded", () => {
    const model = buildFullArmoryPdfModel(payload(), options({ includeSerialNumbers: false }));
    const everything = collectModelText(model);

    for (const text of everything) {
      expect(text).not.toContain(SECRET_FIREARM_SERIAL);
      expect(text).not.toContain(SECRET_GEAR_SERIAL);
      // The NFA control number is gated behind the SAME toggle server-side,
      // because it identifies a registered item as precisely as a serial does.
      expect(text).not.toContain(SECRET_CONTROL_NUMBER);
    }

    // And the whole document, joined, still contains none of them — a guard
    // against a value being split across two adjacent strings.
    expect(everything.join("\u0000")).not.toContain(SECRET_FIREARM_SERIAL);
    expect(everything.join("\u0000")).not.toContain(SECRET_GEAR_SERIAL);
    expect(everything.join("\u0000")).not.toContain(SECRET_CONTROL_NUMBER);
  });

  it("prints the serials when they are included, so the test above can fail", () => {
    const model = buildFullArmoryPdfModel(payload(), options({ includeSerialNumbers: true }));
    const everything = collectModelText(model).join("\u0000");

    expect(everything).toContain(SECRET_FIREARM_SERIAL);
    expect(everything).toContain(SECRET_GEAR_SERIAL);
    expect(everything).toContain(SECRET_CONTROL_NUMBER);
  });

  it("says Withheld rather than a dash, so the reader is not told the item has no serial", () => {
    const model = buildFullArmoryPdfModel(payload(), options({ includeSerialNumbers: false }));
    const serialCell = tableRows(model.blocks, "Master Inventory")[0][4];

    expect(serialCell).toBe(WITHHELD);
    // A dash would contradict the Evidence Readiness block above it, which
    // reports zero missing serials for this same armory.
    expect(serialCell).not.toBe(EMPTY_CELL);
  });
});

describe("buildFullArmoryPdfModel — value toggle", () => {
  it("withholds the totals instead of printing $0 when values are excluded", () => {
    // The route zeroes both totals when includeValue is off, so printing the
    // number would tell an adjuster the armory is worthless.
    const zeroed = payload();
    zeroed.summary.totalPurchaseValue = 0;
    zeroed.summary.totalReplacementValue = 0;

    const model = buildFullArmoryPdfModel(zeroed, options({ includeValue: false }));
    const labels = model.blocks.filter((b) => b.kind === "labelValue");
    const purchase = labels.find((b) => b.label === "Total Purchase");
    const replacement = labels.find((b) => b.label === "Total Replacement");

    expect(purchase?.value).toBe(WITHHELD);
    expect(replacement?.value).toBe(WITHHELD);
    expect(tableRows(model.blocks, "Master Inventory")[0][5]).toBe(WITHHELD);
  });

  it("formats a real price and dashes a missing one when values are included", () => {
    const model = buildFullArmoryPdfModel(payload(), options());
    expect(tableRows(model.blocks, "Master Inventory")[0][5]).toBe("$2,400");
    // The supply row has a null purchasePrice: a dash, not "$0".
    expect(tableRows(model.blocks, "Supplies")[0][4]).toBe(EMPTY_CELL);
  });
});

describe("buildFullArmoryPdfModel — sections", () => {
  it("accounts for every row summary.totalItems counts", () => {
    // totalItems is firearms + accessories + gear + supplies. The renderer that
    // preceded this one printed a Master Inventory of firearms and accessories
    // only, so its cover page claimed a total its pages could not account for.
    const model = buildFullArmoryPdfModel(payload(), options());
    const counted =
      tableRows(model.blocks, "Master Inventory").length +
      tableRows(model.blocks, "Gear").length +
      tableRows(model.blocks, "Supplies").length;

    expect(counted).toBe(payload().summary.totalItems);
  });

  it("carries the expiry footnote every other renderer prints", () => {
    const model = buildFullArmoryPdfModel(payload(), options());
    const notes = model.blocks.filter((b) => b.kind === "note").map((b) => b.text);
    expect(notes.some((text) => text.includes("Expiry evaluated in America/Denver on 2026-03-04"))).toBe(
      true
    );
  });

  it("omits documents and merge targets entirely when documents are excluded", () => {
    const model = buildFullArmoryPdfModel(payload(), options({ includeDocuments: false }));
    expect(model.mergeTargets).toHaveLength(0);
    expect(model.blocks.some((b) => b.kind === "heading" && b.text === "Document Index")).toBe(false);
    expect(collectModelText(model).join("\u0000")).not.toContain("receipt-1.pdf");
  });

  it("omits the ammo summary when ammo is excluded", () => {
    const model = buildFullArmoryPdfModel(payload(), options({ includeAmmo: false }));
    expect(model.blocks.some((b) => b.kind === "heading" && b.text === "Ammo Summary")).toBe(false);
  });

  it("selects only PDF attachments to merge", () => {
    const model = buildFullArmoryPdfModel(payload(), options());
    expect(model.mergeTargets.map((t) => t.fileUrl)).toEqual(["/api/files/documents/receipt-1.pdf"]);
  });

  it("survives a completely empty armory without throwing or losing its tables", () => {
    const empty = payload({
      items: [],
      attachments: [],
      ammo: [],
      gear: [],
      supplies: [],
      kits: [],
    });
    empty.summary.totalItems = 0;

    const model = buildFullArmoryPdfModel(empty, options());
    expect(model.mergeTargets).toHaveLength(0);
    // The Master Inventory table still renders, with the empty-state line, so
    // the packet reads as "nothing here" rather than as a failed export.
    const inventory = model.blocks.find(
      (b): b is Extract<PdfBlock, { kind: "table" }> => b.kind === "table"
    );
    expect(inventory?.rows).toHaveLength(0);
    expect(inventory?.emptyText).toBe("No firearms or accessories in this export.");
    // No image blocks and therefore no appendix page break.
    expect(model.blocks.some((b) => b.kind === "image")).toBe(false);
  });
});

describe("isMergeablePdf", () => {
  it("takes any PDF, not only a RECEIPT", () => {
    // The helper this replaces demanded type === "RECEIPT" and was then OR'd
    // with a plain mime check, so the RECEIPT arm decided nothing at all.
    expect(isMergeablePdf({ mimeType: "application/pdf", fileUrl: "/a/appraisal" })).toBe(true);
    expect(isMergeablePdf({ mimeType: null, fileUrl: "/a/bill-of-sale.PDF" })).toBe(true);
    expect(isMergeablePdf({ mimeType: "image/jpeg", fileUrl: "/a/photo.jpg" })).toBe(false);
    expect(isMergeablePdf({ mimeType: "application/pdf", fileUrl: "" })).toBe(false);
  });
});

describe("toPdfSafeText", () => {
  /**
   * Verified against the library, not assumed: rendering an em-dash and an
   * ellipsis through jsPDF and reading the Tj operator back out of the bytes
   * produced "em-dash[] ellipsis[]". jsPDF drops them silently, and pdf-lib's
   * default font throws on them. Both were in the old renderer's output on
   * every null price and every truncated cell.
   */
  it("replaces the characters jsPDF silently deletes", () => {
    expect(toPdfSafeText("a—b")).toBe("a-b");
    expect(toPdfSafeText("Mod2…")).toBe("Mod2...");
    expect(toPdfSafeText("“quoted” ‘x’")).toBe('"quoted" \'x\'');
    expect(toPdfSafeText("A • B")).toBe("A - B");
  });

  it("replaces anything else outside ASCII with a visible marker rather than dropping it", () => {
    expect(toPdfSafeText("Rifle \u{1F525}")).toContain("?");
    expect(toPdfSafeText("カタ")).toBe("??");
  });

  it("flattens control characters so a cell cannot break its row", () => {
    expect(toPdfSafeText("line\nbreak\ttab")).toBe("line break tab");
  });

  it("leaves ordinary ASCII untouched", () => {
    expect(toPdfSafeText("SR-15 Mod2 (5.56 NATO) $2,400")).toBe("SR-15 Mod2 (5.56 NATO) $2,400");
  });
});
