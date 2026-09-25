import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findFirearms: vi.fn(),
  findAccessories: vi.fn(),
  findDocuments: vi.fn(),
  findAmmoStocks: vi.fn(),
  findGear: vi.fn(),
  findSupplies: vi.fn(),
  findAppSettings: vi.fn(),
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: {
      findUnique: mocks.findAppSettings,
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
    supply: {
      findMany: mocks.findSupplies,
    },
  },
}));

import { GET } from "./route";
// The renderers' own formatter, asserted against rather than a re-spelled
// literal: if the wording changes, every renderer changes with it and these
// assertions follow, while a drifted PDF or CSV line still fails.
import { formatExpiryFootnote } from "@/lib/exports/full-armory";

// The generated PDF draws each line as an uncompressed `(text) Tj` operator, so
// the text it actually puts on the page can be read straight back out. The
// backslash escapes the PDF syntax requires around parentheses are undone here,
// so a label like "Form 4 (transfer)" reads as the page shows it.
function extractPdfText(pdf: string): string {
  return Array.from(pdf.matchAll(/\((.*)\) Tj/g))
    .map((match) => match[1].replace(/\\([()\\])/g, "$1"))
    .join("\n");
}

// A paperwork line is long enough to wrap across two drawn lines, and the wrap
// indents the continuation — so an assertion about a whole logical line reads
// the text with line breaks and indentation collapsed to single spaces.
function extractPdfFlatText(pdf: string): string {
  return extractPdfText(pdf).replace(/\s+/g, " ");
}

