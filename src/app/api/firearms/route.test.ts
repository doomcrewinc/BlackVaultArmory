import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  revalidateDashboardData: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: {
      create: mocks.create,
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: mocks.revalidateDashboardData,
}));

import { POST } from "./route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/firearms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/firearms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "firearm-1",
        ...data,
        acquisitionDate: new Date("2026-09-22T00:00:00.000Z"),
        _count: { builds: 0 },
        rangeSessions: [],
      }),
    );
  });

  it("defaults nfaClass to NONE and mgRegistry to null when no class info is sent", async () => {
    await POST(postRequest({ name: "New Rifle" }));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.nfaClass).toBe("NONE");
    expect(data.mgRegistry).toBeNull();
  });
});
