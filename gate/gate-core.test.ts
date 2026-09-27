import { describe, expect, it } from "vitest";
import { buildMatcher, isLoopback, normalizePeer, parseTrustedProxies } from "./gate-core.mjs";

describe("normalizePeer", () => {
  it.each([
    ["::ffff:10.10.10.3", "10.10.10.3"],
    ["::FFFF:10.10.10.3", "10.10.10.3"],
    ["10.10.10.3", "10.10.10.3"],
    ["::1", "::1"],
    ["fe80::1", "fe80::1"],
    [undefined, null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePeer(input)).toBe(expected);
  });
});

describe("isLoopback", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.5.5.5", true],
    ["::1", true],
    ["10.10.10.3", false],
    ["172.31.0.1", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isLoopback(ip)).toBe(expected);
  });
});

describe("parseTrustedProxies", () => {
  it("sorts entries by kind and reports junk", () => {
    expect(parseTrustedProxies(" 10.10.10.3, 172.28.0.0/16 ,caddy, fd00::/8, 10.0.0.0/33, bad host!, ,")).toEqual({
      ips: ["10.10.10.3"],
      cidrs: [
        { address: "172.28.0.0", prefix: 16, family: "ipv4" },
        { address: "fd00::", prefix: 8, family: "ipv6" },
      ],
      hostnames: ["caddy"],
      invalid: ["10.0.0.0/33", "bad host!"],
    });
  });

  it("treats undefined and blank as empty", () => {
    expect(parseTrustedProxies(undefined)).toEqual({ ips: [], cidrs: [], hostnames: [], invalid: [] });
    expect(parseTrustedProxies("  ")).toEqual({ ips: [], cidrs: [], hostnames: [], invalid: [] });
  });
});

describe("buildMatcher", () => {
  const parsed = parseTrustedProxies("10.10.10.3, 172.28.0.0/16, fd00::/8, caddy");

  it("matches exact IPs, CIDR members and resolved host names", () => {
    const match = buildMatcher(parsed, ["172.19.0.7"]);
    expect(match("10.10.10.3")).toBe(true);
    expect(match("172.28.255.254")).toBe(true);
    expect(match("fd00::1234")).toBe(true);
    expect(match("172.19.0.7")).toBe(true);
  });

  it("rejects everything else", () => {
    const match = buildMatcher(parsed, []);
    expect(match("10.10.10.4")).toBe(false);
    expect(match("172.29.0.1")).toBe(false);
    expect(match("172.19.0.7")).toBe(false);
    expect(match("not-an-ip")).toBe(false);
  });

  it("matches a dual-stack peer once normalised", () => {
    expect(buildMatcher(parsed, [])(normalizePeer("::ffff:10.10.10.3")!)).toBe(true);
  });
});
