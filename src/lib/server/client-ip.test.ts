import { describe, expect, it } from "vitest";
import { getClientIp, getClientIpFromHeaders } from "./client-ip";

const trusted = { TRUSTED_PROXIES: "10.0.0.9" } as unknown as NodeJS.ProcessEnv;
const untrusted = {} as unknown as NodeJS.ProcessEnv;

function req(headers: Record<string, string>) {
  return new Request("http://127.0.0.1:3001/api/x", { headers });
}

describe("getClientIp", () => {
  it("uses the LAST X-Forwarded-For value when trusted proxies are configured", () => {
    expect(getClientIp(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" }), trusted)).toBe("10.0.0.9");
  });
  it("trims and ignores empty entries", () => {
    expect(getClientIp(req({ "x-forwarded-for": " 5.6.7.8 , " }), trusted)).toBe("5.6.7.8");
  });
  it("returns null when proxies are not trusted, whatever the headers say", () => {
    expect(getClientIp(req({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "9.9.9.9" }), untrusted)).toBeNull();
  });
  it("returns null when trusted but no header is present", () => {
    expect(getClientIp(req({}), trusted)).toBeNull();
  });
});

describe("getClientIpFromHeaders", () => {
  it("applies the same last-value rule to a bare Headers object", () => {
    expect(getClientIpFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.9" }), trusted)).toBe("10.0.0.9");
  });
  it("returns null when proxies are not trusted", () => {
    expect(getClientIpFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4" }), untrusted)).toBeNull();
  });
});
