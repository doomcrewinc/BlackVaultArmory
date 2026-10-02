// Shared by the app (allowJs) and the CLI scripts — the ONLY copy of BlackVault's
// at-rest crypto. Spec: docs/superpowers/specs/2026-09-30-field-encryption-design.md
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync,
} from "node:crypto";
import * as nodeFs from "node:fs";

export const FIELD_PREFIX = "bv2:";
export const DEFAULT_KEY_FILE = "/run/secrets/blackvault_encryption_key";
export const SEAL_FORMAT = "blackvault-sealed-backup";
const GENERATE_HINT = "Generate one with: openssl rand -hex 32";

export class EncryptionKeyError extends Error {
  constructor(code, message) { super(message); this.name = "EncryptionKeyError"; this.code = code; }
}
export class SealError extends Error {
  constructor(code, message) { super(message); this.name = "SealError"; this.code = code; }
}

export function parseKeyHex(text) {
  const cleaned = String(text).replace(/^﻿/, "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new EncryptionKeyError("KEY_INVALID", `Encryption key must be 64 hex characters. ${GENERATE_HINT}`);
  }
  return Buffer.from(cleaned.toLowerCase(), "hex");
}

export function generateKeyHex() { return randomBytes(32).toString("hex"); }

/**
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {{ existsSync(p: string): boolean; readFileSync(p: string, enc: string): string }} [fsImpl=nodeFs]
 * @returns {{ key: Buffer; source: string }}
 */
export function loadMasterKey(env = process.env, fsImpl = nodeFs) {
  const filePath = env.BLACKVAULT_ENCRYPTION_KEY_FILE || DEFAULT_KEY_FILE;
  let fromFile = null;
  if (fsImpl.existsSync(filePath)) {
    try {
      fromFile = parseKeyHex(fsImpl.readFileSync(filePath, "utf8"));
    } catch (e) {
      if (e instanceof EncryptionKeyError && e.code === "KEY_INVALID") {
        throw new EncryptionKeyError("KEY_INVALID",
          `Encryption key in ${filePath} is invalid. Must be 64 hex characters. ${GENERATE_HINT}`);
      }
      throw e;
    }
  }
  const envText = (env.BLACKVAULT_ENCRYPTION_KEY ?? "").trim();
  let fromEnv = null;
  if (envText) {
    try {
      fromEnv = parseKeyHex(envText);
    } catch (e) {
      if (e instanceof EncryptionKeyError && e.code === "KEY_INVALID") {
        throw new EncryptionKeyError("KEY_INVALID",
          `BLACKVAULT_ENCRYPTION_KEY is invalid. Must be 64 hex characters. ${GENERATE_HINT}`);
      }
      throw e;
    }
  }
  if (fromFile && fromEnv && !fromFile.equals(fromEnv)) {
    throw new EncryptionKeyError("KEY_CONFLICT",
      `Encryption key in ${filePath} differs from BLACKVAULT_ENCRYPTION_KEY. Remove one of them.`);
  }
  if (fromFile) return { key: fromFile, source: `file ${filePath}` };
  if (fromEnv) return { key: fromEnv, source: "env BLACKVAULT_ENCRYPTION_KEY" };
  throw new EncryptionKeyError("KEY_MISSING",
    `No encryption key. Looked for the file ${filePath} and the env var BLACKVAULT_ENCRYPTION_KEY. ${GENERATE_HINT}`);
}

export function keyId(key) { return createHash("sha256").update(key).digest("hex").slice(0, 8); }

function subkey(key, info) { return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32)); }

export function deriveKeys(key) {
  return {
    id: keyId(key),
    enc: subkey(key, "blackvault/field-encryption/v1"),
    idx: subkey(key, "blackvault/serial-index/v1"),
    file: subkey(key, "blackvault/file-encryption/v1"),
  };
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

export function isEncrypted(v) { return typeof v === "string" && v.startsWith(FIELD_PREFIX); }

function parseField(stored) {
  const parts = String(stored).slice(FIELD_PREFIX.length).split(":");
  if (!isEncrypted(stored) || parts.length !== 4) {
    throw new EncryptionKeyError("MALFORMED", "Not a bv2-format encrypted value");
  }
  const [id, iv, ct, tag] = parts;
  return { id, iv: unb64u(iv), ct: unb64u(ct), tag: unb64u(tag) };
}

export function envelopeKeyId(stored) { return parseField(stored).id; }

export function encryptValue(keys, aad, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keys.enc, iv);
  c.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return `${FIELD_PREFIX}${keys.id}:${b64u(iv)}:${b64u(ct)}:${b64u(c.getAuthTag())}`;
}

export function decryptValue(keys, aad, stored) {
  const f = parseField(stored);
  if (f.id !== keys.id) {
    throw new EncryptionKeyError("KEY_MISMATCH", `Value was encrypted with key ${f.id}, current key is ${keys.id}.`);
  }
  if (f.tag.length !== 16) {
    throw new EncryptionKeyError("MALFORMED", "Invalid GCM tag length");
  }
  const d = createDecipheriv("aes-256-gcm", keys.enc, f.iv, { authTagLength: 16 });
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(f.tag);
  return Buffer.concat([d.update(f.ct), d.final()]).toString("utf8");
}

