import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = {
  findUnique: vi.fn(),
  stockUpdate: vi.fn(),
  transactionCreate: vi.fn(),
  transaction: vi.fn(),
  revalidateDashboardData: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ammoStock: {
      findUnique: (args: unknown) => mocks.findUnique(args),
      update: (args: unknown) => mocks.stockUpdate(args),
    },
    ammoTransaction: {
      create: (args: unknown) => mocks.transactionCreate(args),
    },
    $transaction: (ops: unknown[]) => mocks.transaction(ops),
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: () => mocks.revalidateDashboardData(),
}));

import { POST } from "./route";

const params = Promise.resolve({ id: "a1" });

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/ammo/a1/transactions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const stock = {
  id: "a1",
  caliber: "9mm",
  brand: "Federal",
  quantity: 500,
};

describe("POST /api/ammo/[id]/transactions", () => {
  beforeEach(() => {
    mocks.findUnique.mockReset().mockResolvedValue(stock);
    mocks.stockUpdate.mockReset().mockResolvedValue({ ...stock, quantity: 600 });
    mocks.transactionCreate.mockReset().mockResolvedValue({ id: "t1" });
    mocks.transaction
      .mockReset()
      .mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops));
    mocks.revalidateDashboardData.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stores a blank purchasePrice and pricePerRound as null, not 0", async () => {
    await POST(
      postRequest({
        type: "PURCHASE",
        quantity: 100,
        purchasePrice: "",
        pricePerRound: " ",
      }) as never,
      { params } as never,
    );

    const data = mocks.transactionCreate.mock.calls[0][0].data;
    expect(data.purchasePrice).toBeNull();
    expect(data.pricePerRound).toBeNull();
  });

  it("stores a legitimate zero purchasePrice and pricePerRound as 0", async () => {
    await POST(
      postRequest({
        type: "PURCHASE",
        quantity: 100,
        purchasePrice: 0,
        pricePerRound: 0,
      }) as never,
      { params } as never,
    );

    const data = mocks.transactionCreate.mock.calls[0][0].data;
    expect(data.purchasePrice).toBe(0);
    expect(data.pricePerRound).toBe(0);
  });
});
