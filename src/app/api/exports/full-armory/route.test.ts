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
});