export function fingerprint(keys, value) {
  return createHmac("sha256", keys.idx).update(String(value), "utf8").digest("hex");
}

// ---- file encryption (BVF1) ----
export const FILE_MAGIC = "BVF1";
const FILE_VERSION = 1;
const FILE_HEADER_LEN = 13; // magic(4) + version(1) + keyId(8)
const FILE_IV_LEN = 12;
const FILE_TAG_LEN = 16;

function fileHeader(id) {
  return Buffer.concat([Buffer.from(FILE_MAGIC, "ascii"), Buffer.from([FILE_VERSION]), Buffer.from(id, "ascii")]);
}
function fileAad(header, basename) {
  return Buffer.concat([header, Buffer.from(String(basename), "utf8")]);
}
export function isEncryptedFile(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === FILE_MAGIC;
}
export function fileKeyId(buf) {
  if (!isEncryptedFile(buf) || buf.length < FILE_HEADER_LEN + FILE_IV_LEN + FILE_TAG_LEN || buf[4] !== FILE_VERSION) {
    throw new EncryptionKeyError("MALFORMED", "Not a BVF1 encrypted file.");
  }
  return buf.subarray(5, FILE_HEADER_LEN).toString("ascii");
}
export function encryptFile(keys, basename, plaintext) {
  const header = fileHeader(keys.id);
  const iv = randomBytes(FILE_IV_LEN);
  const c = createCipheriv("aes-256-gcm", keys.file, iv, { authTagLength: FILE_TAG_LEN });
  c.setAAD(fileAad(header, basename));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([header, iv, ct, c.getAuthTag()]);
}
export function decryptFile(keys, basename, stored) {
  const id = fileKeyId(stored);
  if (id !== keys.id) {
    throw new EncryptionKeyError("KEY_MISMATCH", `File was encrypted with key ${id}, current key is ${keys.id}.`);
  }
  const header = stored.subarray(0, FILE_HEADER_LEN);
  const iv = stored.subarray(FILE_HEADER_LEN, FILE_HEADER_LEN + FILE_IV_LEN);
  const tag = stored.subarray(stored.length - FILE_TAG_LEN);
  const ct = stored.subarray(FILE_HEADER_LEN + FILE_IV_LEN, stored.length - FILE_TAG_LEN);
  const d = createDecipheriv("aes-256-gcm", keys.file, iv, { authTagLength: FILE_TAG_LEN });
  d.setAAD(fileAad(header, basename));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---- sealed backups ----
const KDF = { name: "scrypt", N: 65536, r: 8, p: 1 };
const MIN_PASSPHRASE = 12;

function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function passKey(passphrase, salt, kdf) {
  return scryptSync(String(passphrase).normalize("NFC"), salt, 32,
    { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

export function sealBackup(passphrase, json) {
  if (Array.from(String(passphrase).normalize("NFC")).length < MIN_PASSPHRASE) {
    throw new SealError("PASSPHRASE_TOO_SHORT", `Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = { format: SEAL_FORMAT, version: 1, kdf: { ...KDF, salt: b64u(salt) }, cipher: "aes-256-gcm", iv: b64u(iv) };
  const c = createCipheriv("aes-256-gcm", passKey(passphrase, salt, KDF), iv);
  c.setAAD(Buffer.from(canonicalJson(header), "utf8"));
  const data = Buffer.concat([c.update(json, "utf8"), c.final()]);
  return JSON.stringify({ ...header, tag: b64u(c.getAuthTag()), data: b64u(data) });
}

export function isSealedBackup(obj) {
  return !!obj && typeof obj === "object" && obj.format === SEAL_FORMAT;
}

export function openBackup(passphrase, envelope) {
  const e = envelope ?? {};
  const k = e.kdf ?? {};
  // Validate BEFORE deriving: an attacker-chosen N would otherwise pin the CPU/RAM.
  if (e.format !== SEAL_FORMAT || e.version !== 1 || e.cipher !== "aes-256-gcm"
      || k.name !== "scrypt" || k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p
      || typeof k.salt !== "string" || typeof e.iv !== "string"
      || typeof e.tag !== "string" || typeof e.data !== "string") {
    throw new SealError("UNSUPPORTED", "Unsupported or malformed sealed backup.");
  }
  // Validate decoded lengths before any decryption (DoS and integrity protection)
  const decodedSalt = unb64u(k.salt);
  const decodedIv = unb64u(e.iv);
  const decodedTag = unb64u(e.tag);
  if (decodedSalt.length !== 16 || decodedIv.length !== 12 || decodedTag.length !== 16) {
    throw new SealError("UNSUPPORTED", "Invalid salt, IV or tag length in sealed backup.");
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { tag, data, ...header } = e;
  try {
    const d = createDecipheriv("aes-256-gcm", passKey(passphrase, decodedSalt, k), decodedIv, { authTagLength: 16 });
    d.setAAD(Buffer.from(canonicalJson(header), "utf8"));
    d.setAuthTag(decodedTag);
    return Buffer.concat([d.update(unb64u(e.data)), d.final()]).toString("utf8");
  } catch {
    throw new SealError("WRONG_PASSPHRASE_OR_DAMAGED", "Wrong passphrase or damaged file.");
  }
}
