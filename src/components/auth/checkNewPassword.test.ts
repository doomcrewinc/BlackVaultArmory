import { describe, expect, it } from "vitest";
import { checkNewPassword } from "./checkNewPassword";

describe("checkNewPassword", () => {
  it("rejects a password under 12 characters, even when it matches its confirmation", () => {
    expect(checkNewPassword("short1", "short1")).toBe("Password must be at least 12 characters");
  });

  it("rejects a mismatched confirmation once the password itself is long enough", () => {
    expect(checkNewPassword("correct-horse-battery", "different-password-here")).toBe("Passwords do not match");
  });

  it("checks length before match: a short, mismatched pair reports the length error", () => {
    expect(checkNewPassword("short1", "short2")).toBe("Password must be at least 12 characters");
  });

  it("returns null for a valid, matching password", () => {
    expect(checkNewPassword("correct-horse-battery", "correct-horse-battery")).toBeNull();
  });
});
