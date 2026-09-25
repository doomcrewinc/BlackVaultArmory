import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findMany: vi.fn(),
  create: vi.fn(),
  appSettingsFindUnique: vi.fn(),
  revalidateDashboardData: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ammoStock: {
      findMany: (args: unknown) => mocks.findMany(args),
      create: (args: unknown) => mocks.create(args),
    },
    appSettings: {
      findUnique: (args: unknown) => mocks.appSettingsFindUnique(args),
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: () => mocks.revalidateDashboardData(),
}));

import { POST } from "./route";

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/ammo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ammo", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue({ id: "a1" });
    mocks.appSettingsFindUnique.mockReset().mockResolvedValue(null);
    mocks.revalidateDashboardData.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("requires caliber and brand", async () => {
    const response = await POST(
      postRequest({ caliber: "9mm" }) as never,
    );
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("stores a blank purchasePrice and pricePerRound as null, not 0", async () => {
    await POST(
      postRequest({
        caliber: "9mm",
        brand: "Federal",
        purchasePrice: "",
        pricePerRound: " ",
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.purchasePrice).toBeNull();
    expect(data.pricePerRound).toBeNull();
  });

  it("stores a legitimate zero purchasePrice and pricePerRound as 0", async () => {
    await POST(
      postRequest({
        caliber: "9mm",
        brand: "Federal",
        purchasePrice: 0,
        pricePerRound: 0,
      }) as never,
    );
    const data = mocks.create.mock.calls[0][0].data;
    expect(data.purchasePrice).toBe(0);
    expect(data.pricePerRound).toBe(0);
  });
});
