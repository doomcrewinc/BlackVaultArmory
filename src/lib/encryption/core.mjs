// Shared by the app (allowJs) and the CLI scripts — the ONLY copy of BlackVault's
// at-rest crypto. Spec: docs/superpowers/specs/2026-09-30-field-encryption-design.md
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync,
} from "node:crypto";
import * as nodeFs from "node:fs";
import { Transform } from "node:stream";

export const FIELD_PREFIX = "bv2:";
export const DEFAULT_KEY_FILE = "/run/secrets/blackvault_encryption_key";
export const SEAL_FORMAT = "blackvault-sealed-backup";
export const BVB_FORMAT = "blackvault-full-backup";
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
const FILE_KEY_ID_RE = /^[0-9a-f]{8}$/;
export function isEncryptedFile(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === FILE_MAGIC;
}
export function fileKeyId(buf) {
  if (!isEncryptedFile(buf) || buf.length < FILE_HEADER_LEN + FILE_IV_LEN + FILE_TAG_LEN || buf[4] !== FILE_VERSION) {
    throw new EncryptionKeyError("MALFORMED", "Not a BVF1 encrypted file.");
  }
  const id = buf.subarray(5, FILE_HEADER_LEN).toString("ascii");
  // M3: untrusted header bytes must never reach a log message or a key
  // comparison unless they are actually a key id (8 lowercase hex chars).
  if (!FILE_KEY_ID_RE.test(id)) {
    throw new EncryptionKeyError("MALFORMED", "Not a BVF1 encrypted file.");
  }
  return id;
}
function requireBasename(basename) {
  if (typeof basename !== "string" || basename.length === 0) {
    throw new EncryptionKeyError("MALFORMED", "basename must be a non-empty string.");
  }
}
export function encryptFile(keys, basename, plaintext) {
  requireBasename(basename);
  const header = fileHeader(keys.id);
  const iv = randomBytes(FILE_IV_LEN);
  const c = createCipheriv("aes-256-gcm", keys.file, iv, { authTagLength: FILE_TAG_LEN });
  c.setAAD(fileAad(header, basename));
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([header, iv, ct, c.getAuthTag()]);
}
export function decryptFile(keys, basename, stored) {
  requireBasename(basename);
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

// ---- streaming full backups (BVB1) ----
// Spec: docs/superpowers/specs/2026-10-02-full-backups-design.md §1.
//
// Wire format:
//   uint32be(headerLen) ‖ header (canonical JSON, headerLen bytes) ‖ chunk_0 ‖ … ‖ chunk_n
//   chunk_i = AES-256-GCM(ciphertext) ‖ 16-byte tag; no other framing bytes.
//   nonce_i = noncePrefix (8 B) ‖ uint32be(i);   AAD_i = header bytes ‖ uint32be(i) ‖ final (0x00 | 0x01)
//   Every non-final chunk holds exactly chunkSize plaintext bytes; the final chunk holds
//   1..chunkSize bytes (an input ending exactly on a boundary seals its last FULL chunk as
//   final). Only an empty input yields a 0-byte final chunk (16 bytes: the tag alone).
//
// How the opener knows which chunk is final WITHOUT a flag byte on the wire or a double
// decrypt: it mirrors the sealer's hold-back. A sealed chunk is decrypted as non-final
// only once at least one byte beyond it has arrived (a non-final chunk is always
// followed by another chunk); whatever remains at end-of-stream is decrypted as final.
// Only on the error path (the final decrypt fails) is it retried as non-final, purely to
// report TRUNCATED rather than WRONG_PASSPHRASE_OR_DAMAGED.
// Plaintext is pushed only after decipher.final() has verified the chunk's tag.
const BVB_CIPHER = "aes-256-gcm-stream";
const BVB_CHUNK = 1048576;
const BVB_TAG = 16;
const BVB_MAX_HEADER = 4096;
const BVB_MAX_COUNTER = 0xffffffff;

// Byte FIFO over a list of Buffers, so 64 KiB writes are not re-concatenated per write.
class ByteQueue {
  constructor() { this.bufs = []; this.length = 0; }
  push(b) { if (b.length) { this.bufs.push(b); this.length += b.length; } }
  take(n) {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const b = this.bufs[0];
      const k = Math.min(b.length, n - off);
      b.copy(out, off, 0, k);
      off += k;
      if (k === b.length) this.bufs.shift(); else this.bufs[0] = b.subarray(k);
    }
    this.length -= n;
    return out;
  }
}

function bvbNonce(prefix, counter) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, 8);
  return n;
}
function bvbAad(headerBytes, counter, final) {
  const t = Buffer.alloc(5);
  t.writeUInt32BE(counter, 0);
  t[4] = final ? 1 : 0;
  return Buffer.concat([headerBytes, t]);
}

function requirePassphrase(passphrase) {
  if (Array.from(String(passphrase).normalize("NFC")).length < MIN_PASSPHRASE) {
    throw new SealError("PASSPHRASE_TOO_SHORT", `Passphrase must be at least ${MIN_PASSPHRASE} characters.`);
  }
}

