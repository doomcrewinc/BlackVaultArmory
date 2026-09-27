import { describe, expect, it } from "vitest";
import { parsePublicUrl } from "./public-url";
import { decideRequest, isSecureRequest, trustsForwardedHeaders, type GateInput } from "./request-gate";

const publicUrl = parsePublicUrl("https://vault.example.com");

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    method: "GET",
    pathname: "/vault",
    search: "",
    host: "vault.example.com",
    forwardedHost: null,
    forwardedProto: null,
    origin: null,
    requestProtocol: "http:",
    publicUrl,
    directAccessAllowed: false,
    trustForwardedHeaders: true,
    ...overrides,
  };
}

describe("decideRequest — host routing", () => {
  it("passes the public host", () => {
    expect(decideRequest(input())).toEqual({ kind: "pass" });
  });

  it("matches the host case-insensitively", () => {
    expect(decideRequest(input({ host: "VAULT.Example.com" }))).toEqual({ kind: "pass" });
  });

  it("treats an explicit default port as the public host (no redirect loop)", () => {
    expect(decideRequest(input({ host: "vault.example.com:443", forwardedProto: "https" }))).toEqual({ kind: "pass" });
  });

  it("passes the public host with default HTTPS port when no X-Forwarded-Proto (proxy missing header)", () => {
    expect(decideRequest(input({ host: "vault.example.com:443", forwardedProto: null, trustForwardedHeaders: true }))).toEqual({ kind: "pass" });
  });

  it("passes the public host with default HTTPS port when X-Forwarded-Proto is not trusted", () => {
    expect(decideRequest(input({ host: "vault.example.com:443", forwardedProto: null, trustForwardedHeaders: false }))).toEqual({ kind: "pass" });
  });

  it("redirects a LAN IP with default HTTPS port (not public host)", () => {
    expect(decideRequest(input({ host: "10.10.10.3:443" }))).toMatchObject({ kind: "redirect" });
  });

  it("redirects a LAN IP with 307-style location, keeping path and query", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", pathname: "/vault/abc", search: "?tab=docs" }))).toEqual({
      kind: "redirect",
      location: "https://vault.example.com/vault/abc?tab=docs",
    });
  });

  it("never redirects off the public host for a protocol-relative path", () => {
    const d = decideRequest(input({ host: "10.10.10.3:3000", pathname: "//evil.com/x" }));
    expect(d).toEqual({ kind: "redirect", location: "https://vault.example.com//evil.com/x" });
    if (d.kind === "redirect") expect(new URL(d.location).host).toBe("vault.example.com");
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "localhost"])("passes loopback host %s", (host) => {
    expect(decideRequest(input({ host }))).toEqual({ kind: "pass" });
  });

  it("passes any host when direct access is allowed", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", directAccessAllowed: true }))).toEqual({ kind: "pass" });
  });

  it("exempts /api/health", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", pathname: "/api/health" }))).toEqual({ kind: "pass" });
  });

  it("uses the first X-Forwarded-Host when forwarded headers are trusted", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", forwardedHost: "vault.example.com, proxy.lan" }))).toEqual({
      kind: "pass",
    });
  });

  it("ignores X-Forwarded-Host when forwarded headers are not trusted", () => {
    expect(
      decideRequest(input({ host: "10.10.10.3:3000", forwardedHost: "vault.example.com", trustForwardedHeaders: false })),
    ).toMatchObject({ kind: "redirect" });
  });

  it("redirects a request with no Host at all", () => {
    expect(decideRequest(input({ host: null }))).toMatchObject({ kind: "redirect" });
  });
});

describe("decideRequest — origin check", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("rejects a cross-origin %s", (method) => {
    expect(decideRequest(input({ method, origin: "https://evil.example" }))).toEqual({
      kind: "forbidden",
      reason: "Cross-origin request rejected",
    });
  });

  it("rejects Origin: null", () => {
    expect(decideRequest(input({ method: "POST", origin: "null" }))).toMatchObject({ kind: "forbidden" });
  });

  it("passes a same-origin POST via the proxy", () => {
    expect(decideRequest(input({ method: "POST", origin: "https://vault.example.com" }))).toEqual({ kind: "pass" });
  });

  it("passes a POST with no Origin header (not a browser)", () => {
    expect(decideRequest(input({ method: "POST", origin: null }))).toEqual({ kind: "pass" });
  });

  it("does not origin-check GET", () => {
    expect(decideRequest(input({ method: "GET", origin: "https://evil.example" }))).toEqual({ kind: "pass" });
  });

  it("passes a POST from the page's own direct origin when direct access is on", () => {
    expect(
      decideRequest(
        input({ method: "POST", host: "10.10.10.3:3000", origin: "http://10.10.10.3:3000", directAccessAllowed: true }),
      ),
    ).toEqual({ kind: "pass" });
  });

  it("passes a POST from localhost's own origin", () => {
    expect(decideRequest(input({ method: "POST", host: "localhost:3000", origin: "http://localhost:3000" }))).toEqual({
      kind: "pass",
    });
  });

  it("rejects a POST whose origin is a different LAN host", () => {
    expect(
      decideRequest(
        input({ method: "POST", host: "10.10.10.3:3000", origin: "http://10.10.10.9:3000", directAccessAllowed: true }),
      ),
    ).toMatchObject({ kind: "forbidden" });
  });
});

describe("trustsForwardedHeaders", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["   ", false],
    ["10.10.10.3", true],
  ])("TRUSTED_PROXIES=%s -> %s", (value, expected) => {
    expect(trustsForwardedHeaders({ TRUSTED_PROXIES: value } as unknown as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("isSecureRequest", () => {
  const trusted = { TRUSTED_PROXIES: "10.10.10.3" } as unknown as NodeJS.ProcessEnv;
  it("reads X-Forwarded-Proto when trusted", () => {
    const r = new Request("http://127.0.0.1:3001/api/x", { headers: { "x-forwarded-proto": "https" } });
    expect(isSecureRequest(r, trusted)).toBe(true);
  });
  it("ignores X-Forwarded-Proto when untrusted", () => {
    const r = new Request("http://127.0.0.1:3001/api/x", { headers: { "x-forwarded-proto": "https" } });
    expect(isSecureRequest(r, {} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it("uses the first value of a list", () => {
    const r = new Request("http://127.0.0.1:3001/api/x", { headers: { "x-forwarded-proto": "http, https" } });
    expect(isSecureRequest(r, trusted)).toBe(false);
  });
});
