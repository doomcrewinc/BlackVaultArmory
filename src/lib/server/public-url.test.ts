import { describe, expect, it } from "vitest";
import { parsePublicUrl, PublicUrlError } from "./public-url";

describe("parsePublicUrl", () => {
  it.each([
    ["https://vault.example.com", "https://vault.example.com", "vault.example.com"],
    ["https://vault.example.com/", "https://vault.example.com", "vault.example.com"],
    ["https://Vault.Example.COM:443/", "https://vault.example.com", "vault.example.com"],
    ["http://localhost:3000", "http://localhost:3000", "localhost:3000"],
    ["http://vault.lan:80", "http://vault.lan", "vault.lan"],
    ["https://vault.example.com:8443", "https://vault.example.com:8443", "vault.example.com:8443"],
    ["  https://vault.example.com  ", "https://vault.example.com", "vault.example.com"],
  ])("%s -> origin %s, host %s", (raw, origin, host) => {
    const parsed = parsePublicUrl(raw);
    expect(parsed.origin).toBe(origin);
    expect(parsed.host).toBe(host);
  });

  it.each([
    [undefined, /not set/],
    ["", /not set/],
    ["   ", /not set/],
    ["vault.example.com", /not a valid URL/],
    ["ftp://vault.example.com", /http or https/],
    ["https://vault.example.com/vault", /path/],
    ["https://vault.example.com/?x=1", /query/],
    ["https://vault.example.com/?", /query/],
    ["https://vault.example.com/#top", /fragment/],
    ["https://vault.example.com#", /fragment/],
    ["https://user:pw@vault.example.com", /username or password/],
  ])("rejects %s", (raw, message) => {
    expect(() => parsePublicUrl(raw)).toThrow(PublicUrlError);
    expect(() => parsePublicUrl(raw)).toThrow(message);
  });

  it("names the variable and gives an example in every error", () => {
    try {
      parsePublicUrl("ftp://x");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("BLACKVAULT_PUBLIC_URL");
      expect(String(error)).toContain("https://vault.example.com");
    }
  });
});
