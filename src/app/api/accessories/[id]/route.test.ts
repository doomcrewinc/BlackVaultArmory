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
    type: "MAGAZINE",
    nfaTransferMethod: null,
    nfaControlNumber: null,
    nfaApprovalDate: null,
    nfaTaxPaid: null,
    nfaRegisteredTo: null,
    ...overrides,
  };
}

const FULL_PAPERWORK = {
  nfaTransferMethod: "FORM_4",
  nfaControlNumber: "12345",
  nfaApprovalDate: "2024-03-12",
  nfaTaxPaid: 200,
  nfaRegisteredTo: "Doe Family Trust",
};

function storedSuppressor(overrides: Record<string, unknown> = {}) {
  return existingAccessory({
    type: "SUPPRESSOR",
    nfaTransferMethod: "FORM_4",
    nfaControlNumber: "12345",
    nfaApprovalDate: new Date("2024-03-12T00:00:00.000Z"),
    nfaTaxPaid: 200,
    nfaRegisteredTo: "Doe Family Trust",
    ...overrides,
  });
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

  it("stores a blank purchasePrice as null, not 0", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory());

    await PUT(putRequest({ purchasePrice: "" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.purchasePrice).toBeNull();
  });

  it("stores a legitimate zero purchasePrice as 0", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory());

    await PUT(putRequest({ purchasePrice: 0 }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.purchasePrice).toBe(0);
  });

  it("leaves purchasePrice untouched when the body doesn't mention it", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory());

    await PUT(putRequest({ name: "PMAG Gen3" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("purchasePrice");
  });
});

describe("PUT /api/accessories/[id] — NFA paperwork", () => {
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

  it("changing only notes on a stored suppressor leaves its paperwork untouched", async () => {
    mocks.findUnique.mockResolvedValue(storedSuppressor());

    await PUT(putRequest({ notes: "cleaned" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data).not.toHaveProperty("nfaTransferMethod");
    expect(data).not.toHaveProperty("nfaControlNumber");
    expect(data).not.toHaveProperty("nfaApprovalDate");
    expect(data).not.toHaveProperty("nfaTaxPaid");
    expect(data).not.toHaveProperty("nfaRegisteredTo");
  });

  it("changing type from SUPPRESSOR to OPTIC nulls the whole paperwork group, though the body names no paperwork field", async () => {
    mocks.findUnique.mockResolvedValue(storedSuppressor());

    await PUT(putRequest({ type: "OPTIC" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.type).toBe("OPTIC");
    expect(data.nfaTransferMethod).toBeNull();
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaApprovalDate).toBeNull();
    expect(data.nfaTaxPaid).toBeNull();
    expect(data.nfaRegisteredTo).toBeNull();
  });

  it("changing type to SUPPRESSOR on a non-suppressor accepts paperwork sent in the same body", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory({ type: "OPTIC" }));

    await PUT(putRequest({ type: "SUPPRESSOR", ...FULL_PAPERWORK }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.type).toBe("SUPPRESSOR");
    expect(data.nfaTransferMethod).toBe("FORM_4");
    expect(data.nfaControlNumber).toBe("12345");
    expect(data.nfaTaxPaid).toBe(200);
    expect(data.nfaRegisteredTo).toBe("Doe Family Trust");
    expect(data.nfaApprovalDate?.toISOString().slice(0, 10)).toBe("2024-03-12");
  });

  it("upper-cases a lower-case type on update, keeping eligibility and placement in step", async () => {
    mocks.findUnique.mockResolvedValue(existingAccessory({ type: "OPTIC" }));

    await PUT(putRequest({ type: "suppressor", ...FULL_PAPERWORK }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.type).toBe("SUPPRESSOR");
    expect(data.nfaTransferMethod).toBe("FORM_4");
    expect(data.nfaControlNumber).toBe("12345");
  });

  it("setting nfaTransferMethod to FORM_4473 on a suppressor clears the stamp fields but keeps the owner", async () => {
    mocks.findUnique.mockResolvedValue(storedSuppressor());

    await PUT(putRequest({ nfaTransferMethod: "FORM_4473" }), {
      params: Promise.resolve({ id: "accessory-1" }),
    });

    const { data } = mocks.update.mock.calls[0][0];
    expect(data.nfaTransferMethod).toBe("FORM_4473");
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaApprovalDate).toBeNull();
    expect(data.nfaTaxPaid).toBeNull();
    expect(data.nfaRegisteredTo).toBe("Doe Family Trust");
  });
});
