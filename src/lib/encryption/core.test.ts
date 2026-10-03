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

describe("streaming full backups (BVB1)", () => {
  const PASS = "correct horse battery";
  const CHUNK = 1048576;
  const SEALED_CHUNK = CHUNK + 16;

  // Deterministic generated data; never a repo file.
  const gen = (n: number) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >>> 8) * 7) & 0xff;
    return b;
  };
  // Feed in odd-sized pieces so buffering across chunk boundaries is exercised.
  const pump = (t: import("node:stream").Transform, input: Buffer, piece = 65537) =>
    new Promise<Buffer>((resolve, reject) => {
      const out: Buffer[] = [];
      t.on("data", (d: Buffer) => out.push(d));
      t.on("error", reject);
      t.on("end", () => resolve(Buffer.concat(out)));
      for (let i = 0; i < input.length; i += piece) t.write(input.subarray(i, i + piece));
      t.end();
    });
  const seal = (input: Buffer, p = PASS) => pump(core.createBackupSealer(p), input);
  const open = (sealed: Buffer, p = PASS) => pump(core.createBackupOpener(p), sealed);
  const split = (sealed: Buffer) => {
    const hlen = sealed.readUInt32BE(0);
    const head = sealed.subarray(0, 4 + hlen);
    const body = sealed.subarray(4 + hlen);
    const chunks: Buffer[] = [];
    for (let i = 0; i < body.length; i += SEALED_CHUNK) chunks.push(body.subarray(i, i + SEALED_CHUNK));
    return { head, header: JSON.parse(head.subarray(4).toString("utf8")), chunks };
  };
  const rejects = (p: Promise<unknown>, code: string) => expect(p).rejects.toMatchObject({ name: "SealError", code });

  it("exports the format name", () => {
    expect(core.BVB_FORMAT).toBe("blackvault-full-backup");
  });

  it("writes the exact BVB1 header", async () => {
    const { head, header } = split(await seal(Buffer.alloc(0)));
    expect(header).toMatchObject({
      format: "blackvault-full-backup", version: 1, cipher: "aes-256-gcm-stream", chunkSize: 1048576,
      kdf: { name: "scrypt", N: 65536, r: 8, p: 1 },
    });
    expect(Object.keys(header).sort()).toEqual(["chunkSize", "cipher", "format", "kdf", "noncePrefix", "version"]);
    expect(Buffer.from(header.kdf.salt, "base64url")).toHaveLength(16);
    expect(Buffer.from(header.noncePrefix, "base64url")).toHaveLength(8);
    expect(head.readUInt32BE(0)).toBe(head.length - 4);
  });

  it.each([
    ["0 B", 0, [16]],
    ["1 B", 1, [17]],
    ["1 MiB - 1", CHUNK - 1, [CHUNK - 1 + 16]],
    ["1 MiB", CHUNK, [SEALED_CHUNK]],
    ["1 MiB + 1", CHUNK + 1, [SEALED_CHUNK, 17]],
    ["3.5 MiB", 3.5 * CHUNK, [SEALED_CHUNK, SEALED_CHUNK, SEALED_CHUNK, CHUNK / 2 + 16]],
  ])("round-trips %s with the expected chunk layout", async (_l, n, sizes) => {
    const input = gen(n);
    const sealed = await seal(input);
    expect(split(sealed).chunks.map((c) => c.length)).toEqual(sizes);
    if (n >= 64) expect(sealed.includes(input.subarray(0, 64))).toBe(false);
    expect((await open(sealed)).equals(input)).toBe(true);
  }, 30000);

  it("a stream ending exactly on 1 MiB seals its one full chunk with the final flag", async () => {
    const input = gen(CHUNK);
    const sealed = await seal(input);
    const { head, chunks } = split(sealed);
    expect(chunks.map((c) => c.length)).toEqual([SEALED_CHUNK]);
    // The opener decrypts the last chunk as final; a non-final flag would surface as TRUNCATED.
    expect((await open(Buffer.concat([head, chunks[0]]))).equals(input)).toBe(true);
    // 2 MiB: the first full chunk is NOT final, so dropping the second one is TRUNCATED.
    const two = split(await seal(gen(2 * CHUNK)));
    expect(two.chunks.map((c) => c.length)).toEqual([SEALED_CHUNK, SEALED_CHUNK]);
    await rejects(open(Buffer.concat([two.head, two.chunks[0]])), "TRUNCATED");
  }, 30000);

  describe("tampering with a 3.5 MiB backup", { timeout: 30000 }, () => {
    let sealed: Buffer;
    let head: Buffer;
    let c: Buffer[];
    it("setup", async () => {
      sealed = await seal(gen(3.5 * CHUNK));
      ({ head, chunks: c } = split(sealed));
      expect(c).toHaveLength(4);
    }, 30000);
    it("rejects swapped chunks", () => rejects(open(Buffer.concat([head, c[1], c[0], c[2], c[3]])), "WRONG_PASSPHRASE_OR_DAMAGED"));
    it("rejects a dropped middle chunk", () => rejects(open(Buffer.concat([head, c[0], c[2], c[3]])), "WRONG_PASSPHRASE_OR_DAMAGED"));
    it("rejects a duplicated chunk", () => rejects(open(Buffer.concat([head, c[0], c[1], c[1], c[2], c[3]])), "WRONG_PASSPHRASE_OR_DAMAGED"));
    it("rejects a body cut off after a non-final chunk (TRUNCATED)", () => rejects(open(Buffer.concat([head, c[0], c[1]])), "TRUNCATED"));
    it("rejects a header with no body (TRUNCATED)", () => rejects(open(head), "TRUNCATED"));
    it("rejects bytes after the final chunk", () => rejects(open(Buffer.concat([sealed, Buffer.from([0])])), "WRONG_PASSPHRASE_OR_DAMAGED"));
    it("rejects a flipped ciphertext bit", () => {
      const bad = Buffer.from(sealed);
      bad[head.length + 100] ^= 1;
      return rejects(open(bad), "WRONG_PASSPHRASE_OR_DAMAGED");
    });
    it("rejects a header byte changed", () => {
      const bad = Buffer.from(sealed);
      const i = bad.indexOf('"salt":"', 4) + 8;
      bad[i] = bad[i] === 0x41 ? 0x42 : 0x41;
      return rejects(open(bad), "WRONG_PASSPHRASE_OR_DAMAGED");
    });
    it("rejects a wrong passphrase", () => rejects(open(sealed, "wrong passphrase!!"), "WRONG_PASSPHRASE_OR_DAMAGED"));
    it("emits no plaintext from a chunk whose tag fails", async () => {
      const bad = Buffer.from(sealed);
      bad[head.length + SEALED_CHUNK + 5] ^= 1; // damage chunk 1
      const t = core.createBackupOpener(PASS);
      const out: Buffer[] = [];
      t.on("data", (d: Buffer) => out.push(d));
      const done = new Promise((resolve) => t.on("error", resolve));
      t.end(bad);
      await done;
      expect(Buffer.concat(out).length).toBe(CHUNK); // only chunk 0
    }, 30000);
  });

  it("rejects an extra trailing byte after an exactly-1-MiB backup", async () => {
    const sealed = await seal(gen(CHUNK));
    await rejects(open(Buffer.concat([sealed, Buffer.from([1])])), "WRONG_PASSPHRASE_OR_DAMAGED");
  }, 30000);

  it("rejects hostile KDF parameters with UNSUPPORTED before deriving", async () => {
    const sealed = await seal(gen(10));
    const { header, chunks } = split(sealed);
    for (const kdf of [{ N: 2 ** 30 }, { r: 64 }, { p: 16 }, { name: "argon2" }]) {
      const json = Buffer.from(JSON.stringify({ ...header, kdf: { ...header.kdf, ...kdf } }));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(json.length);
      const t = Date.now();
      await rejects(open(Buffer.concat([len, json, ...chunks])), "UNSUPPORTED");
      expect(Date.now() - t).toBeLessThan(200);
    }
  }, 30000);

  it("rejects an unknown format, chunk size, or oversized header length with UNSUPPORTED", async () => {
    const { header, chunks } = split(await seal(gen(10)));
    for (const h of [{ ...header, version: 2 }, { ...header, chunkSize: 4096 }, { ...header, cipher: "aes-256-gcm" }]) {
      const json = Buffer.from(JSON.stringify(h));
      const len = Buffer.alloc(4);
      len.writeUInt32BE(json.length);
      await rejects(open(Buffer.concat([len, json, ...chunks])), "UNSUPPORTED");
    }
    await rejects(open(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x7b])), "UNSUPPORTED");
    await rejects(open(Buffer.from("not a backup at all")), "UNSUPPORTED");
  }, 30000);

  it("refuses a passphrase under 12 code points when sealing", () => {
    expect(() => core.createBackupSealer("short")).toThrow(expect.objectContaining({ code: "PASSPHRASE_TOO_SHORT" }));
    expect(() => core.createBackupSealer("🔫".repeat(11))).toThrow(expect.objectContaining({ code: "PASSPHRASE_TOO_SHORT" }));
  });

  it("an NFD passphrase opens a backup sealed with the NFC form", async () => {
    const p = "pässwörd-ünïcode";
    const input = gen(5000);
    const sealed = await seal(input, p.normalize("NFC"));
    expect((await open(sealed, p.normalize("NFD"))).equals(input)).toBe(true);
  }, 30000);
});

