import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  appSettingsFindUnique: vi.fn(),
  firearmFindMany: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.appSettingsFindUnique },
    firearm: { findMany: mocks.firearmFindMany },
  },
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: mocks.requireAuth,
}));

import { GET } from "./route";

const QUERY =
  "format=csv&firearms=true&accessories=false&gear=false&kits=false&supplies=false&builds=false&ammo=false&rangeSessions=false&documents=false&settings=false";

/** The cells of the one `firearms` row, by header name. No value in these tests holds a comma or a line feed. */
async function firearmCells(): Promise<Record<string, string>> {
  const response = await GET(new NextRequest(`http://localhost/api/exports/data?${QUERY}`));
  if (!response) throw new Error("export route returned no response");
  expect(response.status).toBe(200);
  const lines = (await response.text()).split("\n");
  const headers = lines[0].split(",");
  const row = lines.find((line) => line.startsWith("firearms,"));
  if (!row) throw new Error("no firearms row");
  const cells = row.split(",");
  return Object.fromEntries(headers.map((header, i) => [header, cells[i]]));
}

/**
 * A cell that starts with = + - @, a tab or a carriage return opens as a
 * formula in a spreadsheet. Any signed-in user can type one into a name or a
 * note, and whoever opens the export would run it.
 */
describe("/api/exports/data CSV formula guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({ id: "singleton", includeUploadsInBackup: false });
  });

  it.each([
    ["=", "=1+1"],
    ["+", "+1+1"],
    ["-", "-1+1"],
    ["@", "@SUM(1)"],
    ["a tab", "\t=1+1"],
  ])("a name and a note starting with %s are written with a leading ' so they open as text", async (_name, text) => {
    mocks.firearmFindMany.mockResolvedValue([{ id: "f1", name: text, notes: text, purchasePrice: 100 }]);
    const cells = await firearmCells();
    expect(cells.name).toBe(`'${text}`);
    expect(cells.notes).toBe(`'${text}`);
  });

  it("a value starting with a carriage return is guarded and quoted", async () => {
    mocks.firearmFindMany.mockResolvedValue([{ id: "f1", name: "\r=1+1", purchasePrice: 100 }]);
    const cells = await firearmCells();
    expect(cells.name).toBe(`"'\r=1+1"`);
  });

  it("a negative number stays a number; text that only starts like one is guarded", async () => {
    mocks.firearmFindMany.mockResolvedValue([{ id: "f1", name: "-5 lbs", purchasePrice: -5, currentValue: -12.5, roundCount: 0 }]);
    const cells = await firearmCells();
    expect(cells.purchasePrice).toBe("-5");
    expect(cells.currentValue).toBe("-12.5");
    expect(cells.roundCount).toBe("0");
    expect(cells.name).toBe("'-5 lbs");
  });

  it("a value holding a bare carriage return is quoted", async () => {
    mocks.firearmFindMany.mockResolvedValue([{ id: "f1", name: "one\rtwo" }]);
    const cells = await firearmCells();
    expect(cells.name).toBe('"one\rtwo"');
  });
});
