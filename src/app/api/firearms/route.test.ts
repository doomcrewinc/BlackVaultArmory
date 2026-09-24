import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  findMany: vi.fn(),
  revalidateDashboardData: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    firearm: {
      create: mocks.create,
      findMany: mocks.findMany,
    },
  },
}));

vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({
  revalidateDashboardData: mocks.revalidateDashboardData,
}));

import { GET, POST } from "./route";
import { firearmWhereForSection, sectionBySlug } from "@/lib/categories";

function getRequest(query = "") {
  return new NextRequest(`http://localhost/api/firearms${query}`);
}

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/firearms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/firearms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMany.mockResolvedValue([]);
  });

  it("narrows to the section's own where fragment for ?section=handguns", async () => {
    await GET(getRequest("?section=handguns"));

    const { where } = mocks.findMany.mock.calls[0][0];
    // The registry is the single source of truth for what a section contains.
    expect(where).toEqual(
      firearmWhereForSection(sectionBySlug("handguns")!) ?? undefined,
    );
    expect(where).toEqual({
      nfaClass: "NONE",
      type: { in: ["PISTOL", "REVOLVER"] },
    });
  });

  it("applies no filter when no section is asked for", async () => {
    await GET(getRequest());

    expect(mocks.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("ignores an unknown slug rather than erroring", async () => {
    const response = await GET(getRequest("?section=zzz-not-a-section"));

    expect(response.status).toBe(200);
    expect(mocks.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("answers no firearms — not every firearm — for a gear slug", async () => {
    const response = await GET(getRequest("?section=optics"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    // A section with no firearm source must not degrade into "no filter".
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

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

  it("defaults nfaClass to NONE and nulls every paperwork/registry field when no NFA info is sent", async () => {
    await POST(postRequest({ name: "New Rifle" }));

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.nfaClass).toBe("NONE");
    expect(data.mgRegistry).toBeNull();
    expect(data.nfaTransferMethod).toBeNull();
    expect(data.nfaControlNumber).toBeNull();
    expect(data.nfaApprovalDate).toBeNull();
    expect(data.nfaTaxPaid).toBeNull();
    expect(data.nfaRegisteredTo).toBeNull();
  });

  it("stores every paperwork field for a full Form 4 SBR", async () => {
    await POST(
      postRequest({
        name: "Suppressed SBR",
        nfaClass: "SBR",
        nfaTransferMethod: "FORM_4",
        nfaControlNumber: "12345",
        nfaApprovalDate: "2024-03-12",
        nfaTaxPaid: 200,
        nfaRegisteredTo: "Doe Family Trust",
      }),
    );

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const { data } = mocks.create.mock.calls[0][0];
    expect(data.nfaClass).toBe("SBR");
    expect(data.mgRegistry).toBeNull(); // only machine guns
    expect(data.nfaTransferMethod).toBe("FORM_4");
    expect(data.nfaControlNumber).toBe("12345");
    expect(data.nfaTaxPaid).toBe(200);
    expect(data.nfaRegisteredTo).toBe("Doe Family Trust");
    expect(data.nfaApprovalDate?.toISOString().slice(0, 10)).toBe("2024-03-12");
  });
});
