import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/direct-access", () => ({
  getDirectAccessState: vi.fn(async () => ({ allowed: true, source: "env" })),
}));

import { GET } from "./route";

describe("GET /api/internal/gate-config", () => {
  it("returns only the effective boolean", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ allowDirectAccess: true });
  });
});
