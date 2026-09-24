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
    nfaTransferMethod: null,
    nfaControlNumber: null,
    nfaApprovalDate: null,
    nfaTaxPaid: null,
    nfaRegisteredTo: null,
    ...overrides,
  };
}

// A stored Form 4 SBR with a full paperwork record — the baseline for the
// paperwork-gate tests below.
function storedFormFourSbr(overrides: Record<string, unknown> = {}) {
  return existingFirearm({
    nfaClass: "SBR",
    mgRegistry: null,
    nfaTransferMethod: "FORM_4",
    nfaControlNumber: "12345",
    nfaApprovalDate: new Date("2024-03-12T00:00:00.000Z"),
    nfaTaxPaid: 200,
    nfaRegisteredTo: "Doe Family Trust",
    ...overrides,
  });
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

  it("treats an explicit nfaClass null as absent, never as a reset to Title I", async () => {
    mocks.findUnique.mockResolvedValue(
      existingFirearm({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" }),
    );

    await PUT(putRequest({ nfaClass: null, name: "Renamed Carbine" }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    // nfaClass is NOT NULL DEFAULT 'NONE': null has no "cleared" meaning, so
    // the stored class must survive untouched.
    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("nfaClass");
    expect(data).not.toHaveProperty("mgRegistry");
  });

  it("keeps the stored class on an explicit nfaClass null while an explicit mgRegistry null still clears", async () => {
    mocks.findUnique.mockResolvedValue(
      existingFirearm({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" }),
    );

    await PUT(putRequest({ nfaClass: null, mgRegistry: null }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaClass).toBe("MACHINE_GUN");
    expect(data.mgRegistry).toBeNull();
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

  it("leaves every paperwork field untouched when only name changes on a stored Form 4 SBR", async () => {
    mocks.findUnique.mockResolvedValue(storedFormFourSbr());

    await PUT(putRequest({ name: "Renamed SBR" }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("nfaClass");
    expect(data).not.toHaveProperty("mgRegistry");
    expect(data).not.toHaveProperty("nfaTransferMethod");
    expect(data).not.toHaveProperty("nfaControlNumber");
    expect(data).not.toHaveProperty("nfaApprovalDate");
    expect(data).not.toHaveProperty("nfaTaxPaid");
    expect(data).not.toHaveProperty("nfaRegisteredTo");
  });

  it("nulls the WHOLE group, including fields it did not mention, when nfaClass drops to NONE", async () => {
    mocks.findUnique.mockResolvedValue(storedFormFourSbr());

    await PUT(putRequest({ nfaClass: "NONE" }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaClass).toBe("NONE");
    expect(data.mgRegistry).toBeNull();
    expect(data.nfaTransferMethod).toBeNull();
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaApprovalDate).toBeNull();
    expect(data.nfaTaxPaid).toBeNull();
    expect(data.nfaRegisteredTo).toBeNull();
  });

  it("nulls control number, approval date and tax — but keeps the registered owner — on a FORM_4473 switch", async () => {
    mocks.findUnique.mockResolvedValue(storedFormFourSbr());

    await PUT(putRequest({ nfaTransferMethod: "FORM_4473" }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaClass).toBe("SBR"); // untouched, just re-derived alongside the group
    expect(data.nfaTransferMethod).toBe("FORM_4473");
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaApprovalDate).toBeNull();
    expect(data.nfaTaxPaid).toBeNull();
    expect(data.nfaRegisteredTo).toBe("Doe Family Trust");
  });

  it("clears just nfaControlNumber on an explicit null, leaving the rest of the group alone", async () => {
    mocks.findUnique.mockResolvedValue(storedFormFourSbr());

    await PUT(putRequest({ nfaControlNumber: null }), {
      params: Promise.resolve({ id: "firearm-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaClass).toBe("SBR");
    expect(data.nfaTransferMethod).toBe("FORM_4");
    expect(data.nfaApprovalDate?.toISOString().slice(0, 10)).toBe("2024-03-12");
    expect(data.nfaTaxPaid).toBe(200);
    expect(data.nfaRegisteredTo).toBe("Doe Family Trust");
  });
});
