import { describe, it, expect } from "vitest";
import * as core from "./core.mjs";

const HEX = "a".repeat(64);
const keys = core.deriveKeys(core.parseKeyHex(HEX));

describe("parseKeyHex", () => {
  it.each([
    ["plain", HEX],
    ["trailing newline", HEX + "\n"],
    ["CRLF", HEX + "\r\n"],
    ["BOM + spaces", "﻿  " + HEX + "  "],
    ["upper case", HEX.toUpperCase()],
  ])("accepts %s as the same key", (_l, text) => {
    expect(core.parseKeyHex(text).equals(Buffer.from(HEX, "hex"))).toBe(true);
  });
  it.each(["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), `${HEX}\n${HEX}`])(
    "rejects %j with KEY_INVALID",
    (text) => {
      expect(() => core.parseKeyHex(text)).toThrow(expect.objectContaining({ code: "KEY_INVALID" }));
    },
  );
});

describe("loadMasterKey", () => {
  const fsWith = (files: Record<string, string>) => ({
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => files[p],
  });
  it("prefers the file, reports its source", () => {
    const r = core.loadMasterKey({}, fsWith({ [core.DEFAULT_KEY_FILE]: HEX }));
    expect(r.source).toContain(core.DEFAULT_KEY_FILE);
  });
  it("honours BLACKVAULT_ENCRYPTION_KEY_FILE", () => {
    const r = core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY_FILE: "/k" }, fsWith({ "/k": HEX }));
    expect(r.key.toString("hex")).toBe(HEX);
  });
  it("falls back to the env var", () => {
    expect(core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: HEX }, fsWith({})).source).toContain("BLACKVAULT_ENCRYPTION_KEY");
  });
  it("same key in both is fine; different keys is KEY_CONFLICT", () => {
    expect(() => core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: HEX }, fsWith({ [core.DEFAULT_KEY_FILE]: HEX }))).not.toThrow();
    expect(() => core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: "b".repeat(64) }, fsWith({ [core.DEFAULT_KEY_FILE]: HEX })))
      .toThrow(expect.objectContaining({ code: "KEY_CONFLICT" }));
  });
  it("neither is KEY_MISSING and the message names both sources and the generate command", () => {
    try { core.loadMasterKey({}, fsWith({})); throw new Error("no throw"); }
    catch (e: unknown) {
      const error = e as core.EncryptionKeyError;
      expect(error.code).toBe("KEY_MISSING");
      expect(error.message).toContain(core.DEFAULT_KEY_FILE);
      expect(error.message).toContain("BLACKVAULT_ENCRYPTION_KEY");
      expect(error.message).toContain("openssl rand -hex 32");
    }
  });
});

describe("field encryption", () => {
  it("round-trips, prefix and key id", () => {
    const c = core.encryptValue(keys, "Firearm.serialNumber", "ABC123");
    expect(c.startsWith(`bv2:${keys.id}:`)).toBe(true);
    expect(core.decryptValue(keys, "Firearm.serialNumber", c)).toBe("ABC123");
  });
  it("random IV: same plaintext encrypts differently", () => {
    expect(core.encryptValue(keys, "A.b", "x")).not.toBe(core.encryptValue(keys, "A.b", "x"));
  });
  it("AAD swap fails", () => {
    const c = core.encryptValue(keys, "Firearm.serialNumber", "ABC");
    expect(() => core.decryptValue(keys, "Gear.serialNumber", c)).toThrow();
  });
  it("tamper fails", () => {
    const c = core.encryptValue(keys, "A.b", "ABC");
    const parts = c.split(":");
    parts[3] = Buffer.from("zzz").toString("base64url");
    expect(() => core.decryptValue(keys, "A.b", parts.join(":"))).toThrow();
  });
  it("wrong key is KEY_MISMATCH", () => {
    const other = core.deriveKeys(core.parseKeyHex("b".repeat(64)));
    const c = core.encryptValue(keys, "A.b", "x");
    expect(() => core.decryptValue(other, "A.b", c)).toThrow(expect.objectContaining({ code: "KEY_MISMATCH" }));
  });
  it("empty string and unicode round-trip", () => {
    for (const v of ["", "Ünïcödé-序列-🔫"]) expect(core.decryptValue(keys, "A.b", core.encryptValue(keys, "A.b", v))).toBe(v);
  });
  it("fingerprint is stable, exact-match and key-dependent", () => {
    expect(core.fingerprint(keys, "ABC")).toBe(core.fingerprint(keys, "ABC"));
    expect(core.fingerprint(keys, "ABC")).not.toBe(core.fingerprint(keys, "abc"));
    expect(core.fingerprint(keys, "ABC")).not.toBe(core.fingerprint(keys, "ABC "));
    const other = core.deriveKeys(core.parseKeyHex("b".repeat(64)));
    expect(core.fingerprint(other, "ABC")).not.toBe(core.fingerprint(keys, "ABC"));
  });
  it("subkeys differ from each other and from the master key", () => {
    expect(keys.enc.equals(keys.idx)).toBe(false);
    expect(keys.enc.equals(Buffer.from(HEX, "hex"))).toBe(false);
  });
});

describe("sealed backups", () => {
  const json = JSON.stringify({ meta: { version: "1.1" }, firearms: [{ serialNumber: "SECRET-1" }] });
  it("round-trips and contains no plaintext", () => {
    const sealed = core.sealBackup("correct horse battery", json);
    expect(sealed).not.toContain("SECRET-1");
    expect(core.isSealedBackup(JSON.parse(sealed))).toBe(true);
    expect(core.openBackup("correct horse battery", JSON.parse(sealed))).toBe(json);
  });
  it("NFC and NFD forms of the same passphrase both open it", () => {
    const p = "pässwörd-ünïcode";
    const sealed = JSON.parse(core.sealBackup(p.normalize("NFD"), json));
    expect(core.openBackup(p.normalize("NFC"), sealed)).toBe(json);
  });
  it("wrong passphrase, tampered data and tampered header are all WRONG_PASSPHRASE_OR_DAMAGED", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    const bad = (e: unknown, p = "correct horse battery") =>
      expect(() => core.openBackup(p, e)).toThrow(expect.objectContaining({ code: "WRONG_PASSPHRASE_OR_DAMAGED" }));
    bad(env, "wrong passphrase!!");
    bad({ ...env, data: env.data.slice(0, -4) + "AAAA" });
    bad({ ...env, iv: Buffer.alloc(12, 1).toString("base64url") });
  });
  it("rejects hostile or unknown KDF parameters BEFORE deriving (UNSUPPORTED)", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    for (const kdf of [
      { ...env.kdf, N: 2 ** 30 }, { ...env.kdf, r: 64 }, { ...env.kdf, p: 16 },
      { ...env.kdf, name: "argon2" }, { ...env.kdf, N: 1000 },
    ]) {
      const t = Date.now();
      expect(() => core.openBackup("correct horse battery", { ...env, kdf })).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
      expect(Date.now() - t).toBeLessThan(200);
    }
    expect(() => core.openBackup("x".repeat(12), { ...env, version: 2 })).toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
  });
  it("passphrase under 12 characters is refused when sealing", () => {
    expect(() => core.sealBackup("short", json)).toThrow(expect.objectContaining({ code: "PASSPHRASE_TOO_SHORT" }));
    expect(() => core.sealBackup("ü".repeat(12), json)).not.toThrow();
  });
});
