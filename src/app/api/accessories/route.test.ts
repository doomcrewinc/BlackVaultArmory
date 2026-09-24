import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  roundCountLogCreate: vi.fn(),
  revalidateDashboardData: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    accessory: {
      create: mocks.create,
      findMany: mocks.findMany,
    },
    roundCountLog: {
      create: mocks.roundCountLogCreate,
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: mocks.revalidateDashboardData,
}));

import { POST } from "./route";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/accessories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const FULL_PAPERWORK = {
  nfaTransferMethod: "FORM_4",
  nfaControlNumber: "12345",
  nfaApprovalDate: "2024-03-12",
  nfaTaxPaid: 200,
  nfaRegisteredTo: "Doe Family Trust",
};

describe("POST /api/accessories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: "accessory-1",
        ...data,
      }),
    );
  });

  it("stores every paperwork field for a SUPPRESSOR with a full Form 4", async () => {
    await POST(
      postRequest({
        name: "Suppressor A",
        type: "SUPPRESSOR",
        ...FULL_PAPERWORK,
      }),
    );

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.type).toBe("SUPPRESSOR");
    expect(data.nfaTransferMethod).toBe("FORM_4");
    expect(data.nfaControlNumber).toBe("12345");
    expect(data.nfaTaxPaid).toBe(200);
    expect(data.nfaRegisteredTo).toBe("Doe Family Trust");
    expect(data.nfaApprovalDate?.toISOString().slice(0, 10)).toBe("2024-03-12");
  });

  it("nulls all five paperwork fields when type is OPTIC, even though paperwork was sent", async () => {
    await POST(
      postRequest({
        name: "Scope A",
        type: "OPTIC",
        ...FULL_PAPERWORK,
      }),
    );

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.type).toBe("OPTIC");
    expect(data.nfaTransferMethod).toBeNull();
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaApprovalDate).toBeNull();
    expect(data.nfaTaxPaid).toBeNull();
    expect(data.nfaRegisteredTo).toBeNull();
  });
});
