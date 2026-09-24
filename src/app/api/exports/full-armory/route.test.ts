import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirearms: vi.fn(),
  findAccessories: vi.fn(),
  findDocuments: vi.fn(),
  findAmmoStocks: vi.fn(),
  findGear: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    firearm: {
      findMany: mocks.findFirearms,
    },
    accessory: {
      findMany: mocks.findAccessories,
    },
    ammoStock: {
      findMany: mocks.findAmmoStocks,
    },
    document: {
      findMany: mocks.findDocuments,
    },
    gear: {
      findMany: mocks.findGear,
    },
  },
}));

import { GET } from "./route";

// The generated PDF draws each line as an uncompressed `(text) Tj` operator, so
// the text it actually puts on the page can be read straight back out.
function extractPdfText(pdf: string): string {
  return Array.from(pdf.matchAll(/\((.*)\) Tj/g))
    .map((match) => match[1])
    .join("\n");
}

describe("GET /api/exports/full-armory", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.findFirearms.mockResolvedValue([
      {
        id: "firearm-1",
        name: "Duty Carbine",
        manufacturer: "Acme",
        model: "M4",
        caliber: "5.56",
        serialNumber: "ABC123456",
        type: "RIFLE",
        acquisitionDate: new Date("2025-01-15T00:00:00.000Z"),
        purchasePrice: 1200,
        currentValue: 1450,
        notes: "Primary",
        imageUrl: "/api/files/images/firearms/firearm-1.jpg",
      },
    ]);

    mocks.findAccessories.mockResolvedValue([
      {
        id: "accessory-1",
        name: "Red Dot",
        manufacturer: "DotCo",
        model: "RDS-1",
        type: "OPTIC",
        caliber: null,
        acquisitionDate: null,
        purchasePrice: 200,
        notes: null,
        imageUrl: null,
      },
    ]);

    mocks.findDocuments.mockResolvedValue([
      {
        id: "doc-1",
        type: "RECEIPT",
        name: "Firearm Receipt",
        firearmId: "firearm-1",
        accessoryId: null,
        gearId: null,
        firearm: { id: "firearm-1", name: "Duty Carbine" },
        accessory: null,
        gear: null,
        mimeType: "image/jpeg",
        fileSize: 5120,
        fileUrl: "/api/files/documents/receipt-1.jpg",
        createdAt: new Date("2025-02-01T10:00:00.000Z"),
      },
    ]);

    mocks.findAmmoStocks.mockResolvedValue([
      {
        id: "ammo-1",
        brand: "Federal",
        caliber: "5.56",
        quantity: 300,
        lowStockAlert: 100,
        purchasePrice: 120,
        notes: "Training stash",
      },
    ]);

    mocks.findAmmoStocks.mockResolvedValue([
      { id: "ammo-1", caliber: "5.56", quantity: 300 },
      { id: "ammo-2", caliber: "5.56", quantity: 200 },
      { id: "ammo-3", caliber: "9mm", quantity: 120 },
    ]);

    mocks.findGear.mockResolvedValue([
      {
        id: "gear-1",
        name: "Bugout",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: "GSN-1",
        category: "KNIFE",
        quantity: 2,
        purchasePrice: 150,
        currentValue: 130,
        acquisitionDate: new Date("2025-03-01T00:00:00.000Z"),
        storageLocation: "Safe A",
        notes: "EDC",
        imageUrl: null,
      },
    ]);
  });

  it("returns JSON payload aligned with new include toggles", async () => {
    const request = new NextRequest(
      "http://localhost/api/exports/full-armory?preset=BACKUP&includeSerialNumbers=false&includeAmmo=true&includeValue=false&includeImages=false&includeDocuments=false"
    );
    const response = await GET(request);
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.meta.exportOptions).toEqual({
      preset: "BACKUP",
      includeSerialNumbers: false,
      includeAmmo: true,
      includeValue: false,
      includeImages: false,
      includeDocuments: false,
    });
    expect(json.items[0].serialNumber).toBe("");
    expect(json.items[0].imageUrl).toBe("");
    expect(json.items[0].purchasePrice).toBeNull();
    expect(json.attachments).toHaveLength(0);
    expect(json.ammo).toHaveLength(3);
    expect(json.gear).toHaveLength(1);
    expect(json.gear[0].serialNumber).toBe("");
    expect(json.gear[0].purchasePrice).toBeNull();
    expect(json.gear[0].currentValue).toBeNull();
    expect(json.summary.totalGear).toBe(1);
  });

  it("includes gear in the payload, totalItems, and the value totals", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const response = await GET(request);
    const json = await response.json();

    expect(json.gear).toEqual([
      {
        gearId: "gear-1",
        name: "Bugout",
        category: "Knife",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: "GSN-1",
        quantity: 2,
        purchasePrice: 150,
        currentValue: 130,
        acquisitionDate: "2025-03-01",
        storageLocation: "Safe A",
        receiptCount: 0,
        documentCount: 0,
        hasPhoto: false,
        imageUrl: "",
        missingSerial: false,
        missingReceipt: true,
        missingPhoto: true,
        missingValue: false,
        notes: "EDC",
      },
    ]);
    expect(json.summary.totalGear).toBe(1);
    // 1 firearm + 1 accessory + 1 gear item
    expect(json.summary.totalItems).toBe(3);
    // firearm purchase (1200) + accessory purchase (200) + gear purchase (150)
    expect(json.summary.totalPurchaseValue).toBe(1550);
    // firearm currentValue (1450) + gear currentValue (130); accessories never contribute
    expect(json.summary.totalReplacementValue).toBe(1580);
  });

  it("counts gear in every missingEvidence figure, matching totalItems", async () => {
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-1",
        name: "Bugout",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: "GSN-1",
        category: "KNIFE",
        quantity: 2,
        purchasePrice: 150,
        currentValue: 130,
        acquisitionDate: new Date("2025-03-01T00:00:00.000Z"),
        storageLocation: "Safe A",
        notes: "EDC",
        imageUrl: null,
      },
      {
        id: "gear-bare",
        name: "Nameless Case",
        manufacturer: null,
        model: null,
        serialNumber: null,
        category: "CASE",
        quantity: 1,
        purchasePrice: null,
        currentValue: null,
        acquisitionDate: null,
        storageLocation: null,
        notes: null,
        imageUrl: null,
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    // 1 firearm + 1 accessory + 2 gear
    expect(json.summary.totalItems).toBe(4);
    expect(json.summary.missingEvidence).toEqual({
      // accessory (no receipt) + both gear items (no receipt)
      missingReceipts: 3,
      // accessory (no image) + both gear items (no image)
      missingPhotos: 3,
      // gear-bare alone: no purchasePrice and no currentValue
      missingValues: 1,
      // gear-bare alone: firearm has a serial, accessories never carry one
      missingSerials: 1,
    });
  });

  it("zeroes the gear missingEvidence flags when the matching toggle is off", async () => {
    const request = new NextRequest(
      "http://localhost/api/exports/full-armory?includeSerialNumbers=false&includeValue=false&includeImages=false&includeDocuments=false"
    );
    const json = await (await GET(request)).json();

    expect(json.gear[0]).toMatchObject({
      missingSerial: false,
      missingReceipt: false,
      missingPhoto: false,
      missingValue: false,
    });
    expect(json.summary.missingEvidence).toEqual({
      missingReceipts: 0,
      missingPhotos: 0,
      missingValues: 0,
      missingSerials: 0,
    });
  });

  it("falls back to the raw category when a gear item has an unrecognised category", async () => {
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-2",
        name: "Mystery Item",
        manufacturer: null,
        model: null,
        serialNumber: null,
        category: "ARMOR",
        quantity: 1,
        purchasePrice: null,
        currentValue: null,
        acquisitionDate: null,
        storageLocation: null,
        notes: null,
        imageUrl: null,
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.gear[0].category).toBe("ARMOR");
  });

  it("exports a gear-attached document as GEAR with the gear id and name", async () => {
    mocks.findDocuments.mockResolvedValue([
      {
        id: "doc-gear-1",
        type: "RECEIPT",
        name: "Knife Receipt",
        firearmId: null,
        accessoryId: null,
        gearId: "gear-1",
        firearm: null,
        accessory: null,
        gear: { id: "gear-1", name: "Bugout" },
        mimeType: "image/jpeg",
        fileSize: 2048,
        fileUrl: "/api/files/documents/gear-receipt.jpg",
        createdAt: new Date("2025-03-02T10:00:00.000Z"),
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.attachments).toHaveLength(1);
    expect(json.attachments[0]).toMatchObject({
      documentId: "doc-gear-1",
      linkedItemType: "GEAR",
      linkedItemId: "gear-1",
      linkedItemName: "Bugout",
    });
    expect(mocks.findDocuments.mock.calls[0][0].include.gear).toEqual({
      select: { id: true, name: true },
    });
  });

  it("still reports an unlinked document as UNATTACHED", async () => {
    mocks.findDocuments.mockResolvedValue([
      {
        id: "doc-loose-1",
        type: "RECEIPT",
        name: "Loose Receipt",
        firearmId: null,
        accessoryId: null,
        gearId: null,
        firearm: null,
        accessory: null,
        gear: null,
        mimeType: "application/pdf",
        fileSize: 1024,
        fileUrl: "/api/files/documents/loose.pdf",
        createdAt: new Date("2025-03-03T10:00:00.000Z"),
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.attachments[0]).toMatchObject({
      linkedItemType: "UNATTACHED",
      linkedItemId: "",
      linkedItemName: "",
    });
  });

  it("returns 400 for unsupported format values", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory?format=json");
    const response = await GET(request);
    const json = await response.json();

    expect(response.status).toBe(400);
    expect(json.error).toContain("Supported values: csv, pdf");
  });

  it("returns downloadable CSV with structured section rows", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory?format=csv");
    const response = await GET(request);
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(csv).toContain("section");
    expect(csv).toContain("attachments");
    expect(csv).toContain("/api/files/documents/receipt-1.jpg");
    expect(csv).toContain("gear");
    expect(csv).toContain("Bugout");
  });

  it("returns PDF bytes for download format", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf&includeDocuments=false");
    const response = await GET(request);
    const pdf = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/pdf");
    expect(pdf.startsWith("%PDF-")).toBe(true);
  });

  it("renders the Gear section and its rows in the PDF text", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf");
    const response = await GET(request);
    const text = extractPdfText(await response.text());

    // Asserted on the drawn text, not just the %PDF- prefix: removing the Gear
    // block from buildExportPdfLines has to fail a test, the way the CSV
    // path's toContain("Bugout") already does.
    expect(text).toContain("Gear");
    expect(text).toContain("1. Knife Bugout | Serial: GSN-1 | Qty: 2 | Purchase: 150 | Value: 130");
    // NOTE: this guards the FIREARM branch of the attachments line, not the gear
    // one — the beforeEach document is firearm-linked. The gear branch of
    // `linkedItemName || linkedItemType` is pinned by the JSON-level GEAR test
    // above, and the expression itself is type-agnostic.
    expect(text).toContain("Linked: Duty Carbine");
  });

  it("says so in the PDF when there is no gear to report", async () => {
    mocks.findGear.mockResolvedValue([]);

    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf");
    const text = extractPdfText(await (await GET(request)).text());

    expect(text).toContain("No gear records included");
  });

  // The PDF is the one renderer where a gear photo used to be invisible: the
  // Inventory loop emits "Image Ref:" per row, the Gear loop did not. These
  // three assertions fail if that line is deleted from the Gear loop.
  it("prints the gear photo reference in the PDF exactly as inventory rows do", async () => {
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-1",
        name: "Bugout",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: "GSN-1",
        category: "KNIFE",
        quantity: 2,
        purchasePrice: 150,
        currentValue: 130,
        acquisitionDate: new Date("2025-03-01T00:00:00.000Z"),
        storageLocation: "Safe A",
        notes: "EDC",
        imageUrl: "/api/files/images/gear/gear-1.jpg",
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf");
    const text = extractPdfText(await (await GET(request)).text());

    expect(text).toContain("Image Ref: /api/files/images/gear/gear-1.jpg");
    // One for the firearm fixture, one for the gear fixture.
    expect((text.match(/Image Ref:/g) ?? []).length).toBe(2);
    // The line sits directly under its own gear row, indented, the way the
    // inventory loop places it.
    expect(text).toMatch(
      /1\. Knife Bugout \| Serial: GSN-1 \| Qty: 2 \| Purchase: 150 \| Value: 130\n\s+Image Ref: \/api\/files\/images\/gear\/gear-1\.jpg/
    );
  });

  it("prints no gear Image Ref line when the gear item has no photo", async () => {
    // The beforeEach gear fixture has imageUrl: null, so only the firearm's
    // reference may appear.
    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf");
    const text = extractPdfText(await (await GET(request)).text());

    expect(text).toContain("Image Ref: /api/files/images/firearms/firearm-1.jpg");
    expect((text.match(/Image Ref:/g) ?? []).length).toBe(1);
  });

  it("prints no gear Image Ref line in the PDF when images are excluded", async () => {
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-1",
        name: "Bugout",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: "GSN-1",
        category: "KNIFE",
        quantity: 2,
        purchasePrice: 150,
        currentValue: 130,
        acquisitionDate: new Date("2025-03-01T00:00:00.000Z"),
        storageLocation: "Safe A",
        notes: "EDC",
        imageUrl: "/api/files/images/gear/gear-1.jpg",
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf&includeImages=false");
    const text = extractPdfText(await (await GET(request)).text());

    expect(text).toContain("1. Knife Bugout");
    expect(text).not.toContain("Image Ref:");
  });

  it("returns non-empty CSV output when there is no export data", async () => {
    mocks.findFirearms.mockResolvedValue([]);
    mocks.findAccessories.mockResolvedValue([]);
    mocks.findDocuments.mockResolvedValue([]);
    mocks.findAmmoStocks.mockResolvedValue([]);
    mocks.findGear.mockResolvedValue([]);

    const request = new NextRequest("http://localhost/api/exports/full-armory?format=csv");
    const response = await GET(request);
    const csv = await response.text();

    expect(response.status).toBe(200);
    expect(csv.length).toBeGreaterThan(0);
    expect(csv).toContain("summary");
    expect(csv).toContain("generatedAt");
  });

  // ─── NFA class and paperwork ────────────────────────────────────────────
  // An SBR is a rifle by platform and an SBR by law. An insurance or claims
  // export that calls it a RIFLE misstates the one fact that matters most
  // about it, so `category` reports the class wherever a record has one.

  const documentedSbr = {
    id: "firearm-sbr",
    name: "Short Carbine",
    manufacturer: "Acme",
    model: "M4 SBR",
    caliber: "5.56",
    serialNumber: "SBR-0001",
    type: "RIFLE",
    nfaClass: "SBR",
    mgRegistry: null,
    nfaTransferMethod: "FORM_1",
    nfaControlNumber: "2024-12345",
    nfaApprovalDate: new Date("2024-06-10T00:00:00.000Z"),
    nfaTaxPaid: 200,
    nfaRegisteredTo: "Jane Q Owner",
    acquisitionDate: new Date("2025-01-15T00:00:00.000Z"),
    purchasePrice: 1200,
    currentValue: 1450,
    notes: "Primary",
    imageUrl: null,
  };

  const documentedSuppressor = {
    id: "accessory-can",
    name: "House Can",
    manufacturer: "QuietCo",
    model: "CAN-1",
    type: "SUPPRESSOR",
    caliber: "5.56",
    nfaTransferMethod: "FORM_4",
    nfaControlNumber: "SUP-98765",
    nfaApprovalDate: new Date("2025-02-20T00:00:00.000Z"),
    nfaTaxPaid: 200,
    nfaRegisteredTo: "Jane Q Owner",
    acquisitionDate: null,
    purchasePrice: 900,
    notes: null,
    imageUrl: null,
  };

  it("reports an SBR's class as its exported category, not its platform", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.items[0].category).toBe("SBR");
    expect(json.items[0].category).not.toBe("RIFLE");
  });

  it("reports a machine gun and an AOW by class, and a Title I pistol by platform", async () => {
    mocks.findFirearms.mockResolvedValue([
      { ...documentedSbr, id: "firearm-mg", type: "PDW", nfaClass: "MACHINE_GUN", mgRegistry: "TRANSFERABLE" },
      { ...documentedSbr, id: "firearm-aow", type: "SHOTGUN", nfaClass: "AOW" },
      {
        ...documentedSbr,
        id: "firearm-title1",
        type: "PISTOL",
        nfaClass: "NONE",
        nfaTransferMethod: null,
        nfaControlNumber: null,
        nfaApprovalDate: null,
        nfaTaxPaid: null,
        nfaRegisteredTo: null,
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.items.map((item: { category: string }) => item.category)).toEqual([
      "MACHINE_GUN",
      "AOW",
      "PISTOL",
      // the beforeEach accessory
      "OPTIC",
    ]);
  });

  // Prisma is mocked here, so a `select` that omits a column still returns it.
  // Without this assertion every paperwork test below would pass against a
  // query that never asks the database for the columns.
  it("asks the database for the class and paperwork columns", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory");
    await GET(request);

    expect(mocks.findFirearms.mock.calls[0][0].select).toMatchObject({
      nfaClass: true,
      nfaTransferMethod: true,
      nfaControlNumber: true,
      nfaApprovalDate: true,
      nfaTaxPaid: true,
      nfaRegisteredTo: true,
    });
    expect(mocks.findAccessories.mock.calls[0][0].select).toMatchObject({
      nfaTransferMethod: true,
      nfaControlNumber: true,
      nfaApprovalDate: true,
      nfaTaxPaid: true,
      nfaRegisteredTo: true,
    });
  });

  it("exports the five paperwork columns for a documented firearm", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.items[0]).toMatchObject({
      category: "SBR",
      nfaTransferMethod: "FORM_1",
      nfaControlNumber: "2024-12345",
      nfaApprovalDate: "2024-06-10",
      nfaTaxPaid: 200,
      nfaRegisteredTo: "Jane Q Owner",
    });
  });

  it("exports the five paperwork columns for a documented suppressor", async () => {
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.items[1]).toMatchObject({
      entityType: "ACCESSORY",
      category: "SUPPRESSOR",
      nfaTransferMethod: "FORM_4",
      nfaControlNumber: "SUP-98765",
      nfaApprovalDate: "2025-02-20",
      nfaTaxPaid: 200,
      nfaRegisteredTo: "Jane Q Owner",
    });
  });

  it("leaves the paperwork columns empty for an item with no paperwork", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.items[0]).toMatchObject({
      nfaTransferMethod: "",
      nfaControlNumber: "",
      nfaApprovalDate: "",
      nfaTaxPaid: null,
      nfaRegisteredTo: "",
    });
  });

  // The control number identifies a registered item as precisely as a serial
  // does, so it is gated behind includeSerialNumbers. The other four fields
  // are not identifiers and ride unconditionally.
  it("drops nfaControlNumber from firearm and accessory rows when serials are excluded", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const withSerials = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?includeSerialNumbers=true"))
    ).json();
    expect(withSerials.items[0].nfaControlNumber).toBe("2024-12345");
    expect(withSerials.items[1].nfaControlNumber).toBe("SUP-98765");

    const withoutSerials = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?includeSerialNumbers=false"))
    ).json();
    expect("nfaControlNumber" in withoutSerials.items[0]).toBe(false);
    expect("nfaControlNumber" in withoutSerials.items[1]).toBe(false);
    expect(JSON.stringify(withoutSerials)).not.toContain("2024-12345");
    expect(JSON.stringify(withoutSerials)).not.toContain("SUP-98765");

    // The other four survive the exclusion.
    expect(withoutSerials.items[0]).toMatchObject({
      nfaTransferMethod: "FORM_1",
      nfaApprovalDate: "2024-06-10",
      nfaTaxPaid: 200,
      nfaRegisteredTo: "Jane Q Owner",
    });
    expect(withoutSerials.items[1]).toMatchObject({
      nfaTransferMethod: "FORM_4",
      nfaApprovalDate: "2025-02-20",
      nfaTaxPaid: 200,
      nfaRegisteredTo: "Jane Q Owner",
    });
  });

  it("carries the class and paperwork into the CSV, and the control number column only with serials", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const csv = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv"))
    ).text();
    const header = csv.split("\n")[0].split(",");

    expect(header).toContain("nfaTransferMethod");
    expect(header).toContain("nfaControlNumber");
    expect(header).toContain("nfaApprovalDate");
    expect(header).toContain("nfaTaxPaid");
    expect(header).toContain("nfaRegisteredTo");
    expect(csv).toContain("SBR");
    expect(csv).toContain("2024-12345");
    expect(csv).toContain("SUP-98765");
    expect(csv).toContain("Jane Q Owner");

    const redactedCsv = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv&includeSerialNumbers=false"))
    ).text();

    // The column itself has to be gone, not blank: a header the reader can see
    // is a claim that the export covers that field.
    expect(redactedCsv.split("\n")[0].split(",")).not.toContain("nfaControlNumber");
    expect(redactedCsv).not.toContain("2024-12345");
    expect(redactedCsv).not.toContain("SUP-98765");
    expect(redactedCsv).toContain("FORM_1");
    expect(redactedCsv).toContain("Jane Q Owner");
  });

  it("prints the class and paperwork in the PDF, and never the withheld control number", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const text = extractPdfText(
      await (await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))).text()
    );

    expect(text).toContain("1. FIREARM Acme M4 SBR | Class: SBR");
    expect(text).toContain("NFA: FORM_1 | Control: 2024-12345 | Approved: 2024-06-10 | Tax: 200 | Registered To: Jane Q Owner");
    expect(text).toContain("2. ACCESSORY QuietCo CAN-1 | Class: SUPPRESSOR");
    expect(text).toContain("NFA: FORM_4 | Control: SUP-98765 | Approved: 2025-02-20 | Tax: 200 | Registered To: Jane Q Owner");

    const redacted = extractPdfText(
      await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf&includeSerialNumbers=false"))
      ).text()
    );

    expect(redacted).not.toContain("2024-12345");
    expect(redacted).not.toContain("SUP-98765");
    // The line stays, so the reader still learns the item is registered.
    expect(redacted).toContain("NFA: FORM_1 | Control: N/A | Approved: 2024-06-10 | Tax: 200 | Registered To: Jane Q Owner");
  });

  it("prints no NFA line in the PDF for an item with no paperwork", async () => {
    const text = extractPdfText(
      await (await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))).text()
    );

    expect(text).toContain("1. FIREARM Acme M4 | Class: RIFLE");
    expect(text).not.toContain("NFA:");
  });
});
