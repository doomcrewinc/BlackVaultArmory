import { describe, expect, it } from "vitest";
import { normaliseUsername, validateDisplayName, validateUsername } from "./username";

describe("normaliseUsername", () => {
  it("trims and lowercases", () => {
    expect(normaliseUsername(" Jeff ")).toBe("jeff");
    expect(normaliseUsername("JEFF")).toBe("jeff");
  });
});

describe("validateUsername", () => {
  it("accepts letters, digits, dot, dash and underscore", () => {
    expect(validateUsername("jeff.o-k_1")).toBeNull();
    expect(validateUsername("abc")).toBeNull();
    expect(validateUsername("a".repeat(32))).toBeNull();
  });
  it("rejects too short, too long, spaces and uppercase", () => {
    expect(validateUsername("ab")).not.toBeNull();
    expect(validateUsername("a".repeat(33))).not.toBeNull();
    expect(validateUsername("a b")).not.toBeNull();
    expect(validateUsername("Jeff")).not.toBeNull();
    expect(validateUsername("jeff@home")).not.toBeNull();
    expect(validateUsername("")).not.toBeNull();
  });
});

describe("validateDisplayName", () => {
  it("rejects empty or whitespace-only", () => {
    expect(validateDisplayName("")).not.toBeNull();
    expect(validateDisplayName("   ")).not.toBeNull();
  });
  it("accepts 1 to 64 characters after trimming", () => {
    expect(validateDisplayName("J")).toBeNull();
    expect(validateDisplayName("  Jeff O'Keefe  ")).toBeNull();
    expect(validateDisplayName("x".repeat(64))).toBeNull();
    expect(validateDisplayName(`  ${"x".repeat(64)}  `)).toBeNull();
  });
  it("rejects more than 64 characters", () => {
    expect(validateDisplayName("x".repeat(65))).not.toBeNull();
  });
});
