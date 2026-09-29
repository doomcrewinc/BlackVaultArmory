import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it.each([
    ["/vault/abc?tab=docs", "/vault/abc?tab=docs"],
    ["/", "/"],
    [null, "/"],
    ["", "/"],
    ["//evil.com", "/"],
    ["/\\evil.com", "/"],
    ["https://evil.com", "/"],
    ["javascript:alert(1)", "/"],
    ["vault", "/"],
    ["/%2F%2Fevil.com", "/%2F%2Fevil.com"],
    ["/login", "/"],
  ])("%s -> %s", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
