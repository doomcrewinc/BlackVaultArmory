import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  appSettingsFindUnique: vi.fn(),
  firearmFindMany: vi.fn(),
  accessoryFindMany: vi.fn(),
  gearFindMany: vi.fn(),
  documentFindMany: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: {
      findUnique: mocks.appSettingsFindUnique,
    },
    firearm: {
      findMany: mocks.firearmFindMany,
    },
    accessory: {
      findMany: mocks.accessoryFindMany,
    },
    gear: {
      findMany: mocks.gearFindMany,
    },
    document: {
      findMany: mocks.documentFindMany,
    },
  },
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: mocks.requireAuth,
}));

import { GET } from "./route";

// Firearms and accessories stay on so the gear assertions are made against a
// realistic multi-section export, not a gear-only one.
const BASE_QUERY =
  "format=csv&firearms=true&accessories=true&gear=true&builds=false&ammo=false&rangeSessions=false&documents=true&settings=false";

// The generated PDF draws each line as an uncompressed `(text) Tj` operator, so
// the text it actually puts on the page can be read straight back out. Literal
// parentheses and backslashes are escaped on the way in, so undo that.
function extractPdfText(pdf: string): string {
  return Array.from(pdf.matchAll(/\((.*)\) Tj/g))
    .map((match) => match[1].replace(/\\([()\\])/g, "$1"))
    .join("\n");
}

// The route's GET is typed as possibly returning undefined (it falls off the end
// for a format that parseFormat already rejected), so narrow it once here rather
// than at every call site.
async function callExport(query: string): Promise<{ status: number; body: string }> {
  const response = await GET(new NextRequest(`http://localhost/api/exports/data?${query}`));
  if (!response) throw new Error("export route returned no response");
  return { status: response.status, body: await response.text() };
}

function gearRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "g1",
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
    imageUrl: "/api/files/images/gear/g1_1.webp",
    imageSource: "UPLOAD",
    createdAt: new Date("2025-03-01T00:00:00.000Z"),
    updatedAt: new Date("2025-03-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("/api/exports/data gear section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({
      id: "singleton",
      includeUploadsInBackup: true,
    });

    mocks.firearmFindMany.mockResolvedValue([
      {
        id: "f1",
        name: "Duty Rifle",
        imageUrl: "/api/files/images/firearms/f1_1.webp",
        serialNumber: "SER123",
      },
    ]);

    mocks.accessoryFindMany.mockResolvedValue([
      {
        id: "a1",
        name: "Optic",
        imageUrl: "/api/files/images/accessory/a1_1.webp",
      },
    ]);

    mocks.gearFindMany.mockResolvedValue([gearRow()]);

    mocks.documentFindMany.mockResolvedValue([
      {
        id: "d1",
        name: "Knife Receipt",
        type: "RECEIPT",
        fileUrl: "/api/files/documents/d1.pdf",
        firearmId: null,
        accessoryId: null,
        gearId: "g1",
        firearm: null,
        accessory: null,
        gear: { id: "g1", name: "Bugout" },
      },
    ]);
  });

  it("writes a gear section into the CSV alongside firearms and accessories", async () => {
    const { status, body: csv } = await callExport(BASE_QUERY);

    expect(status).toBe(200);
    const gearLines = csv.split("\n").filter((line) => line.startsWith("gear,"));
    expect(gearLines).toHaveLength(1);
    expect(gearLines[0]).toContain("Bugout");
    expect(gearLines[0]).toContain("KNIFE");
    expect(gearLines[0]).toContain("Safe A");
    // The section flag rides in the meta row the way every other section does.
    expect(csv).toContain("sections.gear");
  });

  it("queries gear once, sequentially, with a deterministic order", async () => {
    await callExport(BASE_QUERY);

    expect(mocks.gearFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.gearFindMany.mock.calls[0][0]).toEqual({
      orderBy: [{ category: "asc" }, { manufacturer: "asc" }, { name: "asc" }],
    });
  });

  it("gives a gear-attached document the gear's identity, not a bare id", async () => {
    const { body: csv } = await callExport(BASE_QUERY);

    // Load-bearing: the mock returns whatever it is handed, so the include is
    // what proves the route asks Prisma for the gear relation at all.
    expect(mocks.documentFindMany.mock.calls[0][0].include.gear).toEqual({
      select: { id: true, name: true },
    });
    const documentLines = csv.split("\n").filter((line) => line.startsWith("documents,"));
    expect(documentLines).toHaveLength(1);
    expect(documentLines[0]).toContain("Bugout");
    expect(csv).toContain("gear.name");
    expect(csv).toContain("gear.id");
  });

  it("omits gear entirely when the gear section is turned off", async () => {
    const { status, body: csv } = await callExport(BASE_QUERY.replace("gear=true", "gear=false"));

    expect(status).toBe(200);
    expect(mocks.gearFindMany).not.toHaveBeenCalled();
    expect(csv.split("\n").some((line) => line.startsWith("gear,"))).toBe(false);
    // "Safe A" only ever comes from a gear inventory row. The gear *name* is not
    // asserted absent: a document's linked-item identity survives its section
    // being off, exactly as a firearm's does when firearms=false.
    expect(csv).not.toContain("Safe A");
    expect(csv).not.toContain("gearImage");
  });

  it("strips the gear serial number unless serial numbers were requested", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    expect(withoutSerials.body).toContain("Bugout");
    expect(withoutSerials.body).not.toContain("GSN-1");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);

    expect(withSerials.body).toContain("GSN-1");
  });

  it("emits a gearImage upload reference with its storage path", async () => {
    const { body: csv } = await callExport(BASE_QUERY);

    const referenceLines = csv.split("\n").filter((line) => line.startsWith("uploadedAssetReferences,"));
    const gearReference = referenceLines.find((line) => line.includes("gearImage"));
    expect(gearReference).toBeDefined();
    expect(gearReference).toContain("/api/files/images/gear/g1_1.webp");
    expect(gearReference).toContain("storage/uploads/images/gear/g1_1.webp");
  });

  it("drops an unsafe gear image URL from the upload references", async () => {
    mocks.gearFindMany.mockResolvedValue([gearRow({ imageUrl: "/api/files/../../etc/passwd" })]);

    const { body: csv } = await callExport(BASE_QUERY);

    const referenceLines = csv.split("\n").filter((line) => line.startsWith("uploadedAssetReferences,"));
    expect(referenceLines.some((line) => line.includes("gearImage"))).toBe(false);
    expect(referenceLines.some((line) => line.includes("etc/passwd"))).toBe(false);
  });

  it("prints a Gear section in the PDF", async () => {
    const { body: pdf } = await callExport(
      `${BASE_QUERY.replace("format=csv", "format=pdf")}&includeSerialNumbers=true`
    );
    const text = extractPdfText(pdf);

    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("Gear (1)");
    expect(text).toContain("name: Bugout");
    expect(text).toContain("serialNumber: GSN-1");
  });

  it("says there are no gear records in the PDF when gear is empty", async () => {
    mocks.gearFindMany.mockResolvedValue([]);

    const { body: pdf } = await callExport(BASE_QUERY.replace("format=csv", "format=pdf"));
    const text = extractPdfText(pdf);

    expect(text).toContain("Gear (0)");
    expect(text).toContain("No records");
  });
});
