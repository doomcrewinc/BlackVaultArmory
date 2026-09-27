import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ allowed: false, source: "setting" as "env" | "setting" }));
vi.mock("@/lib/server/direct-access", () => ({ getDirectAccessState: vi.fn(async () => ({ ...state })) }));
vi.mock("@/lib/network/get-local-ip", () => ({ getLocalIp: () => "10.10.10.3", isDockerEnvironment: () => true }));

import { GET } from "./route";
import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";

const savedPort = { PORT: process.env.PORT, GATE_PORT: process.env.GATE_PORT };

beforeEach(() => {
  process.env.PUBLIC_URL = "https://vault.example.com";
  resetPublicUrlCacheForTests();
  delete process.env.PORT;
  delete process.env.GATE_PORT;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedPort)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

  // In the container the gate owns the public port and sets PORT=3001 for
  // Next (container-internal, never published). The LAN URL and QR code must
  // show the gate's port, which it records as GATE_PORT.
  it("uses GATE_PORT over PORT (the gate's public port, not Next's 3001)", async () => {
    process.env.GATE_PORT = "3000";
    process.env.PORT = "3001";
    const body = await (await GET()).json();
    expect(body.port).toBe("3000");
    expect(body.url).toBe("http://10.10.10.3:3000");
  });

  it("falls back to PORT without the gate (npm run dev / next start)", async () => {
    process.env.PORT = "4123";
    const body = await (await GET()).json();
    expect(body.port).toBe("4123");
    expect(body.url).toBe("http://10.10.10.3:4123");
  });

  it("falls back to 3000 when neither is set", async () => {
    const body = await (await GET()).json();
    expect(body.port).toBe("3000");
  });
});
