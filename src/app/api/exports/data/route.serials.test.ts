import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  appSettingsFindUnique: vi.fn(),
  firearmFindMany: vi.fn(),
  accessoryFindMany: vi.fn(),
  gearFindMany: vi.fn(),
  buildFindMany: vi.fn(),
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
    build: {
      findMany: mocks.buildFindMany,
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

// Every section that can carry a serial is on: firearms, accessories, gear and
// builds (whose slots embed a whole Accessory row).
const BASE_QUERY =
  "format=csv&firearms=true&accessories=true&gear=true&builds=true&ammo=false&rangeSessions=false&documents=false&settings=false";

// The route's GET is typed as possibly returning undefined (it falls off the end
// for a format that parseFormat already rejected), so narrow it once here rather
// than at every call site.
async function callExport(query: string): Promise<{ status: number; body: string }> {
  const response = await GET(new NextRequest(`http://localhost/api/exports/data?${query}`));
  if (!response) throw new Error("export route returned no response");
  return { status: response.status, body: await response.text() };
}

describe("/api/exports/data serial number handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({
      id: "singleton",
      includeUploadsInBackup: false,
    });

    mocks.firearmFindMany.mockResolvedValue([
      { id: "f1", name: "Duty Rifle", manufacturer: "Acme", serialNumber: "FIREARM-SERIAL-1" },
    ]);

    mocks.accessoryFindMany.mockResolvedValue([
      { id: "a1", name: "Optic", manufacturer: "DotCo", serialNumber: "ACCESSORY-SERIAL-1" },
    ]);

    mocks.gearFindMany.mockResolvedValue([
      { id: "g1", name: "Bugout", manufacturer: "Benchmade", category: "KNIFE", serialNumber: "GEAR-SERIAL-1" },
    ]);

    mocks.buildFindMany.mockResolvedValue([
      {
        id: "b1",
        name: "Patrol Build",
        firearmId: "f1",
        slots: [
          {
            id: "s1",
            buildId: "b1",
            slotType: "OPTIC",
            accessoryId: "a1",
            accessory: { id: "a1", name: "Optic", manufacturer: "DotCo", serialNumber: "ACCESSORY-SERIAL-1" },
          },
          {
            id: "s2",
            buildId: "b1",
            slotType: "GRIP",
            accessoryId: null,
            accessory: null,
          },
        ],
      },
    ]);

    mocks.documentFindMany.mockResolvedValue([]);
  });

  it("keeps an accessory serial number out of the export unless it was requested", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    expect(withoutSerials.status).toBe(200);
    // The accessory is still exported — only its serial is withheld.
    expect(withoutSerials.body).toContain("Optic");
    expect(withoutSerials.body).not.toContain("ACCESSORY-SERIAL-1");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);

    expect(withSerials.body).toContain("ACCESSORY-SERIAL-1");
  });

  it("keeps the accessory serial out of a build's embedded slot rows too", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    const buildLines = withoutSerials.body.split("\n").filter((line) => line.startsWith("builds,"));
    expect(buildLines).toHaveLength(1);
    // The slots array is JSON-stringified into the row, accessory row and all.
    expect(buildLines[0]).toContain("Patrol Build");
    expect(buildLines[0]).toContain("OPTIC");
    expect(buildLines[0]).not.toContain("ACCESSORY-SERIAL-1");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);
    const withSerialsBuildLine = withSerials.body
      .split("\n")
      .find((line) => line.startsWith("builds,"));
    expect(withSerialsBuildLine).toContain("ACCESSORY-SERIAL-1");
  });

  it("leaves an empty slot alone while stripping its neighbour", async () => {
    const { body: csv } = await callExport(BASE_QUERY);

    const buildLine = csv.split("\n").find((line) => line.startsWith("builds,"));
    // Both slots survive; only the populated one was rewritten.
    expect(buildLine).toContain("GRIP");
    expect(buildLine).toContain("OPTIC");
    expect(buildLine).not.toContain("ACCESSORY-SERIAL-1");
  });

  it("still strips firearm and gear serials, and still emits all three sections", async () => {
    const withoutSerials = await callExport(BASE_QUERY);

    expect(withoutSerials.body).not.toContain("FIREARM-SERIAL-1");
    expect(withoutSerials.body).not.toContain("GEAR-SERIAL-1");
    expect(withoutSerials.body).toContain("Duty Rifle");
    expect(withoutSerials.body).toContain("Bugout");

    const withSerials = await callExport(`${BASE_QUERY}&includeSerialNumbers=true`);

    expect(withSerials.body).toContain("FIREARM-SERIAL-1");
    expect(withSerials.body).toContain("GEAR-SERIAL-1");
  });
});
