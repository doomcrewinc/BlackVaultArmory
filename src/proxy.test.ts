import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/server/direct-access", () => ({
  getDirectAccessState: vi.fn(async () => ({ allowed: state.allowed, source: "setting" })),
}));

const auth = vi.hoisted(() => ({
  validateSession: vi.fn(),
  hasAnyUser: vi.fn(),
}));
vi.mock("@/lib/auth/sessions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/sessions")>("@/lib/auth/sessions");
  return { ...actual, validateSession: auth.validateSession };
});
vi.mock("@/lib/auth/setup-state", () => ({ hasAnyUser: auth.hasAnyUser }));

// decideAuth itself calls straight through to the real implementation by
// default — only the "hostile mocked decision" test below overrides it —
// so every other test in this file still exercises the real decision logic.
const authGate = vi.hoisted(() => ({ decideAuth: vi.fn() }));
vi.mock("@/lib/server/auth-gate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth-gate")>("@/lib/server/auth-gate");
  authGate.decideAuth.mockImplementation(actual.decideAuth);
  return { isPublicPath: actual.isPublicPath, decideAuth: authGate.decideAuth };
});

import { proxy } from "./proxy";
import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";

// The default "logged in as an admin" session — the pre-Task-6 tests below
// exercise only decideRequest's host/origin gate and expect a plain pass
// through to the app, so the auth stage they now also flow through must
// default to a state that itself passes (Review Focus #3 territory: never
// let an unrelated test accidentally assert on the auth gate).
const loggedInAdmin = { user: { id: "u1", username: "admin", displayName: "Admin", role: "ADMIN" as const }, sessionId: "s1" };