/**
 * A CSV document parsed into rows of cells, honouring RFC-4180 quoting.
 *
 * A naive `line.split(",")` lines up with the header only while no value
 * contains a comma. The moment one does, every cell after it shifts by one and
 * a column assertion silently starts checking its NEIGHBOUR instead of
 * failing — it does not error, it just quietly asserts the wrong thing. A
 * value containing a newline is worse: it breaks the split into lines before
 * the cells are ever reached.
 *
 * Both are ordinary user input here — a gear name, a note typed into a
 * textarea — and csvEscape quotes them correctly, so the export is right and
 * only the assertion was fragile. The gear fixture in the empty-armor-cells
 * test below deliberately contains a comma AND a newline so that class of
 * false pass cannot return unnoticed.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell);
  // Guard against a trailing newline producing a phantom one-empty-cell row.
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

describe("GET /api/exports/full-armory", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.findAppSettings.mockResolvedValue(null);
    // Empty by default so the many pre-existing assertions below (totalItems,
    // totalPurchaseValue, missingEvidence, etc.) are unaffected; the supply
    // tests further down override this mock and their own expectations.
    mocks.findSupplies.mockResolvedValue([]);

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
        // A knife: no rated life, no plate rating, no cut. Each of the three
        // is EMPTY on its own, never a dash and never the string "null".
        expirationDate: "",
        expiryStatus: "none",
        protectionLevel: "",
        armorSize: "",
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
        category: "EXOSUIT",
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

    expect(json.gear[0].category).toBe("EXOSUIT");
  });

  // ─── Supplies ───────────────────────────────────────────────────────────
  // Supplies have no serial, no photo and no Document relation — unlike gear,
  // which carries all four missing* signals. Only missingValue meaningfully
  // applies. totalItems counts supplies (below) exactly as it counts gear, so
  // missingValues must count them too, for the same reason gear's fix
  // applied: a headline count and its "missing" counters must share a
  // denominator, or the preview can quote a figure computed over a narrower
  // set than the total sitting beside it. missingReceipts/missingPhotos/
  // missingSerials stay at their pre-supply values, because a supply can
  // never contribute to them.
  it("includes supplies in the payload, totalItems, totalPurchaseValue, and only the missingValues figure", async () => {
    mocks.findSupplies.mockResolvedValue([
      {
        id: "supply-1",
        name: "Iodine Tablets",
        brand: "PotableAid",
        category: "MEDICAL",
        quantity: 50,
        unit: "COUNT",
        lowStockAlert: 10,
        expirationDate: null,
        purchasePrice: 25,
        purchaseDate: new Date("2025-05-01T00:00:00.000Z"),
        storageLocation: "Pantry",
        notes: "First aid kit",
      },
      {
        id: "supply-bare",
        name: "Nameless Jug",
        brand: null,
        category: "WATER",
        quantity: 5,
        unit: "GAL",
        lowStockAlert: null,
        expirationDate: null,
        purchasePrice: null,
        purchaseDate: null,
        storageLocation: null,
        notes: null,
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.supplies).toEqual([
      {
        supplyId: "supply-1",
        name: "Iodine Tablets",
        brand: "PotableAid",
        category: "Medical",
        quantity: 50,
        unit: "Count",
        lowStockAlert: 10,
        expirationDate: "",
        expiryStatus: "none",
        purchasePrice: 25,
        purchaseDate: "2025-05-01",
        storageLocation: "Pantry",
        missingValue: false,
        notes: "First aid kit",
      },
      {
        supplyId: "supply-bare",
        name: "Nameless Jug",
        brand: "",
        category: "Water",
        quantity: 5,
        unit: "gal",
        lowStockAlert: null,
        expirationDate: "",
        expiryStatus: "none",
        purchasePrice: null,
        purchaseDate: "",
        storageLocation: "",
        missingValue: true,
        notes: "",
      },
    ]);

    // 1 firearm + 1 accessory + 1 gear (beforeEach fixtures) + 2 supplies
    expect(json.summary.totalItems).toBe(5);
    expect(json.summary.totalSupplies).toBe(2);
    // firearm (1200) + accessory (200) + gear (150) + supply-1 (25); supply-bare contributes 0
    expect(json.summary.totalPurchaseValue).toBe(1575);
    // Unaffected by supplies — no replacement-value equivalent, like accessories.
    expect(json.summary.totalReplacementValue).toBe(1580);

    expect(json.summary.missingEvidence).toEqual({
      // accessory (no receipt) + gear-1 (no receipt); supplies never contribute.
      missingReceipts: 2,
      // accessory (no image) + gear-1 (no image); supplies never contribute.
      missingPhotos: 2,
      // supply-bare alone: firearm/accessory/gear-1 all have a value.
      missingValues: 1,
      // firearm and gear-1 both have a serial, accessory never carries one,
      // and supplies never contribute.
      missingSerials: 0,
    });
  });

  it("zeroes the supply missingValue flag and nulls purchasePrice when includeValue is off", async () => {
    mocks.findSupplies.mockResolvedValue([
      {
        id: "supply-1",
        name: "Iodine Tablets",
        brand: "PotableAid",
        category: "MEDICAL",
        quantity: 50,
        unit: "COUNT",
        lowStockAlert: 10,
        expirationDate: null,
        purchasePrice: 25,
        purchaseDate: null,
        storageLocation: null,
        notes: null,
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory?includeValue=false");
    const json = await (await GET(request)).json();

    expect(json.supplies[0]).toMatchObject({
      purchasePrice: null,
      missingValue: false,
    });
    expect(json.summary.missingEvidence.missingValues).toBe(0);
    expect(json.summary.totalPurchaseValue).toBe(0);
  });

  it("falls back to the raw category and unit when a supply has an unrecognised value", async () => {
    mocks.findSupplies.mockResolvedValue([
      {
        id: "supply-odd",
        name: "Mystery Consumable",
        brand: null,
        category: "SHELTER",
        quantity: 1,
        unit: "CRATE",
        lowStockAlert: null,
        expirationDate: null,
        purchasePrice: null,
        purchaseDate: null,
        storageLocation: null,
        notes: null,
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    expect(json.supplies[0].category).toBe("SHELTER");
    expect(json.supplies[0].unit).toBe("CRATE");
  });

  it("resolves a supply's expiry status once via todayForExpiry, honoring settings.timezone and settings.expiryWarningDays", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
      mocks.findSupplies.mockResolvedValue([
        {
          id: "supply-expired",
          name: "Old Bandages",
          brand: null,
          category: "MEDICAL",
          quantity: 1,
          unit: "KIT",
          lowStockAlert: null,
          expirationDate: new Date("2026-01-01T00:00:00.000Z"),
          purchasePrice: null,
          purchaseDate: null,
          storageLocation: null,
          notes: null,
        },
        {
          id: "supply-soon",
          name: "Water Jug",
          brand: null,
          category: "WATER",
          quantity: 1,
          unit: "GAL",
          lowStockAlert: null,
          // +5 days — inside the 10-day warning window.
          expirationDate: new Date("2026-06-20T00:00:00.000Z"),
          purchasePrice: null,
          purchaseDate: null,
          storageLocation: null,
          notes: null,
        },
        {
          id: "supply-fine",
          name: "Canned Beans",
          brand: null,
          category: "FOOD",
          quantity: 1,
          unit: "COUNT",
          lowStockAlert: null,
          expirationDate: new Date("2027-01-01T00:00:00.000Z"),
          purchasePrice: null,
          purchaseDate: null,
          storageLocation: null,
          notes: null,
        },
      ]);

      const request = new NextRequest("http://localhost/api/exports/full-armory");
      const json = await (await GET(request)).json();

      expect(mocks.findAppSettings).toHaveBeenCalledWith({ where: { id: "singleton" } });
      expect(
        json.supplies.map((s: { expiryStatus: string }) => s.expiryStatus)
      ).toEqual(["expired", "soon", "fine"]);
    } finally {
      vi.useRealTimers();
    }
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
    mocks.findSupplies.mockResolvedValue([
      {
        id: "supply-1",
        name: "Iodine Tablets",
        brand: "PotableAid",
        category: "MEDICAL",
        quantity: 50,
        unit: "COUNT",
        lowStockAlert: 10,
        expirationDate: null,
        purchasePrice: 25,
        purchaseDate: null,
        storageLocation: "Pantry",
        notes: null,
      },
    ]);

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
    expect(csv).toContain("supplies");
    expect(csv).toContain("Iodine Tablets");
    expect(csv).toContain("totalSupplies");
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

  it("renders the Supplies section and its rows in the PDF text", async () => {
    mocks.findSupplies.mockResolvedValue([
      {
        id: "supply-1",
        name: "Iodine Tablets",
        brand: "PotableAid",
        category: "MEDICAL",
        quantity: 12.5,
        unit: "OZ",
        lowStockAlert: 2,
        expirationDate: null,
        purchasePrice: 25,
        purchaseDate: null,
        storageLocation: "Pantry",
        notes: "First aid kit",
      },
    ]);

    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf");
    const text = extractPdfFlatText(await (await GET(request)).text());

    // Asserted on the drawn text, not just the %PDF- prefix — removing the
    // Supplies block from buildExportPdfLines would still leave a valid PDF.
    expect(text).toContain("Supplies");
    // The decimal quantity is not floored in the PDF line either. The expiry
    // segment is ABSENT rather than reading "Expiry: N/A (none)": this supply
    // has no date, and the gear rows in the same document already said nothing
    // in that case. See expirySegment.
    expect(text).toContain(
      "1. Medical Iodine Tablets | Brand: PotableAid | Qty: 12.5 oz | Threshold: 2 | Price: 25 | Storage: Pantry"
    );
    expect(text).not.toContain("Expiry: N/A");
    expect(text).not.toContain("(none)");
  });

  it("says so in the PDF when there are no supplies to report", async () => {
    const request = new NextRequest("http://localhost/api/exports/full-armory?format=pdf");
    const text = extractPdfText(await (await GET(request)).text());

    // beforeEach leaves supplies empty by default.
    expect(text).toContain("No supply records included");
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
  // An SBR is a rifle by platform and an SBR by law, and a claims export has
  // to say both: `category` carries the platform, `nfaClass` carries the
  // class. They were one column briefly, which erased a machine gun's
  // platform and made every Title I row and every accessory read as though
  // its platform were an NFA class.

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

  it("reports an SBR's platform and its class in separate columns", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);

    const request = new NextRequest("http://localhost/api/exports/full-armory");
    const json = await (await GET(request)).json();

    // Both facts, each in its own column — neither standing in for the other.
    expect(json.items[0].category).toBe("RIFLE");
    expect(json.items[0].nfaClass).toBe("SBR");
    expect(json.items[0].nfaClass).not.toBe("RIFLE");
  });

  it("keeps the platform for a machine gun, an AOW and a Title I pistol while reporting each class", async () => {
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
      // The platform survives on every row — this is what the single column
      // erased: a select-fire PDW appeared in no renderer as a PDW.
      "PDW",
      "SHOTGUN",
      "PISTOL",
      // the beforeEach accessory
      "OPTIC",
    ]);
    expect(json.items.map((item: { nfaClass: string }) => item.nfaClass)).toEqual([
      "MACHINE_GUN",
      "AOW",
      "NONE",
      // An accessory has no class column on its model: blank, not NONE.
      "",
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
      category: "RIFLE",
      nfaClass: "SBR",
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
      nfaClass: "",
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
  // does, so it is gated behind includeSerialNumbers. The other three fields
  // are neither identifiers nor amounts and ride unconditionally.
  it("blanks nfaControlNumber but keeps its key when serials are excluded, exactly as it treats a serial", async () => {
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
    // Blanked with the key present — the same withholding mechanism the serial
    // uses, which is the rationale the gate was justified with. This pins the
    // two against each other so the asymmetry cannot come back.
    expect("nfaControlNumber" in withoutSerials.items[0]).toBe(true);
    expect("nfaControlNumber" in withoutSerials.items[1]).toBe(true);
    expect(withoutSerials.items[0].nfaControlNumber).toBe("");
    expect(withoutSerials.items[1].nfaControlNumber).toBe("");
    expect("serialNumber" in withoutSerials.items[0]).toBe(true);
    expect(withoutSerials.items[0].serialNumber).toBe("");
    expect(JSON.stringify(withoutSerials)).not.toContain("2024-12345");
    expect(JSON.stringify(withoutSerials)).not.toContain("SUP-98765");
    expect(JSON.stringify(withoutSerials)).not.toContain("SBR-0001");

    // The other three survive the exclusion, plus the tax, which travels with
    // includeValue instead.
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

  // The tax stamp is a dollar amount, so it belongs to includeValue, not to
  // includeSerialNumbers. An export that hid every purchase price and
  // replacement value while printing a $200 stamp ignored the toggle the user
  // set.
  it("withholds nfaTaxPaid when values are excluded, in every renderer", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const json = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?includeValue=false"))
    ).json();

    // Nulled, not dropped — the same treatment as the two value columns it
    // travels with.
    expect(json.items[0].nfaTaxPaid).toBeNull();
    expect(json.items[1].nfaTaxPaid).toBeNull();
    expect(json.items[0].purchasePrice).toBeNull();
    expect(json.items[0].replacementValue).toBeNull();
    expect("nfaTaxPaid" in json.items[0]).toBe(true);

    // The rest of the paperwork is not an amount and survives.
    expect(json.items[0]).toMatchObject({
      nfaTransferMethod: "FORM_1",
      nfaControlNumber: "2024-12345",
      nfaApprovalDate: "2024-06-10",
      nfaRegisteredTo: "Jane Q Owner",
    });

    const csv = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv&includeValue=false"))
    ).text();
    const header = csv.split("\n")[0].split(",");
    const taxIndex = header.indexOf("nfaTaxPaid");
    expect(taxIndex).toBeGreaterThan(-1);
    // No value on an INVENTORY row contains a comma or a newline, so a naive
    // split lines up with the header for these rows. That is no longer true of
    // the file as a whole — the gear fixture in the empty-armor-cells test
    // carries both on purpose — so the claim is scoped to the rows read here.
    // parseCsv is the safe option for anything wider.
    const inventoryRows = csv.split("\n").filter((line) => line.startsWith("inventory,"));
    expect(inventoryRows).toHaveLength(2);
    for (const row of inventoryRows) {
      expect(row.split(",")[taxIndex]).toBe("");
    }

    const pdf = extractPdfFlatText(
      await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf&includeValue=false"))
      ).text()
    );
    expect(pdf).toContain("Tax: N/A");
    expect(pdf).not.toContain("Tax: 200");
    // The line still prints, so the reader still learns the item is registered.
    expect(pdf).toContain("NFA: Form 1 (make)");
  });

  it("carries the class and paperwork into the CSV, and the control number column only with serials", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const csv = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv"))
    ).text();
    const header = csv.split("\n")[0].split(",");

    expect(header).toContain("nfaClass");
    expect(header).toContain("nfaTransferMethod");
    expect(header).toContain("nfaControlNumber");
    expect(header).toContain("nfaApprovalDate");
    expect(header).toContain("nfaTaxPaid");
    expect(header).toContain("nfaRegisteredTo");
    // Raw tokens in the CSV: machine consumers parse these, not labels.
    expect(csv).toContain("SBR");
    expect(csv).toContain("FORM_1");
    expect(csv).toContain("2024-12345");
    expect(csv).toContain("SUP-98765");
    expect(csv).toContain("Jane Q Owner");

    const redactedCsv = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv&includeSerialNumbers=false"))
    ).text();

    // The header keeps its shape between two exports of the same armory —
    // serialNumber has always stayed and been blanked, and the control number
    // now matches it rather than changing the CSV's columns.
    const redactedHeader = redactedCsv.split("\n")[0].split(",");
    expect(redactedHeader).toContain("nfaControlNumber");
    expect(redactedHeader).toContain("serialNumber");
    expect(redactedHeader).toEqual(header);
    expect(redactedCsv).not.toContain("2024-12345");
    expect(redactedCsv).not.toContain("SUP-98765");
    expect(redactedCsv).toContain("FORM_1");
    expect(redactedCsv).toContain("Jane Q Owner");
  });

  it("prints the class and paperwork in the PDF, and never the withheld control number", async () => {
    mocks.findFirearms.mockResolvedValue([documentedSbr]);
    mocks.findAccessories.mockResolvedValue([documentedSuppressor]);

    const text = extractPdfFlatText(
      await (await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))).text()
    );

    // Platform and class both printed, and the class as the label the app's
    // own detail pages show rather than the internal token.
    expect(text).toContain("1. FIREARM Acme M4 SBR | Type: RIFLE | Class: SBR");
    expect(text).toContain("NFA: Form 1 (make) | Control: 2024-12345 | Approved: 2024-06-10 | Tax: 200 | Registered To: Jane Q Owner");
    // An accessory has no NFA class, so the PDF prints no Class at all rather
    // than labelling its type one.
    expect(text).toContain("2. ACCESSORY QuietCo CAN-1 | Type: SUPPRESSOR | Serial:");
    expect(text).not.toContain("Class: SUPPRESSOR");
    expect(text).toContain("NFA: Form 4 (transfer) | Control: SUP-98765 | Approved: 2025-02-20 | Tax: 200 | Registered To: Jane Q Owner");

    const redacted = extractPdfFlatText(
      await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf&includeSerialNumbers=false"))
      ).text()
    );

    expect(redacted).not.toContain("2024-12345");
    expect(redacted).not.toContain("SUP-98765");
    // The line stays, so the reader still learns the item is registered.
    expect(redacted).toContain("NFA: Form 1 (make) | Control: N/A | Approved: 2024-06-10 | Tax: 200 | Registered To: Jane Q Owner");
  });

  it("prints no NFA line in the PDF for an item with no paperwork", async () => {
    const text = extractPdfFlatText(
      await (await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))).text()
    );

    // A Title I firearm: its platform, and no Class line at all — the old
    // single column printed "Class: RIFLE" here, which is not an NFA class.
    expect(text).toContain("1. FIREARM Acme M4 | Type: RIFLE | Serial:");
    expect(text).not.toContain("Class:");
    expect(text).not.toContain("NFA:");
  });
  // ─── Gear expiry, the armor columns and the timezone footnote ────────────

  it("exports the expiry and both armor columns, each in its own field", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
      mocks.findGear.mockResolvedValue([
        {
          id: "gear-plate",
          name: "Front Plate",
          manufacturer: "PlateCo",
          model: "III+",
          serialNumber: null,
          category: "ARMOR",
          quantity: 1,
          purchasePrice: 300,
          currentValue: 300,
          acquisitionDate: null,
          expirationDate: new Date("2026-01-01T00:00:00.000Z"),
          protectionLevel: "NIJ III+",
          armorSize: "Medium SAPI",
          storageLocation: null,
          notes: null,
          imageUrl: null,
        },
      ]);

      const json = await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory"))
      ).json();

      // Three distinct fields. The rating is NOT folded into the category —
      // that fold is what printed "Class: PISTOL" for an SBR in phase 3.
      expect(json.gear[0]).toMatchObject({
        category: "Armor",
        expirationDate: "2026-01-01",
        expiryStatus: "expired",
        protectionLevel: "NIJ III+",
        armorSize: "Medium SAPI",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves both armor cells EMPTY on a non-armor row, never a dash or \"null\"", async () => {
    mocks.findGear.mockResolvedValue([
      {
        id: "gear-knife",
        // A comma in the name and a comma AND a newline in the notes, both of
        // them ordinary user input. They are here to keep the CSV assertion
        // below honest: with them, a naive `split(",")` reads a neighbouring
        // cell instead of the one it names, and quietly passes. See parseCsv.
        name: "Bugout, Mini",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: null,
        category: "KNIFE",
        quantity: 1,
        purchasePrice: null,
        currentValue: null,
        acquisitionDate: null,
        // What the write path stores for a non-armor item: nulls.
        expirationDate: null,
        protectionLevel: null,
        armorSize: null,
        storageLocation: null,
        notes: "EDC, daily\nsecond line",
        imageUrl: null,
      },
    ]);

    const json = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory"))
    ).json();

    expect(json.gear[0].protectionLevel).toBe("");
    expect(json.gear[0].armorSize).toBe("");
    expect(json.gear[0].expirationDate).toBe("");
    expect(json.gear[0].expiryStatus).toBe("none");

    // And in the CSV, where a "null" or "—" would be read as a value by every
    // spreadsheet that opens it. Parsed with quoting honoured, not split on
    // commas — the fixture above contains a comma and a newline precisely so
    // this cannot be indexing the wrong cell.
    const csv = await (
      await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv"))
    ).text();
    const rows = parseCsv(csv);
    const headers = rows[0];
    const gearRow = rows.find((row) => row[0] === "gear");
    expect(gearRow).toBeDefined();
    for (const column of ["protectionLevel", "armorSize", "expirationDate"]) {
      const index = headers.indexOf(column);
      expect(index).toBeGreaterThan(-1);
      expect((gearRow as string[])[index]).toBe("");
    }

    // The quoted values survived the round trip intact, which is what makes
    // the cell indices above trustworthy rather than coincidentally right.
    expect((gearRow as string[])[headers.indexOf("name")]).toBe("Bugout, Mini");
    expect((gearRow as string[])[headers.indexOf("notes")]).toBe("EDC, daily\nsecond line");

    // Not ceremony: on this row the naive approach really does go wrong. The
    // newline inside `notes` truncates what `split("\n")` calls the gear
    // "line", so the cell the old assertion indexed is not even present.
    // Both sides of this come from the route's own output.
    const naiveCells = (
      csv.split("\n").find((line) => line.startsWith("gear,")) as string
    ).split(",");
    expect(naiveCells.length).toBeLessThan(headers.length);
    expect(naiveCells[headers.indexOf("protectionLevel")]).toBeUndefined();
  });

  it("resolves gear expiry against the SAME today the supply rows used", async () => {
    // 21:00 on June 15 in Denver is already the 16th in UTC. A gear row judged
    // by a second resolution of "today" would read `expired` beside a supply
    // with the identical date reading `soon`.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-16T03:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue({
        timezone: "America/Denver",
        expiryWarningDays: 90,
      });
      const expiresToday = new Date("2026-06-15T00:00:00.000Z");
      mocks.findGear.mockResolvedValue([
        {
          id: "gear-plate",
          name: "Front Plate",
          manufacturer: null,
          model: null,
          serialNumber: null,
          category: "ARMOR",
          quantity: 1,
          purchasePrice: null,
          currentValue: null,
          acquisitionDate: null,
          expirationDate: expiresToday,
          protectionLevel: "NIJ III",
          armorSize: null,
          storageLocation: null,
          notes: null,
          imageUrl: null,
        },
      ]);
      mocks.findSupplies.mockResolvedValue([
        {
          id: "supply-1",
          name: "Iodine",
          brand: null,
          category: "MEDICAL",
          quantity: 1,
          unit: "COUNT",
          lowStockAlert: null,
          expirationDate: expiresToday,
          purchasePrice: null,
          purchaseDate: null,
          storageLocation: null,
          notes: null,
        },
      ]);

      const json = await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory"))
      ).json();

      expect(json.gear[0].expiryStatus).toBe("soon");
      expect(json.supplies[0].expiryStatus).toBe("soon");
      // ONE AppSettings read for both, so the two cannot diverge.
      expect(mocks.findAppSettings).toHaveBeenCalledTimes(1);
      // And the footnote names that same day, in that same zone.
      expect(json.meta.expiryTimezone).toBe("America/Denver");
      expect(json.meta.expiryTimezoneFromSetting).toBe(true);
      expect(json.meta.expiryEvaluatedOn).toBe("2026-06-15");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints the footnote naming the configured timezone in the PDF and the CSV", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue({
        timezone: "America/Denver",
        expiryWarningDays: 90,
      });

      const json = await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory"))
      ).json();
      expect(formatExpiryFootnote(json.meta)).toBe(
        "Expiry evaluated in America/Denver on 2026-09-24.",
      );

      const pdf = extractPdfFlatText(
        await (
          await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))
        ).text(),
      );
      // Beside the generated-at line, which is where the brief asked for it.
      expect(pdf).toContain(
        "Generated: 2026-09-24T12:00:00.000Z Expiry evaluated in America/Denver on 2026-09-24.",
      );

      const csv = await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory?format=csv"))
      ).text();
      // Its own summary row, right after generatedAt. Unquoted because the
      // sentence carries no comma, quote or newline — csvEscape only quotes
      // when it must.
      expect(csv).toContain(
        "summary,expiryFootnote,Expiry evaluated in America/Denver on 2026-09-24.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the host timezone and says so when AppSettings has none", async () => {
    // The out-of-the-box state. The suite pins TZ=America/Denver, so the host
    // zone is knowable here; the point is the "(server default)" disclosure,
    // which tells the reader the zone was not chosen.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T12:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue(null);

      const json = await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory"))
      ).json();

      expect(json.meta.expiryTimezoneFromSetting).toBe(false);
      expect(json.meta.expiryTimezone).toBe("America/Denver");
      expect(formatExpiryFootnote(json.meta)).toBe(
        "Expiry evaluated in America/Denver (server default) on 2026-09-24.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints the gear expiry and armor values as labelled segments in the PDF", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
      mocks.findGear.mockResolvedValue([
        {
          id: "gear-plate",
          name: "Front Plate",
          manufacturer: "PlateCo",
          model: "III+",
          serialNumber: null,
          category: "ARMOR",
          quantity: 1,
          purchasePrice: 300,
          currentValue: 300,
          acquisitionDate: null,
          expirationDate: new Date("2026-01-01T00:00:00.000Z"),
          protectionLevel: "NIJ III+",
          armorSize: "Medium SAPI",
          storageLocation: null,
          notes: null,
          imageUrl: null,
        },
      ]);

      const text = extractPdfFlatText(
        await (
          await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))
        ).text(),
      );

      expect(text).toContain("Expires: 2026-01-01 (expired)");
      expect(text).toContain("Protection: NIJ III+");
      expect(text).toContain("Size/Cut: Medium SAPI");
    } finally {
      vi.useRealTimers();
    }
  });

  it("prints no armor or expiry segments in the PDF for a knife", async () => {
    const text = extractPdfFlatText(
      await (
        await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))
      ).text(),
    );

    // The default fixture is a knife. "Protection: N/A" on every knife and
    // case would double the page count to say nothing, the same reason the NFA
    // line is printed only for registered items.
    expect(text).toContain("1. Knife Bugout | Serial: GSN-1 | Qty: 2");
    expect(text).not.toContain("Protection:");
    expect(text).not.toContain("Size/Cut:");
    expect(text).not.toContain("Expires:");
  });
  it("prints ONE expiry convention across the gear and supply blocks of the same document", async () => {
    // The two blocks had drifted into opposite conventions: gear omitted the
    // segment where supplies printed "Expiry: N/A (none)". This asserts on both
    // blocks of a single rendered document, because the inconsistency is only
    // visible when you read them together — either block alone looked fine.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));

    try {
      mocks.findAppSettings.mockResolvedValue({ timezone: "UTC", expiryWarningDays: 10 });
      mocks.findGear.mockResolvedValue([
        {
          id: "gear-dateless", name: "Plain Knife", manufacturer: "Benchmade", model: "535",
          serialNumber: null, category: "KNIFE", quantity: 1, purchasePrice: null,
          currentValue: null, acquisitionDate: null, expirationDate: null,
          protectionLevel: null, armorSize: null, storageLocation: null, notes: null, imageUrl: null,
        },
        {
          id: "gear-dated", name: "Front Plate", manufacturer: "PlateCo", model: "III+",
          serialNumber: null, category: "ARMOR", quantity: 1, purchasePrice: null,
          currentValue: null, acquisitionDate: null,
          expirationDate: new Date("2026-01-01T00:00:00.000Z"),
          protectionLevel: null, armorSize: null, storageLocation: null, notes: null, imageUrl: null,
        },
      ]);
      mocks.findSupplies.mockResolvedValue([
        {
          id: "supply-dateless", name: "Bandages", brand: null, category: "MEDICAL", quantity: 1,
          unit: "KIT", lowStockAlert: null, expirationDate: null, purchasePrice: null,
          purchaseDate: null, storageLocation: null, notes: null,
        },
        {
          id: "supply-dated", name: "Canned Beans", brand: null, category: "FOOD", quantity: 1,
          unit: "COUNT", lowStockAlert: null,
          expirationDate: new Date("2026-01-01T00:00:00.000Z"),
          purchasePrice: null, purchaseDate: null, storageLocation: null, notes: null,
        },
      ]);

      const text = extractPdfFlatText(
        await (
          await GET(new NextRequest("http://localhost/api/exports/full-armory?format=pdf"))
        ).text(),
      );

      // Both dated rows print the segment, under the SAME label.
      const expiresSegments = text.match(/Expires: 2026-01-01 \(expired\)/g) ?? [];
      expect(expiresSegments).toHaveLength(2);
      // Neither dateless row prints anything: no placeholder, no "(none)", and
      // not the old supplies-only "Expiry:" label either.
      expect(text).not.toContain("Expiry:");
      expect(text).not.toContain("N/A (none)");
      expect(text).not.toContain("(none)");
      // The dateless rows are still on the page — only the segment is gone.
      expect(text).toContain("Plain Knife");
      expect(text).toContain("Bandages");
    } finally {
      vi.useRealTimers();
    }
  });
});
