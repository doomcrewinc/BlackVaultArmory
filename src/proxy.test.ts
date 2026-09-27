import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/server/direct-access", () => ({
  getDirectAccessState: vi.fn(async () => ({ allowed: state.allowed, source: "setting" })),
}));

import { proxy } from "./proxy";
import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";

beforeEach(() => {
  process.env.PUBLIC_URL = "https://vault.example.com";
  process.env.TRUSTED_PROXIES = "10.10.10.3";
  resetPublicUrlCacheForTests();
  state.allowed = false;
});

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, init);
}

describe("proxy", () => {
  it("307s a LAN host to the public URL", async () => {
    const res = await proxy(req("http://10.10.10.3:3000/vault?x=1", { headers: { host: "10.10.10.3:3000" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://vault.example.com/vault?x=1");
  });

  it("403s a cross-origin POST with the exact JSON body", async () => {
    const res = await proxy(
      req("http://127.0.0.1:3001/api/firearms", {
        method: "POST",
        headers: { host: "vault.example.com", origin: "https://evil.example", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-origin request rejected" });
  });

  it("passes the public host and emits no CORS headers", async () => {
    const res = await proxy(
      req("http://127.0.0.1:3001/vault", {
        headers: { host: "vault.example.com", origin: "https://evil.example", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    for (const [name] of res.headers) expect(name.toLowerCase().startsWith("access-control-allow-")).toBe(false);
  });

  it("passes a LAN host when direct access is on", async () => {
    state.allowed = true;
    const res = await proxy(req("http://10.10.10.3:3000/vault", { headers: { host: "10.10.10.3:3000" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