export function createBackupSealer(passphrase) {
  requirePassphrase(passphrase);
  const salt = randomBytes(16);
  const prefix = randomBytes(8);
  const key = passKey(passphrase, salt, KDF);
  const header = {
    format: BVB_FORMAT, version: 1, kdf: { ...KDF, salt: b64u(salt) },
    cipher: BVB_CIPHER, noncePrefix: b64u(prefix), chunkSize: BVB_CHUNK,
  };
  const headerBytes = Buffer.from(canonicalJson(header), "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(headerBytes.length);
  const q = new ByteQueue();
  let counter = 0;
  const sealChunk = (plain, final) => {
    if (counter > BVB_MAX_COUNTER) throw new SealError("UNSUPPORTED", "Backup too large for BVB1.");
    const c = createCipheriv("aes-256-gcm", key, bvbNonce(prefix, counter), { authTagLength: BVB_TAG });
    c.setAAD(bvbAad(headerBytes, counter, final));
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    counter += 1;
    return out;
  };
  const t = new Transform({
    transform(data, _enc, cb) {
      try {
        q.push(data);
        // Strictly greater: a full chunk is held back until a byte beyond it proves it is not last.
        while (q.length > BVB_CHUNK) this.push(sealChunk(q.take(BVB_CHUNK), false));
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        this.push(sealChunk(q.take(q.length), true)); // 0..chunkSize bytes, always present
        cb();
      } catch (e) { cb(e); }
    },
  });
  t.push(Buffer.concat([len, headerBytes]));
  return t;
}

function parseBvbHeader(headerBytes) {
  let h;
  try { h = JSON.parse(headerBytes.toString("utf8")); } catch { h = null; }
  const k = h?.kdf ?? {};
  // Validate BEFORE deriving: attacker-chosen scrypt params would otherwise pin CPU/RAM.
  if (!h || typeof h !== "object" || Array.isArray(h)
      || h.format !== BVB_FORMAT || h.version !== 1 || h.cipher !== BVB_CIPHER || h.chunkSize !== BVB_CHUNK
      || k.name !== "scrypt" || k.N !== KDF.N || k.r !== KDF.r || k.p !== KDF.p
      || typeof k.salt !== "string" || typeof h.noncePrefix !== "string"
      || Object.keys(h).length !== 6 || Object.keys(k).length !== 5) {
    throw new SealError("UNSUPPORTED", "Unsupported or malformed full backup.");
  }
  const salt = unb64u(k.salt);
  const prefix = unb64u(h.noncePrefix);
  // Canonical-form check: the raw bytes are the AAD, and this also rejects duplicate keys.
  if (salt.length !== 16 || prefix.length !== 8 || canonicalJson(h) !== headerBytes.toString("utf8")) {
    throw new SealError("UNSUPPORTED", "Unsupported or malformed full backup.");
  }
  return { salt, prefix };
}

export function createBackupOpener(passphrase) {
  const SEALED = BVB_CHUNK + BVB_TAG;
  const q = new ByteQueue();
  let headerLen = -1;
  let headerBytes = null;
  let key = null;
  let prefix = null;
  let counter = 0;
  const damaged = () => new SealError("WRONG_PASSPHRASE_OR_DAMAGED", "Wrong passphrase or damaged file.");
  const truncated = () => new SealError("TRUNCATED", "Backup file is incomplete (it ends before the last chunk).");
  // Returns the verified plaintext, or null if the tag does not verify.
  const tryOpen = (sealed, final) => {
    try {
      const d = createDecipheriv("aes-256-gcm", key, bvbNonce(prefix, counter), { authTagLength: BVB_TAG });
      d.setAAD(bvbAad(headerBytes, counter, final));
      d.setAuthTag(sealed.subarray(sealed.length - BVB_TAG));
      return Buffer.concat([d.update(sealed.subarray(0, sealed.length - BVB_TAG)), d.final()]);
    } catch { return null; }
  };
  const readHeader = () => {
    if (headerLen < 0 && q.length >= 4) {
      headerLen = q.take(4).readUInt32BE(0);
      if (headerLen < 2 || headerLen > BVB_MAX_HEADER) {
        throw new SealError("UNSUPPORTED", "Unsupported or malformed full backup.");
      }
    }
    if (headerLen >= 0 && !headerBytes && q.length >= headerLen) {
      const bytes = q.take(headerLen);
      const h = parseBvbHeader(bytes);
      headerBytes = bytes;
      prefix = h.prefix;
      key = passKey(passphrase, h.salt, KDF); // derived exactly once
    }
  };
  return new Transform({
    transform(data, _enc, cb) {
      try {
        q.push(data);
        readHeader();
        if (key) {
          // More than one sealed chunk buffered → the first one cannot be the final chunk.
          while (q.length > SEALED) {
            if (counter > BVB_MAX_COUNTER) throw damaged();
            const plain = tryOpen(q.take(SEALED), false);
            if (!plain) throw damaged();
            counter += 1;
            this.push(plain);
          }
        }
        cb();
      } catch (e) { cb(e); }
    },
    flush(cb) {
      try {
        readHeader();
        if (!key) {
          // Never got a full header: not a BVB1 file at all, or cut inside the header.
          throw headerLen < 0 && q.length < 4 && q.length > 0
            ? new SealError("UNSUPPORTED", "Unsupported or malformed full backup.")
            : truncated();
        }
        if (q.length < BVB_TAG) throw truncated();
        const sealed = q.take(q.length);
        const plain = tryOpen(sealed, true);
        if (!plain) throw tryOpen(sealed, false) ? truncated() : damaged();
        this.push(plain);
        cb();
      } catch (e) { cb(e); }
    },
  });
}
