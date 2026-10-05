import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const bytes = require("next/dist/compiled/bytes");
import nextConfig from "./next.config";

/**
 * Review round 2: this is the one thing a route-level test cannot prove —
 * next.config.ts itself is where `experimental.proxyClientMaxBodySize` is
 * set, and the value must stay at or above 64 MB (the floor the review
 * settled on after the earlier 256 MB cap proved to be an unauthenticated
 * memory-DoS vector: 4 concurrent 200 MB POSTs to /api/auth/login drove RSS
 * to ~2.6 GB). Parsed with the exact same `bytes` package Next itself uses
 * to normalise this value (node_modules/next/dist/server/config.js), not a
 * hand-rolled parser, so a change to the string format (e.g. "64mb" vs
 * "64 MB") can never silently diverge from what Next actually enforces.
 *
 * Always runs as part of `npm test` — unlike the real-server body-size test
 * (route.c1.proxy-body-size.test.ts), this needs no server, no build and no
 * scratch database, so there is no reason to gate it.
 */
describe("next.config.ts — proxyClientMaxBodySize (review C1 / round 2)", () => {
  it("is set, and parses to at least 64 MB", () => {
    const raw = nextConfig.experimental?.proxyClientMaxBodySize;
    expect(raw, "experimental.proxyClientMaxBodySize must be set").toBeDefined();

    const parsed = typeof raw === "string" ? bytes.parse(raw) : raw;
    expect(typeof parsed).toBe("number");
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });

  it("stays well under a value that would re-open the unauthenticated memory-DoS the review found", () => {
    const raw = nextConfig.experimental?.proxyClientMaxBodySize as string | number;
    const parsed = typeof raw === "string" ? bytes.parse(raw) : raw;
    // Generous headroom check, not a tight bound: anything at or above the
    // 256 MB the review flagged is the regression this guards against.
    expect(parsed).toBeLessThan(256 * 1024 * 1024);
  });
});

describe("next.config.ts — capture page headers", () => {
  it("sends Referrer-Policy: no-referrer and Cache-Control: no-store for /capture/:path*", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const rule = rules.find((r) => r.source === "/capture/:path*");
    expect(rule, "a headers rule for /capture/:path*").toBeDefined();
    const byKey = Object.fromEntries(rule!.headers.map((h) => [h.key, h.value]));
    expect(byKey["Referrer-Policy"]).toBe("no-referrer");
    expect(byKey["Cache-Control"]).toBe("no-store");
  });

  it("does not add headers to the signed-in app's pages", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    expect(rules.map((r) => r.source)).toEqual(["/capture/:path*"]);
  });
});