describe("streaming full backups (BVB1) — fix round 1", () => {
  const PASS = "correct horse battery";
  const CHUNK = 1048576;
  const SEALED_CHUNK = CHUNK + 16;
  const gen = (n: number) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) b[i] = (i * 13 + 5) & 0xff;
    return b;
  };
  const pump = (t: import("node:stream").Transform, input: Buffer, piece = 65537) =>
    new Promise<Buffer>((resolve, reject) => {
      const out: Buffer[] = [];
      t.on("data", (d: Buffer) => out.push(d));
      t.on("error", reject);
      t.on("end", () => resolve(Buffer.concat(out)));
      for (let i = 0; i < input.length; i += piece) t.write(input.subarray(i, i + piece));
      t.end();
    });
  const seal = (input: Buffer, piece?: number) => pump(core.createBackupSealer(PASS), input, piece);
  const open = (sealed: Buffer, piece?: number) => pump(core.createBackupOpener(PASS), sealed, piece);
  const headLen = (sealed: Buffer) => 4 + sealed.readUInt32BE(0);
  const rebuild = (sealed: Buffer, mutate: (h: Record<string, unknown> & { kdf: Record<string, unknown> }) => void) => {
    const hl = headLen(sealed);
    const h = JSON.parse(sealed.subarray(4, hl).toString("utf8"));
    mutate(h);
    // Keep canonical key order so only the value under test is wrong.
    const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
      : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
      : JSON.stringify(v);
    const json = Buffer.from(canon(h));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(json.length);
    return Buffer.concat([len, json, sealed.subarray(hl)]);
  };

  it("I-1: 512 KiB written one byte at a time seals and opens in under 5 s", async () => {
    const input = gen(512 * 1024);
    const t0 = Date.now();
    const sealed = await seal(input, 1);
    const plain = await open(sealed, 1);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(plain.equals(input)).toBe(true);
  }, 120000);

  it("M-1: a cut inside a chunk after a verified chunk says damaged or incomplete, not wrong passphrase", async () => {
    const sealed = await seal(gen(3.5 * CHUNK));
    const cut = sealed.subarray(0, headLen(sealed) + 2 * SEALED_CHUNK + 1000);
    const err = await open(cut).then(() => null, (e: unknown) => e as { name: string; code: string; message: string });
    expect(err).toMatchObject({ name: "SealError" });
    expect(["TRUNCATED", "WRONG_PASSPHRASE_OR_DAMAGED"]).toContain(err!.code);
    expect(err!.message).toMatch(/damaged or incomplete/i);
    expect(err!.message).not.toMatch(/passphrase/i);
  }, 30000);

  it("M-2: salt / noncePrefix that are not exact base64url of 16 / 8 bytes are UNSUPPORTED before scrypt", async () => {
    const sealed = await seal(gen(10));
    for (const mutate of [
      (h: { kdf: Record<string, unknown> }) => { h.kdf.salt = `${h.kdf.salt}!!`; },
      (h: { kdf: Record<string, unknown> }) => { h.kdf.salt = `${h.kdf.salt}==`; },
      (h: { kdf: Record<string, unknown> }) => { h.kdf.salt = `${(h.kdf.salt as string).slice(0, 10)} ${(h.kdf.salt as string).slice(10)}`; },
      (h: { kdf: Record<string, unknown> }) => { h.kdf.salt = Buffer.alloc(16, 9).toString("base64"); },
      (h: { kdf: Record<string, unknown> }) => { h.kdf.salt = Buffer.alloc(17).toString("base64url"); },
      (h: Record<string, unknown>) => { h.noncePrefix = `${h.noncePrefix}.`; },
      (h: Record<string, unknown>) => { h.noncePrefix = Buffer.alloc(9).toString("base64url"); },
      (h: Record<string, unknown>) => { h.noncePrefix = 12345678; },
    ]) {
      const t = Date.now();
      await expect(open(rebuild(sealed, mutate as never))).rejects.toMatchObject({ name: "SealError", code: "UNSUPPORTED" });
      expect(Date.now() - t).toBeLessThan(200);
    }
    // Non-canonical last base64url character (spare bits set; a 16-byte salt's canonical last
    // char has index % 16 === 0, so "| 1" always changes it) decodes to the same bytes: rejected too.
    await expect(open(rebuild(sealed, (h) => {
      const s = h.kdf.salt as string;
      const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
      h.kdf.salt = s.slice(0, -1) + alpha[alpha.indexOf(s.slice(-1)) | 1];
    }))).rejects.toMatchObject({ name: "SealError", code: "UNSUPPORTED" });
  }, 30000);

  it("rejects trailing bytes after a short final chunk (small and multi-chunk, both buffer paths)", async () => {
    const small = await seal(gen(5000));
    await expect(open(Buffer.concat([small, Buffer.alloc(16, 0xaa)])))
      .rejects.toMatchObject({ name: "SealError", code: "WRONG_PASSPHRASE_OR_DAMAGED" });
    const big = await seal(gen(2 * CHUNK + 777));
    // More than a whole sealed chunk of junk: forces the transform-loop path, not just flush.
    await expect(open(Buffer.concat([big, gen(SEALED_CHUNK + 5)])))
      .rejects.toMatchObject({ name: "SealError", code: "WRONG_PASSPHRASE_OR_DAMAGED" });
  }, 30000);
});
