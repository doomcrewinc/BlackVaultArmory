import { describe, expect, it } from "vitest";
import { isLoopbackOrigin, passUrl, type PassNetwork } from "./pass-url";

const PATH = "/capture/t";
const LAN = "http://192.168.1.5:3000";
const PUBLIC = "https://vault.example.com";

function net(over: Partial<PassNetwork> = {}): PassNetwork {
  return { lanUrl: LAN, publicUrl: PUBLIC, directAccess: true, ...over };
}

describe("passUrl, origin is not loopback", () => {
  it.each([
    ["a LAN address", "http://192.168.1.5:3000", net()],
    ["a public name, direct access on", PUBLIC, net()],
    ["a public name, direct access off", PUBLIC, net({ directAccess: false })],
    ["no network info", "http://192.168.1.5:3000", null],
  ])("keeps the origin for %s", (_name, origin, n) => {
    expect(passUrl(origin, PATH, n)).toEqual({ url: origin + PATH, reachable: true });
  });

  it("drops a trailing slash on the origin", () => {
    expect(passUrl("https://vault.example.com/", PATH, null).url).toBe(PUBLIC + PATH);
  });
});

describe("passUrl, origin is loopback", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "uses the public URL when direct access is off (%s)",
    (origin) => {
      expect(passUrl(origin, PATH, net({ directAccess: false }))).toEqual({
        url: PUBLIC + PATH,
        reachable: true,
      });
    },
  );

  it.each([
    ["direct access on, both known", net(), LAN],
    ["direct access on, no public URL", net({ publicUrl: null }), LAN],
    ["direct access off, empty public URL", net({ directAccess: false, publicUrl: "" }), LAN],
    ["a LAN URL with a trailing slash", net({ lanUrl: LAN + "/" }), LAN],
  ])("uses the LAN URL: %s", (_name, n, expected) => {
    expect(passUrl("http://localhost:3000", PATH, n)).toEqual({
      url: expected + PATH,
      reachable: true,
    });
  });

  it("trims a trailing slash on the public URL", () => {
    const { url } = passUrl("http://localhost:3000", PATH, net({ directAccess: false, publicUrl: PUBLIC + "/" }));
    expect(url).toBe(PUBLIC + PATH);
    expect(url).not.toContain("//capture");
  });

  it.each([
    ["no network info", null],
    ["no LAN URL, direct access on", net({ lanUrl: null })],
    ["nothing usable", net({ lanUrl: null, publicUrl: null, directAccess: false })],
  ])("is not reachable with %s", (_name, n) => {
    expect(passUrl("http://127.0.0.1:3000", PATH, n)).toEqual({
      url: "http://127.0.0.1:3000" + PATH,
      reachable: false,
    });
  });

  it("falls back to the LAN URL when direct access is off but there is no public URL", () => {
    expect(passUrl("http://localhost:3000", PATH, net({ directAccess: false, publicUrl: null })).url).toBe(LAN + PATH);
  });
});

describe("isLoopbackOrigin", () => {
  it.each([
    ["http://localhost:3000", true],
    ["http://LOCALHOST", true],
    ["http://127.0.0.1:3000", true],
    ["http://[::1]:3000", true],
    ["http://192.168.1.5:3000", false],
    ["https://vault.example.com", false],
    ["not a url", false],
  ])("%s -> %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});
