import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  appSettingsFindUnique: vi.fn(),
  accessoryFindMany: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.appSettingsFindUnique },
    accessory: { findMany: mocks.accessoryFindMany },
  },
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: mocks.requireAuth,
}));

import { GET } from "./route";

const QUERY =
  "format=csv&firearms=false&accessories=true&gear=false&kits=false&supplies=false&builds=false&ammo=false&rangeSessions=false&documents=false&photos=false&settings=false";

describe("/api/exports/data full-auto rating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({ id: "singleton", includeUploadsInBackup: false });
  });

  async function accessoryCells(): Promise<Record<string, string>> {
    const response = await GET(new NextRequest(`http://localhost/api/exports/data?${QUERY}`));
    const lines = (await response!.text()).split("\n");
    const headers = lines[0].split(",");
    const cells = lines.find((line) => line.startsWith("accessories,"))!.split(",");
    return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
  }

  // The data export writes every stored column as stored, as it does for
  // hasBattery, so the columns hold the stored tokens or blank.
  it.each([
    ["YES", null, "YES", ""],
    ["LIMITED", "5.56 NATO only", "LIMITED", "5.56 NATO only"],
    [null, null, "", ""],
  ])("writes %s / %s as the two accessory columns", async (rating, text, ratingCell, textCell) => {
    mocks.accessoryFindMany.mockResolvedValue([
      { id: "a1", name: "Can", type: "SUPPRESSOR", fullAutoRating: rating, fullAutoLimitedTo: text },
    ]);

    const cells = await accessoryCells();

    expect(cells.fullAutoRating).toBe(ratingCell);
    expect(cells.fullAutoLimitedTo).toBe(textCell);
  });

  it("applies the formula guard to the text", async () => {
    mocks.accessoryFindMany.mockResolvedValue([
      { id: "a1", name: "Can", type: "SUPPRESSOR", fullAutoRating: "LIMITED", fullAutoLimitedTo: "=1+1" },
    ]);

    expect((await accessoryCells()).fullAutoLimitedTo).toBe("'=1+1");
  });
});
