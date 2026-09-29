import { describe, expect, it } from "vitest";
import { dummyVerify, hashPassword, validatePassword, verifyPassword } from "./password";

describe("validatePassword", () => {
  it.each([
    ["short", "Password must be at least 12 characters"],
    ["x".repeat(257), "Password must be at most 256 characters"],
    ["correct horse", null],
    ["x".repeat(256), null],
  ])("%s", (pw, expected) => {
    expect(validatePassword(pw)).toBe(expected);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("round-trips and uses the documented format", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery", stored)).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword("correct horse batterx", stored)).ok).toBe(false);
  });

  it("salts: the same password hashes differently", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("honours stored parameters and flags weaker ones for rehash", async () => {
    const weak = await hashPassword("legacy password!", { N: 1024, r: 8, p: 1 });
    expect(weak.startsWith("scrypt$1024$8$1$")).toBe(true);
    expect(await verifyPassword("legacy password!", weak)).toEqual({ ok: true, needsRehash: true });
  });

  it("rejects malformed stored hashes without throwing", async () => {
    for (const bad of ["", "bcrypt$x", "scrypt$abc$8$1$AA==$AA==", "scrypt$16384$8$1$$"]) {
      expect((await verifyPassword("whatever password", bad)).ok).toBe(false);
    }
  });

  it("dummyVerify resolves", async () => {
    await expect(dummyVerify("anything at all")).resolves.toBeUndefined();
  });

  it("rejects out-of-ceiling stored params quickly (DoS protection)", async () => {
    // Valid base64 for 16-byte salt and 64-byte key (both all zeros)
    const validSalt = Buffer.alloc(16).toString("base64");
    const validKey = Buffer.alloc(64).toString("base64");

    const testCases = [
      // N not a power of two
      `scrypt$1023$8$1$${validSalt}$${validKey}`,
      // N = 2^21 (exceeds ceiling)
      `scrypt$2097152$8$1$${validSalt}$${validKey}`,
      // r = 17 (exceeds ceiling of 16)
      `scrypt$16384$17$1$${validSalt}$${validKey}`,
      // p = 5 (exceeds ceiling of 4)
      `scrypt$16384$8$5$${validSalt}$${validKey}`,
      // r = 8388608 (would cause DoS)
      `scrypt$16384$8388608$1$${validSalt}$${validKey}`,
    ];

    for (const badHash of testCases) {
      const start = performance.now();
      const result = await verifyPassword("test password", badHash);
      const elapsed = performance.now() - start;

      expect(result).toEqual({ ok: false, needsRehash: false });
      expect(elapsed).toBeLessThan(2000); // Must complete within 2 seconds
    }
  });
});
