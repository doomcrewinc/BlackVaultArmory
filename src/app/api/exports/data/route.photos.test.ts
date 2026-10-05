import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  appSettingsFindUnique: vi.fn(),
  photoFindMany: vi.fn(),
  requireAuth: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.appSettingsFindUnique },
    photo: { findMany: mocks.photoFindMany },
  },
}));

vi.mock("@/lib/server/auth", () => ({
  requireAuth: mocks.requireAuth,
}));

import { GET } from "./route";

const OTHERS_OFF =
  "firearms=false&accessories=false&gear=false&kits=false&builds=false&ammo=false&rangeSessions=false&documents=false&settings=false";

const ROW = {
  id: "ph1",
  firearmId: "f1",
  accessoryId: null,
  gearId: null,
  kitId: null,
  ammoStockId: null,
  supplyId: null,
  label: "Left side",
  width: 640,
  height: 480,
  fileSize: 12345,
  mimeType: "image/jpeg",
  viaPass: true,
  createdAt: new Date("2026-10-04T12:00:00.000Z"),
};

async function get(query: string): Promise<Response> {
  const response = await GET(new NextRequest(`http://localhost/api/exports/data?${OTHERS_OFF}&${query}`));
  if (!response) throw new Error("export route returned no response");
  return response;
}

describe("/api/exports/data photos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue(null);
    mocks.appSettingsFindUnique.mockResolvedValue({ id: "singleton", includeUploadsInBackup: false });
    mocks.photoFindMany.mockResolvedValue([ROW]);
  });

  it("asks for the gallery rows without the stored file name, and by default", async () => {
    const response = await get("format=csv");
    expect(response.status).toBe(200);
    const { select } = mocks.photoFindMany.mock.calls[0][0];
    expect(Object.keys(select).sort()).toEqual(
      ["accessoryId", "ammoStockId", "createdAt", "fileSize", "firearmId", "gearId", "height", "id", "kitId", "label", "mimeType", "supplyId", "viaPass", "width"],
    );
    expect(select).not.toHaveProperty("fileName");
  });

  it.each([
    ["csv", "\nphotos,"],
    ["pdf", "(Photos \\(1\\))"],
  ])("writes a photos section in %s", async (format, marker) => {
    const response = await get(`format=${format}`);
    expect(await response.text()).toContain(marker);
  });

  it("writes the photo row as columns in the CSV", async () => {
    const lines = (await (await get("format=csv")).text()).split("\n");
    const headers = lines[0].split(",");
    const cells = (lines.find((l) => l.startsWith("photos,")) ?? "").split(",");
    const row = Object.fromEntries(headers.map((h, i) => [h, cells[i]]));
    expect(row).toMatchObject({ id: "ph1", firearmId: "f1", label: "Left side", width: "640", viaPass: "true", mimeType: "image/jpeg" });
  });

  it("leaves photos out, and does not query them, when photos=false", async () => {
    const response = await get("format=csv&photos=false");
    expect((await response.text()).split("\n").some((l) => l.startsWith("photos,"))).toBe(false);
    expect(mocks.photoFindMany).not.toHaveBeenCalled();
  });
});
