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

  describe("full-auto rating", () => {
    const params = { params: Promise.resolve({ id: "accessory-1" }) };

    function dataOfUpdate() {
      return mocks.update.mock.calls[0][0].data;
    }

    it.each([
      ["YES", null, null],
      ["NO", null, null],
      ["LIMITED", " 5.56 NATO only ", "5.56 NATO only"],
      [null, null, null],
    ])("stores %s on a suppressor", async (rating, text, storedText) => {
      mocks.findUnique.mockResolvedValue(storedSuppressor());

      const response = await PUT(putRequest({ fullAutoRating: rating, fullAutoLimitedTo: text }), params);

      expect(response.status).toBe(200);
      expect(dataOfUpdate().fullAutoRating).toBe(rating);
      expect(dataOfUpdate().fullAutoLimitedTo).toBe(storedText);
    });

    it.each(["YES", "NO", "LIMITED"])("forces %s to null for a non-suppressor type", async (rating) => {
      mocks.findUnique.mockResolvedValue(existingAccessory());

      await PUT(putRequest({ fullAutoRating: rating, fullAutoLimitedTo: "5.56" }), params);

      expect(dataOfUpdate().fullAutoRating).toBeNull();
      expect(dataOfUpdate().fullAutoLimitedTo).toBeNull();
    });

    it.each(["YES", "NO", "LIMITED"])("clears both when a stored %s suppressor changes type", async (rating) => {
      mocks.findUnique.mockResolvedValue(
        storedSuppressor({ fullAutoRating: rating, fullAutoLimitedTo: rating === "LIMITED" ? "5.56" : null }),
      );

      await PUT(putRequest({ type: "OPTIC" }), params);

      expect(dataOfUpdate().fullAutoRating).toBeNull();
      expect(dataOfUpdate().fullAutoLimitedTo).toBeNull();
    });

    it("clears the text when a Limited rating changes to Yes", async () => {
      mocks.findUnique.mockResolvedValue(storedSuppressor({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));

      await PUT(putRequest({ fullAutoRating: "YES" }), params);

      expect(dataOfUpdate().fullAutoRating).toBe("YES");
      expect(dataOfUpdate().fullAutoLimitedTo).toBeNull();
    });

    it("applies the rule to the resulting row when only the rating changes to Limited", async () => {
      mocks.findUnique.mockResolvedValue(storedSuppressor({ fullAutoRating: "YES" }));

      const response = await PUT(putRequest({ fullAutoRating: "LIMITED" }), params);

      expect(response.status).toBe(400);
      expect(mocks.update).not.toHaveBeenCalled();
    });

    it("keeps the stored rating when only the text changes", async () => {
      mocks.findUnique.mockResolvedValue(storedSuppressor({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));

      await PUT(putRequest({ fullAutoLimitedTo: "9mm only" }), params);

      expect(dataOfUpdate().fullAutoRating).toBe("LIMITED");
      expect(dataOfUpdate().fullAutoLimitedTo).toBe("9mm only");
    });

    it("keeps both when the type is re-sent as SUPPRESSOR", async () => {
      mocks.findUnique.mockResolvedValue(storedSuppressor({ fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56" }));

      await PUT(putRequest({ type: "SUPPRESSOR" }), params);

      expect(dataOfUpdate().fullAutoRating).toBe("LIMITED");
      expect(dataOfUpdate().fullAutoLimitedTo).toBe("5.56");
    });

    it("leaves both alone when the write names neither field nor the type", async () => {
      mocks.findUnique.mockResolvedValue(storedSuppressor({ fullAutoRating: "YES" }));

      await PUT(putRequest({ notes: "n" }), params);

      expect(dataOfUpdate()).not.toHaveProperty("fullAutoRating");
      expect(dataOfUpdate()).not.toHaveProperty("fullAutoLimitedTo");
    });

    it.each([
      [{ fullAutoRating: "LIMITED", fullAutoLimitedTo: "" }, "Say which rounds it is rated for full-auto fire with."],
      [{ fullAutoRating: "LIMITED" }, "Say which rounds it is rated for full-auto fire with."],
      [{ fullAutoRating: "MAYBE" }, "fullAutoRating must be YES, NO, LIMITED or null"],
      [{ fullAutoRating: "LIMITED", fullAutoLimitedTo: "a".repeat(201) }, "at most 200"],
    ])("answers 400 for %j", async (fields, message) => {
      mocks.findUnique.mockResolvedValue(storedSuppressor());

      const response = await PUT(putRequest(fields), params);

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(message);
      expect(mocks.update).not.toHaveBeenCalled();
    });
  });
});
