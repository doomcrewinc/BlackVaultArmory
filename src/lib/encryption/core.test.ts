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
  it("file wins over env var and source names the file", () => {
    const r = core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: HEX }, fsWith({ [core.DEFAULT_KEY_FILE]: HEX }));
    expect(r.source).toContain(core.DEFAULT_KEY_FILE);
    expect(r.source).not.toContain("BLACKVAULT_ENCRYPTION_KEY");
  });
  it("empty or whitespace env var falls back to file", () => {
    const r = core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: "   " }, fsWith({ [core.DEFAULT_KEY_FILE]: HEX }));
    expect(r.source).toContain(core.DEFAULT_KEY_FILE);
  });
  it("KEY_INVALID names the file when key file is corrupt", () => {
    try { core.loadMasterKey({}, fsWith({ [core.DEFAULT_KEY_FILE]: "invalid" })); throw new Error("no throw"); }
    catch (e: unknown) {
      const error = e as core.EncryptionKeyError;
      expect(error.code).toBe("KEY_INVALID");
      expect(error.message).toContain(core.DEFAULT_KEY_FILE);
    }
  });
  it("KEY_INVALID names env var when env var is corrupt", () => {
    try { core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: "invalid" }, fsWith({})); throw new Error("no throw"); }
    catch (e: unknown) {
      const error = e as core.EncryptionKeyError;
      expect(error.code).toBe("KEY_INVALID");
      expect(error.message).toContain("BLACKVAULT_ENCRYPTION_KEY");
    }
  });
  it("corrupt key file throws KEY_INVALID naming the file, even with valid env key", () => {
    try { core.loadMasterKey({ BLACKVAULT_ENCRYPTION_KEY: HEX }, fsWith({ [core.DEFAULT_KEY_FILE]: "invalid" })); throw new Error("no throw"); }
    catch (e: unknown) {
      const error = e as core.EncryptionKeyError;
      expect(error.code).toBe("KEY_INVALID");
      expect(error.message).toContain(core.DEFAULT_KEY_FILE);
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
  it("truncated GCM tag is rejected", () => {
    const c = core.encryptValue(keys, "A.b", "x");
    const parts = c.split(":");
    const truncatedTag = Buffer.from(Buffer.from(parts[4], "base64url").slice(0, 4)).toString("base64url");
    parts[4] = truncatedTag;
    expect(() => core.decryptValue(keys, "A.b", parts.join(":"))).toThrow(expect.objectContaining({ code: "MALFORMED" }));
  });
  it("known-answer test for keyId", () => {
    expect(core.keyId(core.parseKeyHex(HEX))).toBe("e0e77a50");
  });
  it("known-answer test for enc subkey", () => {
    expect(core.deriveKeys(core.parseKeyHex(HEX)).enc.toString("hex"))
      .toBe("ac903742cde9dd78dfd0e0c03d856297af575b196ae90f5dbaf5f391d39cdde9");
  });
  it("known-answer test for idx subkey", () => {
    expect(core.deriveKeys(core.parseKeyHex(HEX)).idx.toString("hex"))
      .toBe("f1efe0a76e073fddbcf62dbf2e7583dab9691b551048cf916425e748829cf8a7");
  });
  it("known-answer test for fingerprint", () => {
    expect(core.fingerprint(keys, "ABC"))
      .toBe("a678af096900e8ef536b72f2f79430bcdcbcc9bf20a2711a74576116414a8646");
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
  it("emoji passphrase under 12 code points is rejected", () => {
    expect(() => core.sealBackup("🔫".repeat(11), json)).toThrow(expect.objectContaining({ code: "PASSPHRASE_TOO_SHORT" }));
  });
  it("NFD unicode passphrase under 12 code points is rejected", () => {
    expect(() => core.sealBackup("ü".normalize("NFD").repeat(11), json)).toThrow(expect.objectContaining({ code: "PASSPHRASE_TOO_SHORT" }));
  });
  it("header tampering breaks sealed backup", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    expect(() => core.openBackup("correct horse battery", { ...env, note: "x" }))
      .toThrow(expect.objectContaining({ code: "WRONG_PASSPHRASE_OR_DAMAGED" }));
  });
  it("truncated GCM tag in sealed backup is rejected BEFORE decryption", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    const truncatedTag = Buffer.from(Buffer.from(env.tag, "base64url").slice(0, 4)).toString("base64url");
    const t = Date.now();
    expect(() => core.openBackup("correct horse battery", { ...env, tag: truncatedTag }))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(Date.now() - t).toBeLessThan(200);
  });
  it("invalid salt length in sealed backup is rejected BEFORE deriving", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    const badSalt = Buffer.alloc(8).toString("base64url");
    const t = Date.now();
    expect(() => core.openBackup("correct horse battery", { ...env, kdf: { ...env.kdf, salt: badSalt } }))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(Date.now() - t).toBeLessThan(200);
  });
  it("invalid IV length in sealed backup is rejected BEFORE decryption", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    const badIv = Buffer.alloc(8).toString("base64url");
    const t = Date.now();
    expect(() => core.openBackup("correct horse battery", { ...env, iv: badIv }))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(Date.now() - t).toBeLessThan(200);
  });
  it("invalid tag length in sealed backup is rejected BEFORE decryption", () => {
    const env = JSON.parse(core.sealBackup("correct horse battery", json));
    const badTag = Buffer.alloc(8).toString("base64url");
    const t = Date.now();
    expect(() => core.openBackup("correct horse battery", { ...env, tag: badTag }))
      .toThrow(expect.objectContaining({ code: "UNSUPPORTED" }));
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("file encryption", () => {
  // Computed independently with: node -e 'const{hkdfSync}=require("node:crypto");
  // const key=Buffer.from("a".repeat(64),"hex");console.log(Buffer.from(hkdfSync(
  // "sha256",key,Buffer.alloc(0),"blackvault/file-encryption/v1",32)).toString("hex"))'
  const KNOWN_FILE_SUBKEY_HEX = "2b55a0f25d245b7d287aaebdfb95a5a021b221f7cbda44a1709fba09fd574358";
  const name = "cmh2abc-def_1727000000000.jpg";
  it("round-trips empty, small and 20 MB buffers; header layout", () => {
    for (const size of [0, 17, 20 * 1024 * 1024]) {
      const plain = Buffer.alloc(size, 7);
      const enc = core.encryptFile(keys, name, plain);
      expect(enc.subarray(0, 4).toString("ascii")).toBe("BVF1");
      expect(enc[4]).toBe(1);
      expect(enc.subarray(5, 13).toString("ascii")).toBe(keys.id);
      expect(enc.length).toBe(13 + 12 + size + 16);
      expect(core.isEncryptedFile(enc)).toBe(true);
      expect(core.fileKeyId(enc)).toBe(keys.id);
      expect(core.decryptFile(keys, name, enc).equals(plain)).toBe(true);
    }
  });
  it("plaintext is not BVF1", () => {
    expect(core.isEncryptedFile(Buffer.from("%PDF-1.7"))).toBe(false);
    expect(core.isEncryptedFile(Buffer.alloc(0))).toBe(false);
  });
  it("tampered header, ciphertext, tag, basename, truncated tag all fail", () => {
    const enc = core.encryptFile(keys, name, Buffer.from("hello world"));
    const flip = (i: number) => { const b = Buffer.from(enc); b[i] ^= 1; return b; };
    expect(() => core.decryptFile(keys, name, flip(4))).toThrow();      // version
    expect(() => core.decryptFile(keys, name, flip(20))).toThrow();     // iv
    expect(() => core.decryptFile(keys, name, flip(26))).toThrow();     // ciphertext
    expect(() => core.decryptFile(keys, name, flip(enc.length - 1))).toThrow(); // tag
    expect(() => core.decryptFile(keys, "other.jpg", enc)).toThrow();
    expect(() => core.decryptFile(keys, name, enc.subarray(0, enc.length - 12))).toThrow();
  });
  it("wrong key is KEY_MISMATCH; short buffer is MALFORMED", () => {
    const other = core.deriveKeys(core.parseKeyHex("b".repeat(64)));
    const enc = core.encryptFile(keys, name, Buffer.from("x"));
    expect(() => core.decryptFile(other, name, enc)).toThrow(expect.objectContaining({ code: "KEY_MISMATCH" }));
    expect(() => core.decryptFile(keys, name, Buffer.from("BVF1"))).toThrow(expect.objectContaining({ code: "MALFORMED" }));
  });
  it("basename must be a non-empty string (M2)", () => {
    expect(() => core.encryptFile(keys, "", Buffer.from("x")))
      .toThrow(expect.objectContaining({ code: "MALFORMED" }));
    expect(() => core.encryptFile(keys, null as unknown as string, Buffer.from("x")))
      .toThrow(expect.objectContaining({ code: "MALFORMED" }));
    expect(() => core.encryptFile(keys, 5 as unknown as string, Buffer.from("x")))
      .toThrow(expect.objectContaining({ code: "MALFORMED" }));

    const enc = core.encryptFile(keys, name, Buffer.from("x"));
    expect(() => core.decryptFile(keys, "", enc))
      .toThrow(expect.objectContaining({ code: "MALFORMED" }));
    expect(() => core.decryptFile(keys, undefined as unknown as string, enc))
      .toThrow(expect.objectContaining({ code: "MALFORMED" }));
  });
  it("fileKeyId rejects a key id that is not 8 lowercase hex chars (M3)", () => {
    const enc = core.encryptFile(keys, name, Buffer.from("x"));
    const bad = Buffer.from(enc);
    bad.write("ZZZZZZZZ", 5, "ascii"); // same length, not hex — must not reach log/compare as a key id
    expect(() => core.fileKeyId(bad)).toThrow(expect.objectContaining({ code: "MALFORMED" }));
    expect(() => core.decryptFile(keys, name, bad)).toThrow(expect.objectContaining({ code: "MALFORMED" }));
  });
  it("file subkey is independent and pinned (known answer)", () => {
    expect(keys.file.equals(keys.enc)).toBe(false);
    expect(keys.file.equals(keys.idx)).toBe(false);
    // Implementer: compute once with a standalone node one-liner (hkdfSync sha256, key=a*64 hex,
    // salt empty, info "blackvault/file-encryption/v1", 32) and pin the full hex here.
    expect(keys.file.toString("hex")).toBe(KNOWN_FILE_SUBKEY_HEX);
  });
});
