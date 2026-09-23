import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  revalidateDashboardData: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: {
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
  return new NextRequest("http://localhost/api/firearms/firearm-1", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function existingFirearm(overrides: Record<string, unknown> = {}) {
  return {
    id: "firearm-1",
    name: "Duty Carbine",
    manufacturer: "Acme",
    model: "M4",
    caliber: "5.56",
    acquisitionDate: new Date("2025-01-15T00:00:00.000Z"),
    nfaClass: "NONE",
    mgRegistry: null,
    ...overrides,
  };
}

describe("PUT /api/firearms/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...existingFirearm(),
        ...data,
        _count: { builds: 0 },
        builds: [],
      }),
    );
  });

  it("clears a stale registry when the class changes away from MACHINE_GUN", async () => {
    mocks.findUnique.mockResolvedValue(
      existingFirearm({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" }),
    );

    await PUT(putRequest({ nfaClass: "SBR" }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaClass).toBe("SBR");
    expect(data.mgRegistry).toBeNull();
  });

  it("leaves both class columns untouched when the body mentions neither", async () => {
    mocks.findUnique.mockResolvedValue(
      existingFirearm({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" }),
    );

    await PUT(putRequest({ name: "Renamed Carbine" }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("nfaClass");
    expect(data).not.toHaveProperty("mgRegistry");
  });

  it("clears the registry when explicitly nulled while the class stays MACHINE_GUN", async () => {
    mocks.findUnique.mockResolvedValue(
      existingFirearm({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" }),
    );

    await PUT(putRequest({ nfaClass: "MACHINE_GUN", mgRegistry: null }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaClass).toBe("MACHINE_GUN");
    expect(data.mgRegistry).toBeNull();
  });
});
