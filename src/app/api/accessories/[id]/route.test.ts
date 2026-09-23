import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  revalidateDashboardData: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessory: {
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: mocks.revalidateDashboardData,
}));

import { PUT } from "./route";

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/accessories/accessory-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function existingAccessory(overrides: Record<string, unknown> = {}) {
  return {
    id: "accessory-1",
    name: "PMAG",
    manufacturer: "Magpul",
    quantity: 12,
    ...overrides,
  };
}

describe("PUT /api/accessories/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...existingAccessory(),
        ...data,
        roundCountLogs: [],
        buildSlots: [],
      }),
    );
  });

  it("keeps the stored quantity when a blank string is sent (not a silent reset to 1)", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory({ quantity: 12 }));

    await PUT(putRequest({ quantity: "" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const { data } = mocks.update.mock.calls[0][0];
    expect(data.quantity).toBe(12);
  });

  it("leaves quantity untouched when the body doesn't mention it", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory({ quantity: 12 }));

    await PUT(putRequest({ name: "PMAG Gen3" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("quantity");
  });
});
