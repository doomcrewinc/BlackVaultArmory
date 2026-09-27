import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ allowed: false, source: "setting" as "env" | "setting" }));
vi.mock("@/lib/server/direct-access", () => ({ getDirectAccessState: vi.fn(async () => ({ ...state })) }));
vi.mock("@/lib/network/get-local-ip", () => ({ getLocalIp: () => "10.10.10.3", isDockerEnvironment: () => true }));

import { GET } from "./route";
import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";

beforeEach(() => {
  process.env.PUBLIC_URL = "https://vault.example.com";
  resetPublicUrlCacheForTests();
});

describe("GET /api/network/local-access", () => {
  it("reports the public URL and the direct-access state", async () => {
    state.allowed = true;
    state.source = "env";
    const body = await (await GET()).json();
    expect(body.publicUrl).toBe("https://vault.example.com");
    expect(body.directAccess).toEqual({ allowed: true, source: "env" });
    expect(body.url).toBe("http://10.10.10.3:3000");
  });
});