beforeEach(() => {
  process.env.PUBLIC_URL = "https://vault.example.com";
  process.env.TRUSTED_PROXIES = "10.10.10.3";
  resetPublicUrlCacheForTests();
  state.allowed = false;
  auth.validateSession.mockReset().mockResolvedValue(loggedInAdmin);
  auth.hasAnyUser.mockReset().mockResolvedValue(true);
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

  // Ordering pin (fix round 1, item 3): spec 1's host redirect must return
  // before the auth stage ever runs — a LAN host that isn't yet allowed to
  // talk to this app at all must never trigger a session lookup.
  it("never calls validateSession when spec 1 redirects a LAN host to PUBLIC_URL", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(req("http://10.10.10.3:3000/vault", { headers: { host: "10.10.10.3:3000" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://vault.example.com/vault");
    expect(auth.validateSession).not.toHaveBeenCalled();
  });
});

describe("proxy — login enforcement", () => {
  it("307s a logged-out page request to /login with the encoded next path", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(req("https://vault.example.com/vault", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://vault.example.com/login?next=%2Fvault");
  });

  it("401s a logged-out API request with the exact body", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(req("https://vault.example.com/api/firearms", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("redirects to /setup and 503s the API when no account exists yet", async () => {
    auth.hasAnyUser.mockResolvedValue(false);
    auth.validateSession.mockResolvedValue(null);

    const page = await proxy(req("https://vault.example.com/vault", { headers: { host: "vault.example.com" } }));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://vault.example.com/setup");

    const api = await proxy(req("https://vault.example.com/api/firearms", { headers: { host: "vault.example.com" } }));
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: "Setup required" });
  });

  it("rewrites a USER hitting /admin/users to /admins-only", async () => {
    auth.validateSession.mockResolvedValue({ user: { id: "u2", username: "jeff", displayName: "Jeff", role: "USER" }, sessionId: "s2" });
    const res = await proxy(req("https://vault.example.com/admin/users", { headers: { host: "vault.example.com" } }));
    expect(res.headers.get("x-middleware-rewrite")).toBe("https://vault.example.com/admins-only");
  });

  it("403s a USER hitting /api/admin/* with the exact body", async () => {
    auth.validateSession.mockResolvedValue({ user: { id: "u2", username: "jeff", displayName: "Jeff", role: "USER" }, sessionId: "s2" });
    const res = await proxy(req("https://vault.example.com/api/admin/users", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Admins only" });
  });

  it("307s a signed-in user visiting /login back to /", async () => {
    const res = await proxy(req("https://vault.example.com/login", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://vault.example.com/");
  });

  it("never calls validateSession for a public /_next/static/* asset", async () => {
    const res = await proxy(req("https://vault.example.com/_next/static/x.js", { headers: { host: "vault.example.com" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(auth.validateSession).not.toHaveBeenCalled();
  });

  it("sets bv_session to the slid token/expiry when validateSession reports a slide", async () => {
    // sessionCookie() derives Max-Age from Date.now() at call time, so the
    // clock is frozen here — otherwise the Expires header can land a second
    // off from slidTo depending on real wall-clock timing (flaky).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:00.000Z"));
    try {
      const slidTo = new Date("2026-10-27T12:00:00.000Z");
      auth.validateSession.mockResolvedValue({ ...loggedInAdmin, slidTo });
      const res = await proxy(
        req("https://vault.example.com/vault", { headers: { host: "vault.example.com", cookie: "bv_session=raw-token-abc" } }),
      );
      const setCookie = res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("bv_session=raw-token-abc");
      expect(setCookie).toContain("Expires=" + slidTo.toUTCString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a redirect's Location on the request origin even for a hostile pathname", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(req("https://vault.example.com/%5Cevil.com", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location).origin).toBe("https://vault.example.com");
  });

  // Injection proof scaffold (fix round 1, item 2): decideAuth is mocked here
  // (not the real implementation) so a hostile "//evil.com" location can
  // actually reach proxy.ts's guard — a real decideAuth call can never
  // produce this, per the investigation in the original report, so without
  // mocking here the guard is provably never exercised.
  it("keeps a mocked hostile redirect Location on the request origin, never evil.com", async () => {
    auth.validateSession.mockResolvedValue(null);
    authGate.decideAuth.mockReturnValueOnce({ kind: "redirect", location: "//evil.com" });
    const res = await proxy(req("https://vault.example.com/vault", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location") ?? "";
    expect(new URL(location).origin).toBe("https://vault.example.com");
    expect(location).not.toContain("evil.com");
  });

  // Fix round 1, item 1 (proxy half): a valid session proves an account
  // exists even if the cached hasAnyUser() is stubbornly reporting false
  // (e.g. still inside its 5s no-cache window after a fresh install).
  it("never redirects a signed-in user to /setup even when hasAnyUser() reports false", async () => {
    auth.hasAnyUser.mockResolvedValue(false);
    auth.validateSession.mockResolvedValue(loggedInAdmin);
    const res = await proxy(req("https://vault.example.com/vault", { headers: { host: "vault.example.com" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  // Fix round 1, item 5: behind the TLS reverse proxy, Next itself runs on
  // plain HTTP — request.url is http://... even though the browser is on
  // https://vault.example.com — so the redirect must be built from the
  // public URL's origin, not request.url's.
  it("builds the auth redirect from PUBLIC_URL's https origin when request.url is plain http behind the proxy", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(
      req("http://vault.example.com/vault", { headers: { host: "vault.example.com", "x-forwarded-proto": "https" } }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://vault.example.com/login?next=%2Fvault");
  });

  it("builds the auth redirect from the request's own origin for a loopback host", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(req("http://localhost:3000/vault", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fvault");
  });
});

describe("proxy — capture page marker", () => {
  const MARKER = "x-middleware-request-x-bv-capture-page";

  it("marks /capture/<token> for the root layout", async () => {
    auth.validateSession.mockResolvedValue(null);
    const res = await proxy(req("https://vault.example.com/capture/abc", { headers: { host: "vault.example.com" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get(MARKER)).toBe("1");
  });

  it("does not mark other pages, and drops a marker the client sent", async () => {
    const res = await proxy(
      req("https://vault.example.com/vault", {
        headers: { host: "vault.example.com", "x-bv-capture-page": "1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get(MARKER)).toBeNull();
    expect(res.headers.get("x-middleware-override-headers") ?? "").not.toContain("x-bv-capture-page");
  });
});
