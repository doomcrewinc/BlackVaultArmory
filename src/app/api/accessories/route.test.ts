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

  // The normalizer upper-cases internally to decide eligibility, but the column
  // used to store whatever case the caller sent — so a lower-case "suppressor"
  // kept its paperwork and then missed the Suppressors section filter, which is
  // an exact match, and fell into the Parts catch-all instead. Both halves are
  // asserted here: the stored token and the paperwork.
  it("upper-cases a lower-case type so eligibility and section placement agree", async () => {
    await POST(
      postRequest({
        name: "Quiet Can",
        type: "  suppressor  ",
        ...FULL_PAPERWORK,
      }),
    );

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.type).toBe("SUPPRESSOR");
    expect(data.nfaTransferMethod).toBe("FORM_4");
    expect(data.nfaControlNumber).toBe("12345");
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

  it("stores a blank purchasePrice as null, not 0", async () => {
    await POST(
      postRequest({
        name: "PMAG",
        type: "MAGAZINE",
        purchasePrice: "",
      }),
    );

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.purchasePrice).toBeNull();
  });

  it("stores a legitimate zero purchasePrice as 0", async () => {
    await POST(
      postRequest({
        name: "PMAG",
        type: "MAGAZINE",
        purchasePrice: 0,
      }),
    );

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.purchasePrice).toBe(0);
  });

  it.each([
    ["YES", null, null],
    ["NO", null, null],
    ["LIMITED", "5.56 NATO only", "5.56 NATO only"],
    [null, null, null],
  ])("stores the rating %s on a SUPPRESSOR", async (rating, text, storedText) => {
    await POST(
      postRequest({ name: "Can", type: "SUPPRESSOR", fullAutoRating: rating, fullAutoLimitedTo: text }),
    );

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.fullAutoRating).toBe(rating);
    expect(data.fullAutoLimitedTo).toBe(storedText);
  });

  it("stores nulls when a SUPPRESSOR is sent without either field", async () => {
    await POST(postRequest({ name: "Can", type: "SUPPRESSOR" }));

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.fullAutoRating).toBeNull();
    expect(data.fullAutoLimitedTo).toBeNull();
  });

  it("drops the text sent beside YES", async () => {
    await POST(
      postRequest({ name: "Can", type: "SUPPRESSOR", fullAutoRating: "YES", fullAutoLimitedTo: "left over" }),
    );

    expect(mocks.create.mock.calls[0][0].data.fullAutoLimitedTo).toBeNull();
  });

  it.each(["YES", "NO", "LIMITED"])("forces the rating %s and its text to null on an OPTIC", async (rating) => {
    await POST(
      postRequest({ name: "Scope", type: "OPTIC", fullAutoRating: rating, fullAutoLimitedTo: "5.56" }),
    );

    const { data } = mocks.create.mock.calls[0][0];
    expect(data.fullAutoRating).toBeNull();
    expect(data.fullAutoLimitedTo).toBeNull();
  });

  it.each([undefined, null, "", "   "])("answers 400 for LIMITED with the text %j", async (text) => {
    const response = await POST(
      postRequest({ name: "Can", type: "SUPPRESSOR", fullAutoRating: "LIMITED", fullAutoLimitedTo: text }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Say which rounds it is rated for full-auto fire with.");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([
    [{ fullAutoRating: "MAYBE" }],
    [{ fullAutoRating: true }],
    [{ fullAutoRating: "LIMITED", fullAutoLimitedTo: "a".repeat(201) }],
    [{ fullAutoRating: "LIMITED", fullAutoLimitedTo: 5 }],
  ])("answers 400 for %j", async (fields) => {
    const response = await POST(postRequest({ name: "Can", type: "SUPPRESSOR", ...fields }));

    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
