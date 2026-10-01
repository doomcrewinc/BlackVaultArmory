# Field Encryption at Rest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store serial numbers and NFA paperwork encrypted with a server-held key outside the data volume, with sealed backups, a rotation command, and an automatic upgrade path. The app's behaviour stays unchanged for signed-in users.

**Architecture:**
- One plain-ESM crypto core (`src/lib/encryption/core.mjs`) is shared by the app and the CLI scripts.
- A Prisma client extension sits underneath the existing audit extension. It encrypts listed fields on write, decrypts them on read, and rewrites exact serial lookups to a keyed fingerprint column.
- Startup loads and checks the key, then encrypts any plaintext in one transaction.
- Backups are sealed with an admin-typed passphrase.
- Host scripts generate the key, snapshot the database before upgrades, and rotate the key.

**Tech Stack:** Next.js 16 App Router (`src/instrumentation.ts`, route handlers), Prisma 5.22 on SQLite (`connection_limit=1`) and PostgreSQL 17, `node:crypto` (AES-256-GCM, HKDF-SHA256, HMAC-SHA256, scrypt), Vitest 2, Bash and Windows batch installers, Docker Compose secrets.

**Spec:** `docs/superpowers/specs/2026-09-30-field-encryption-design.md`. It is binding, and the decision numbers D1–D9 refer to it.

## Global Constraints

- **Encrypted fields (D1):**
  - `Firearm`: `serialNumber`, `nfaControlNumber`, `nfaRegisteredTo`, `nfaTransferMethod`, `nfaApprovalDate`, `nfaTaxPaid`.
  - `Accessory`: `serialNumber`, `nfaControlNumber`, `nfaRegisteredTo`, `nfaTransferMethod`, `nfaApprovalDate`, `nfaTaxPaid`.
  - `Gear`: `serialNumber`.
  - Nothing else is encrypted.
- **Master key:** 32 bytes as 64 hex chars. Sources, in order:
  1. The file at `BLACKVAULT_ENCRYPTION_KEY_FILE` (default `/run/secrets/blackvault_encryption_key`).
  2. Env var `BLACKVAULT_ENCRYPTION_KEY`.
  - Both present and different means refuse to start.
- **Subkeys:** HKDF-SHA256 with an empty salt. Info strings are `blackvault/field-encryption/v1` (AES key) and `blackvault/serial-index/v1` (HMAC key).
- **Key id:** the first 8 hex characters of SHA-256(master key).
- **Field ciphertext:** `bv2:<keyId>:<iv b64url>:<ciphertext b64url>:<tag b64url>`. AES-256-GCM, random 12-byte IV, AAD = UTF-8 `<Model>.<field>`.
- **Fingerprint:** `serialNumberHash` = hex HMAC-SHA256(index subkey, the serial exactly as given, no normalization).
- **Uniqueness:** `Firearm.serialNumberHash` is `@unique`, and Firearm's `serialNumber` loses `@unique`. Accessory and Gear get `@@index([serialNumberHash])`.
- **Key check:** `AppSettings.encryptionKeyCheck` holds the ciphertext of `blackvault-key-check` with AAD `AppSettings.encryptionKeyCheck`.
- **Sealed backup:** `format: "blackvault-sealed-backup"`, `version: 1`. KDF scrypt with N=65536, r=8, p=1 and a 16-byte salt; AES-256-GCM with a 12-byte IV. AAD = canonical JSON of every envelope field except `data` and `tag`. The passphrase must be at least 12 characters.
- **Client order:** `base → encryption → audit`, assembled only in `src/lib/prisma.ts`.
- **Startup failures** refuse to start, using the same mechanism as the `BLACKVAULT_PUBLIC_URL` check in `src/instrumentation.ts`.
- **New audit actions** `ENCRYPTION_ENABLED` and `KEY_ROTATED` go in the `security` action group. Each must have a non-default `summarize()` text; the partition and exhaustiveness tests already enforce this.
- **New env keys** use the `BLACKVAULT_` prefix. `VAULT_ENCRYPTION_KEY` stays passed through, only for the legacy `enc:` upgrade path.
- **Schema edits** go only in `prisma/schema.base.prisma`, followed by `npm run gen:schemas && npm run db:generate`.
  - Every schema change gets a timestamped migration for BOTH providers.
  - Postgres `0_init` is frozen.
  - `npm run db:check-drift` must pass.
- **Real-DB tests** run on a scratch database. Never touch `prisma/prisma/dev.db`.
- Never `pkill` or `killall`. Never touch the host `dashboard`.

## Review Focus

1. **A key file saved by a Windows editor.** It may have a UTF-8 BOM, CRLF line endings or trailing spaces, and it must still load as the same key. Test owner: Task 1.
2. **An attacker-supplied sealed-backup header with huge scrypt parameters.** A file with `N=2^30` must be rejected before any key derivation runs, not hang the server. Test owner: Task 1.
3. **A partial update that doesn't touch the serial.** Editing only a firearm's notes must leave `serialNumber` and `serialNumberHash` exactly as they were. Test owner: Task 3.
4. **A non-ASCII passphrase**, e.g. `pässwörd-ünïcode`. It must round-trip even if the browser sends a different Unicode normalization form (NFD vs NFC). Test owner: Task 1.
5. **Nested writes.** A Build create that nests a new Accessory with a serial, and an upsert whose create branch carries a serial, must both store ciphertext and a fingerprint. Test owner: Task 3.

## Plan notes and rulings made while planning

- **P1 (spec gap): the server-side backup copy is sealed too.** `src/app/api/backup/route.ts` optionally writes a copy to `AppSettings.backupDestinationPath`. A plaintext copy on disk would violate threat 2. Ruling: that copy is the same sealed envelope as the download.
- **P2: the backup is sealed on the server.** Today the client assembles the file from the JSON response. After this change the POST takes `{ passphrase }` and returns the sealed envelope, which the client saves as `blackvault-backup-<timestamp>.sealed.json`. Plaintext rows never leave the server unsealed.
- **P3: SQLite stores DateTime as integer milliseconds or ISO text,** depending on the writer. The type-change migration copies raw values. The startup encryption migration (Task 4) accepts a number (milliseconds), a numeric string, or an ISO string for `nfaApprovalDate`, and a number or numeric string for `nfaTaxPaid`. Task 2 records which representation the current SQLite data actually uses.
- **P4: `scripts/migrate-sqlite-to-postgres.ts` copies rows raw.** Ciphertext and fingerprints copy unchanged and stay valid, because the AAD is model plus field, not provider. Task 8 adds a test.

---

### Task 1: Crypto core

**Files:**
- Create: `src/lib/encryption/core.mjs`, `src/lib/encryption/core.d.ts`, `src/lib/encryption/core.test.ts`

**Interfaces:**
- Produces, all exported from `core.mjs`:
  - `FIELD_PREFIX = "bv2:"`, `DEFAULT_KEY_FILE`, `SEAL_FORMAT`
  - `class EncryptionKeyError extends Error { code: "KEY_MISSING" | "KEY_INVALID" | "KEY_CONFLICT" | "KEY_MISMATCH" | "KEY_CHECK_LOST" }` (`KEY_CHECK_LOST` is thrown only by Task 4)
  - `class SealError extends Error { code: "WRONG_PASSPHRASE_OR_DAMAGED" | "UNSUPPORTED" | "PASSPHRASE_TOO_SHORT" }`
  - `parseKeyHex(text: string): Buffer`
  - `loadMasterKey(env?, fsImpl?): { key: Buffer; source: string }`
  - `generateKeyHex(): string`
  - `keyId(key: Buffer): string`
  - `deriveKeys(key: Buffer): FieldKeys` where `FieldKeys = { id: string; enc: Buffer; idx: Buffer }`
  - `encryptValue(keys, aad, plaintext): string`
  - `decryptValue(keys, aad, stored): string`
  - `isEncrypted(v: unknown): v is string`
  - `envelopeKeyId(stored: string): string`
  - `fingerprint(keys, value: string): string`
  - `sealBackup(passphrase, json: string): string`
  - `isSealedBackup(obj: unknown): boolean`
  - `openBackup(passphrase, envelope: unknown): string`

- [ ] **Step 1: Write the failing tests.** Test file `src/lib/encryption/core.test.ts`. Cases:

```ts
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
    catch (e: any) {
      expect(e.code).toBe("KEY_MISSING");
      expect(e.message).toContain(core.DEFAULT_KEY_FILE);
      expect(e.message).toContain("BLACKVAULT_ENCRYPTION_KEY");
      expect(e.message).toContain("openssl rand -hex 32");
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
```

- [ ] **Step 2:** Run `timeout 300 npx vitest run src/lib/encryption/core.test.ts`. Expect FAIL, because the module does not exist yet.

- [ ] **Step 3: Implement `src/lib/encryption/core.mjs`.**

```js
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

export function loadMasterKey(env = process.env, fsImpl = nodeFs) {
  const filePath = env.BLACKVAULT_ENCRYPTION_KEY_FILE || DEFAULT_KEY_FILE;
  const fromFile = fsImpl.existsSync(filePath) ? parseKeyHex(fsImpl.readFileSync(filePath, "utf8")) : null;
  const envText = (env.BLACKVAULT_ENCRYPTION_KEY ?? "").trim();
  const fromEnv = envText ? parseKeyHex(envText) : null;
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
  };
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

export function isEncrypted(v) { return typeof v === "string" && v.startsWith(FIELD_PREFIX); }

function parseField(stored) {
  const parts = String(stored).slice(FIELD_PREFIX.length).split(":");
  if (!isEncrypted(stored) || parts.length !== 4) throw new Error("Not a bv2 value");
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
  const d = createDecipheriv("aes-256-gcm", keys.enc, f.iv);
  d.setAAD(Buffer.from(aad, "utf8"));
  d.setAuthTag(f.tag);
  return Buffer.concat([d.update(f.ct), d.final()]).toString("utf8");
}

export function fingerprint(keys, value) {
  return createHmac("sha256", keys.idx).update(String(value), "utf8").digest("hex");
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
  const { tag, data, ...header } = e;
  try {
    const d = createDecipheriv("aes-256-gcm", passKey(passphrase, unb64u(k.salt), k), unb64u(e.iv));
    d.setAAD(Buffer.from(canonicalJson(header), "utf8"));
    d.setAuthTag(unb64u(tag));
    return Buffer.concat([d.update(unb64u(data)), d.final()]).toString("utf8");
  } catch {
    throw new SealError("WRONG_PASSPHRASE_OR_DAMAGED", "Wrong passphrase or damaged file.");
  }
}
```

  Then write `core.d.ts` declaring exactly the Interfaces block above, with `FieldKeys`, both error classes and their `code` unions. The app imports it as `@/lib/encryption/core.mjs`.

- [ ] **Step 4:** Run the tests until they PASS. Also run `npm run typecheck` (it must stay within the baseline) and `npm run lint` (0 errors).
- [ ] **Step 5: Injection.** Remove `c.setAAD` from `encryptValue` and `decryptValue`, and confirm the AAD swap test FAILS. Then restore the code.
- [ ] **Step 6: Commit** `git commit -m "feat(encryption): shared crypto core — keys, field AEAD, fingerprint, sealed backups"`.

---

### Task 2: Schema, migrations, field registry and audit redaction

**Files:**
- Modify: `prisma/schema.base.prisma`:
  - Firearm: `serialNumber String` (drop `@unique`), plus `serialNumberHash String? @unique`; `nfaApprovalDate String?`, `nfaTaxPaid String?`.
  - Accessory: add `serialNumberHash String?` with `@@index([serialNumberHash])`; `nfaApprovalDate String?`, `nfaTaxPaid String?`.
  - Gear: add `serialNumberHash String?` with `@@index([serialNumberHash])`.
  - AppSettings: `encryptionKeyCheck String?`.
- Create: `prisma/{sqlite,postgres}/migrations/20260930000000_field_encryption/migration.sql`.
- Create: `src/lib/encryption/fields.ts` and `src/lib/encryption/fields.test.ts`.
- Modify: `src/lib/audit/redact.ts`, adding the six NFA field names to `EXPLICIT_REDACTED_FIELDS`, and `src/lib/audit/redact.test.ts`.
- Modify: `src/lib/date-only-fields.ts`. Read it first. `nfaApprovalDate` stays date-only for display. The date migration's writer is handled in Task 4.

**Interfaces:**
- Produces:
  - `ENCRYPTED_FIELDS: ReadonlyArray<{ model: "Firearm" | "Accessory" | "Gear"; delegate: "firearm" | "accessory" | "gear"; field: string; kind: "string" | "date" | "number"; fingerprint?: true }>`
  - `encryptedFieldsFor(model: string): ReadonlyArray<...>`
  - `isEncryptedField(model: string, field: string): boolean`
  - `aadFor(model, field): string`, returning `` `${model}.${field}` ``

- [ ] **Step 1: Failing tests** in `fields.test.ts`:
  1. The registry has exactly the D1 list, with kinds `nfaApprovalDate` → `date`, `nfaTaxPaid` → `number`, everything else → `string`, and `fingerprint: true` only on `serialNumber`.
  2. A DMMF check using `Prisma.dmmf` (see `src/lib/audit/registry.test.ts` for the pattern): every registered field is type `String` in the schema, and every `fingerprint` model has a `serialNumberHash` String field.
  3. Firearm's `serialNumberHash` is unique and `serialNumber` is not.
  4. A raw-SQL guard: scan `src/**/*.{ts,tsx,mjs}` and `scripts/**/*` (excluding tests and migrations) for `$queryRaw`, `$executeRaw`, `$queryRawUnsafe` and `$executeRawUnsafe`. Fail if any line within 10 lines of the call mentions a registered field name or `serialNumberHash`.

  In `redact.test.ts`, assert that each NFA field name is redacted.
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3: Edit the schema, then run `npm run gen:schemas && npm run db:generate`.**
  - For SQLite, generate the migration with `prisma migrate diff --from-schema-datamodel <develop schema> --to-schema-datamodel prisma/sqlite/schema.prisma --script`. Use a scratch database; never `dev.db`.
  - Hand-write the Postgres migration so existing values convert explicitly:

```sql
-- prisma/postgres/migrations/20260930000000_field_encryption/migration.sql
DROP INDEX "Firearm_serialNumber_key";
ALTER TABLE "Firearm" ADD COLUMN "serialNumberHash" TEXT;
CREATE UNIQUE INDEX "Firearm_serialNumberHash_key" ON "Firearm"("serialNumberHash");
ALTER TABLE "Firearm" ALTER COLUMN "nfaApprovalDate" TYPE TEXT
  USING to_char("nfaApprovalDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE "Firearm" ALTER COLUMN "nfaTaxPaid" TYPE TEXT USING "nfaTaxPaid"::text;
ALTER TABLE "Accessory" ADD COLUMN "serialNumberHash" TEXT;
CREATE INDEX "Accessory_serialNumberHash_idx" ON "Accessory"("serialNumberHash");
ALTER TABLE "Accessory" ALTER COLUMN "nfaApprovalDate" TYPE TEXT
  USING to_char("nfaApprovalDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE "Accessory" ALTER COLUMN "nfaTaxPaid" TYPE TEXT USING "nfaTaxPaid"::text;
ALTER TABLE "Gear" ADD COLUMN "serialNumberHash" TEXT;
CREATE INDEX "Gear_serialNumberHash_idx" ON "Gear"("serialNumberHash");
ALTER TABLE "AppSettings" ADD COLUMN "encryptionKeyCheck" TEXT;
```

  Check the column type and the index name against the current Postgres schema and `0_init`. If the index name differs, use the real one. Run `npm run db:check-drift` until it passes.
- [ ] **Step 4: Record the SQLite DateTime representation (plan note P3).**
  - On a scratch copy of a develop-era database with an NFA firearm, run `sqlite3 <copy> "select typeof(nfaApprovalDate), nfaApprovalDate from Firearm where nfaApprovalDate is not null limit 3"` both before and after the migration.
  - Write the result into the commit message body and into `src/lib/encryption/fields.ts` as a comment.
- [ ] **Step 5:** Run the tests until they PASS. Then run typecheck and lint.
  - Typecheck will now fail wherever the app assigns a `Date` or `number` to `nfaApprovalDate` or `nfaTaxPaid`, because the generated Prisma types are now `string`.
  - Do NOT fix those call sites by hand. Task 3's extension restores the app-facing types. Record the failing sites in the report, and add them to the typecheck baseline with the comment `// field-encryption: Task 3 restores Date/number`. Task 3 must remove every one of these baseline entries.
- [ ] **Step 6: Commit** `git commit -m "feat(encryption): schema — serial fingerprint, text NFA date/tax, key check; registry and guards"`.

---

### Task 3: Encryption extension (GATED: proof of layering with audit first)

**Files:**
- Create: `src/lib/encryption/extension.ts`, `src/lib/encryption/keys.ts`, `src/lib/encryption/extension.real-db.test.ts`
- Modify: `src/lib/prisma.ts`, so the client is built as `withAudit(withEncryption(new Client(...)))`. Also update the typecheck baseline (remove Task 2's entries).
- Reference, read first: `src/lib/audit/extension.ts` (especially `withAudit` and the transaction wrapper at about `:317`), `src/lib/audit/extension.real-db.test.ts` (the real-DB harness and its stall rules), and `docs/superpowers/specs/2026-09-29-audit-log-spike.md`.

**Interfaces:**
- Consumes: Task 1 core; Task 2 `ENCRYPTED_FIELDS`, `encryptedFieldsFor` and `aadFor`.
- Produces:
  - `getFieldKeys(): FieldKeys`, which loads lazily through `loadMasterKey()`, caches the result, and exposes `resetFieldKeysForTests()`.
  - `withEncryption<C extends PrismaClient>(base: C): C`
  - `class EncryptedFieldQueryError extends Error` and `class EncryptedFieldDecryptError extends Error { model; id; field }`
  - `encodeForStorage(model, field, value): string | null` and `decodeFromStorage(model, field, stored): string | Date | number | null`. Task 4 and the rotation script reuse these.
  - App-facing types: `nfaApprovalDate: Date | null` and `nfaTaxPaid: number | null`, the same as before Task 2. Achieve this with the extension's `result` component (`needs` / `compute`) or a typed wrapper, and pick whichever keeps the generated delegate types usable. Record which one in the report.

- [ ] **Step 1 (GATE): layering proof, written as failing real-DB tests.** Run on SQLite `connection_limit=1` AND Postgres pool 1 and pool 5, with a key set via `BLACKVAULT_ENCRYPTION_KEY` in the test env.
  1. An audited `firearm.update` changing `notes`, made through the app client inside a wrapped `$transaction`, writes an audit UPDATE whose before-row read shows the decrypted serial. The stored audit `changes` contain no `bv2:` text and no plaintext serial (it is redacted).
  2. `firearm.create` stores `bv2:` in the raw row (read with a raw base client, not the app client), and the app client reads back the plaintext.
  3. No deadlock and no P2028 error on SQLite.

  If these cannot pass with `base → encryption → audit`, STOP and report BLOCKED with the evidence. Spec D7 then needs a ruling.
- [ ] **Step 2: Failing tests for the full behaviour.** Real-DB tests, on both providers:
  - **Every write kind:** `create`, `createMany`, `update`, `updateMany`, `upsert` (create branch and update branch), and nested writes. The nested cases are a Build create that nests an Accessory with a serial, and a Firearm create that nests `accessories.create`.
  - **Every write kind stores** `bv2:` for each registered field that is set, and a correct `serialNumberHash`.
  - **Null stays null**, with a null hash.
  - **Review Focus 3:** an update that changes only `notes` leaves the raw `serialNumber` ciphertext byte-identical, and the hash unchanged.
  - **Review Focus 5:** nested Accessory creates are covered by the nested cases above.
  - **Reads:** `findUnique`, `findFirst`, `findMany`, `include` (a firearm with its accessories) and `select` subsets all return plaintext. `nfaApprovalDate` comes back as a `Date` equal to what was written, and `nfaTaxPaid` as a `number`.
  - **Filters:** `findFirst({ where: { serialNumber: "X" } })` and `{ serialNumber: { equals: "X" } }` both find the row. `contains`, `startsWith`, `in`, `not`, `orderBy: { serialNumber }` and `where: { nfaControlNumber: "x" }` each throw `EncryptedFieldQueryError`.
  - **Duplicate firearm serial:** a create gives the same Prisma `P2002` error a duplicate gives today, so existing route error handling is unchanged.
  - **The 409 response is unchanged:** `POST /api/firearms` and `PUT /api/firearms/[id]` with a duplicate serial still return `409 { error: "A firearm with that serial number already exists" }`. Those handlers (`src/app/api/firearms/route.ts:223-230` and `[id]/route.ts:~270`) match on the message containing `serialNumber`, and the new constraint name `serialNumberHash` still contains it. This test pins that; if the match ever breaks, change the handler to check for `serialNumberHash` explicitly.
  - **Corrupt value:** a raw row with a corrupted ciphertext makes a read throw `EncryptedFieldDecryptError`, carrying the model, id and field.
  - **Wrong key:** a row encrypted under another key throws `EncryptedFieldDecryptError` (cause `KEY_MISMATCH`).
- [ ] **Step 3: Implement.**
  - Use Prisma `$extends({ query: { $allModels: { $allOperations } } })` for `args` rewriting and result decoding. Recurse into nested `data` and `where` for the related models named in the registry.
  - `keys.ts` keeps the loaded keys in one module-level cache.
  - Remove Task 2's typecheck baseline entries.
- [ ] **Step 4:** Run the tests until they PASS. Then run the full `npm test` with `timeout 900` (the existing audit real-DB tests must still pass), typecheck, and lint.
- [ ] **Step 5: Injection.**
  - (a) Skip encryption for `updateMany`. A test must FAIL; then restore.
  - (b) Skip the `serialNumber` equality rewrite. The lookup test must FAIL; then restore.
- [ ] **Step 6: Commit** `git commit -m "feat(encryption): Prisma extension under the audit layer — encrypt on write, decrypt on read, fingerprint lookups"`.

---

### Task 4: Startup — key load, key check, encryption migration, new audit actions

**Files:**
- Create: `src/lib/encryption/startup.ts` and `src/lib/encryption/startup.real-db.test.ts`
- Modify:
  - `src/instrumentation.ts`
  - `src/lib/date-migration.ts`: its writes to `nfaApprovalDate` must go through the app client (and so be encrypted) or skip `bv2:` values. Read it first.
  - `src/lib/audit/actions.ts`: add `ENCRYPTION_ENABLED` and `KEY_ROTATED`.
  - `src/lib/audit/query.ts`: add both actions to `SECURITY_ACTIONS`.
  - `src/lib/audit/summary.ts`: `Encryption enabled: 42 firearms, 7 accessories, 1 gear item` and `Encryption key rotated (abcd1234 → ef567890)`.
  - `src/lib/audit/labels.ts`, and the matching tests.

**Interfaces:**
- Consumes: Task 1 `loadMasterKey`, `deriveKeys`, `encryptValue`, `decryptValue` and `isEncrypted`; Task 3 `getFieldKeys` and `encodeForStorage`.
- Produces:
  - `assertEncryptionKey(rawClient): Promise<void>` throws `EncryptionKeyError` with code `KEY_MISSING`, `KEY_INVALID`, `KEY_CONFLICT`, `KEY_MISMATCH` or `KEY_CHECK_LOST`.
  - `runEncryptionMigration(rawClient): Promise<{ counts: Record<string, number> }>`
  - `decryptLegacyEnc(stored: string, env): string`, a port of the legacy `enc:` logic from `src/lib/crypto.ts`. It throws instead of returning `[unreadable…]`.

- [ ] **Step 1: Failing tests** (real-DB on SQLite and Postgres, plus unit tests):
  1. **Fresh empty DB with a key:** the key check is created, and a second start is a no-op.
  2. **No key:** `KEY_MISSING`. Assert the message, and that no row changed.
  3. **Wrong key against an existing key check:** `KEY_MISMATCH`, and the message names both key ids.
  4. **Key check absent while `bv2:` values exist:** `KEY_CHECK_LOST`.
  5. **Plaintext data** (seeded with a raw client, including an `nfaApprovalDate` stored in each representation recorded in Task 2 Step 4, and `nfaTaxPaid` as `"200"` and `200`) is migrated:
     - every listed field becomes `bv2:`;
     - the hashes are filled;
     - the app client reads the same values as before, compared by a canonical JSON hash of firearms, accessories and gear;
     - exactly one `ENCRYPTION_ENABLED` event is written, with correct counts and `keyId`;
     - a second run writes nothing.
  6. **Legacy `enc:` value with the right `VAULT_ENCRYPTION_KEY`:** migrated to `bv2:`. **Without that key:** the start is refused, the message names the row and field, and the whole transaction is rolled back (no row changed).
  7. **Failure part-way** (inject a throw on the third row): full rollback.
  8. **Date migration then encryption migration** on the same database: no double conversion and no ciphertext corruption.
  9. **Startup in production mode,** set with `process.env` in the test: a thrown key error propagates out of `register()`, as the public-URL check does.
  10. **The partition test** (`query.test.ts`) and the **summary exhaustiveness test** pass with the two new actions.
- [ ] **Step 2:** Run the tests and confirm they FAIL.
- [ ] **Step 3: Implement.** In `register()`, after the public-URL check, the startup order is:
  1. `await assertEncryptionKey(raw)`
  2. the existing date migration
  3. `await runEncryptionMigration(raw)`

  Use a raw client from `loadPrismaClient` for both encryption steps, so the extension doesn't intercept them. Write the audit event with the existing `writeAuditEvent`, actor `system`.
  Errors from the encryption steps are NOT caught (refuse to start). The date migration keeps its existing catch.
- [ ] **Step 4:** Run the tests until they PASS. Then run the full `npm test` with `timeout 900`, typecheck and lint.
- [ ] **Step 5: Injection.** Make the migration skip `Accessory`. Test 5 must FAIL; then restore.
- [ ] **Step 6: Commit** `git commit -m "feat(encryption): refuse to start without the right key; encrypt existing data on first start"`.

---

### Task 5: Sealed backups and restore

**Files:**
- Modify:
  - `src/app/api/backup/route.ts`: POST body `{ passphrase }`; the response is the sealed envelope as an attachment; the server-side copy is sealed (P1, P2).
  - `src/app/api/backup/restore/route.ts`: detect the sealed format, take the passphrase, and keep the plain-backup path.
  - `src/app/settings/SettingsView.tsx`: passphrase and confirmation fields; a warning over plain HTTP using the existing direct-access/secure-context signal (look for how the admin page shows the plain-HTTP cookie warning); a passphrase field when restoring a sealed file; a yellow warning for a plain file.
  - `src/lib/audit/summary.ts`
- Tests: `route.test.ts`, the restore `route.test.ts` and `route.roundtrip.test.ts`, and `SettingsView.test.tsx`.

**Interfaces:**
- Consumes: Task 1 `sealBackup`, `openBackup`, `isSealedBackup` and `SealError`.
- Produces:
  - `POST /api/backup` with `{ passphrase: string }` returns `200` with `Content-Type: application/json`, `Content-Disposition: attachment; filename="blackvault-backup-<ts>.sealed.json"`, and the envelope as the body.
  - A passphrase under 12 characters returns `400 { error: "Passphrase must be at least 12 characters." }`.
  - `POST /api/backup/restore` takes either a plain backup body (as today) or `{ sealed: <envelope>, passphrase: string }`.
  - A wrong passphrase returns `400 { error: "Wrong passphrase or damaged file." }` and changes nothing.
  - `BACKUP_CREATED.changes` and `RESTORE.changes` gain `sealed: boolean`.

- [ ] **Step 1: Failing tests.**
  - The sealed backup body contains no plaintext serial, item name or note: seed a firearm named `NeedleName-XYZ` with serial `NeedleSerial-123`, and grep the body for both.
  - Round-trip: back up, wipe, restore with the passphrase. The canonical inventory hash is equal.
  - Restoring onto a database with a DIFFERENT encryption key works: reset the key between backup and restore in the real-DB test. The restored raw rows carry the new key id.
  - A wrong passphrase gives a 400 and changes nothing (row counts and the audit count are unchanged).
  - An old plain v1.1 backup still restores, and `RESTORE` records `sealed: false`.
  - The server-side copy at `backupDestinationPath` is the sealed envelope.
  - UI: passphrase mismatch and too-short validation; a sealed file shows the passphrase field; a plain file shows the warning; the request carries the passphrase. A 50 MB envelope must be under the restore route's existing body limit. Check and test the limit, and raise it only if needed, noting it in the report.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement. **Step 4:** Run the tests until they PASS, then typecheck and lint.
- [ ] **Step 5: Injection.** Make the backup route skip sealing (return the plain JSON). The no-plaintext test must FAIL; then restore.
- [ ] **Step 6: Commit** `git commit -m "feat(encryption): passphrase-sealed backups; plain backups still restore with a warning"`.

---

### Task 6: Key rotation

**Files:**
- Create: `scripts/rotate-encryption-key.mjs`, `scripts/rotate-encryption-key.test.ts`, `rotate-key.sh`, `rotate-key.bat`
- Modify: `scripts/ci/windows/Test-WindowsInstallers.ps1` (cover `rotate-key.bat` with Docker stubbed, the way the update tests already work)
- Reference: `scripts/admin-reset-link.mjs` and its test, for the plain-JS-script-against-Prisma pattern and how the test runs it.

**Interfaces:**
- Consumes: the Task 1 core (`import ... from "../src/lib/encryption/core.mjs"`). The script must NOT re-implement crypto.
- Produces: `node scripts/rotate-encryption-key.mjs --old-key-file <path> --new-key-file <path>`, which exits 0 on success. On failure it exits non-zero and prints one line.

- [ ] **Step 1: Failing tests** (real SQLite DB, plus Postgres via the same harness):
  - After rotation, every registered field's raw value carries the new key id and decrypts to the same plaintext. Every `serialNumberHash` equals `fingerprint(newKeys, plaintext)`. `encryptionKeyCheck` opens with the new key and not the old one. Exactly one `KEY_ROTATED` event is written with `{ from, to, counts }`.
  - An old key that doesn't match the key check means the script refuses, and nothing changes.
  - A failure injected mid-transaction leaves no row changed.
  - Running the script twice with the same old key fails on the second run (key check mismatch), and nothing changes.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement the script with a raw PrismaClient. Decrypt with the old keys, re-encrypt with the new keys, recompute hashes and replace the key check in one `$transaction`. Write the audit row directly, mirroring the shape `writeAuditEvent` produces, and add a comment pointing to `src/lib/audit/record.ts`.
- [ ] **Step 4: Wrappers.** `rotate-key.sh` and `rotate-key.bat` run these steps:
  1. Check `secrets/blackvault_encryption_key` exists.
  2. `docker compose stop blackvault`
  3. Run the same snapshot function the update scripts use (Task 7 creates it in `scripts/db-snapshot.sh` and `scripts\db-snapshot.bat`; for this task, call it if present, and Task 7 wires it).
  4. Generate the new key into `secrets/blackvault_encryption_key.new`.
  5. `docker compose run --rm -v ./secrets:/run/rotate:ro blackvault node scripts/rotate-encryption-key.mjs --old-key-file /run/rotate/blackvault_encryption_key --new-key-file /run/rotate/blackvault_encryption_key.new`
  6. On success, `mv key key.old` and `mv key.new key`, then `docker compose start blackvault`. Print "Back up the new key file now. Delete blackvault_encryption_key.old once you have confirmed everything works."
  7. On failure, delete `.new`, restart, and exit 1.

  The Windows variant gets the same steps in `rotate-key.bat`, and the PowerShell CI harness covers the success and failure paths.
- [ ] **Step 5:** Run the tests until they PASS. Then run lint, and the Windows harness locally if `pwsh` is available; otherwise rely on CI and note that in the report.
- [ ] **Step 6: Injection.** Skip the hash recompute. A test must FAIL; then restore.
- [ ] **Step 7: Commit** `git commit -m "feat(encryption): key rotation command and host wrappers"`.

---

### Task 7: Installers, update scripts, compose and DB snapshot

**Files:**
- Modify: `install.sh`, `install.bat`, `update.sh`, `update.bat`, `docker-compose.yml` and any other compose files that run the app (check every `docker-compose*.yml`), `.gitignore` (`secrets/` and `backups/`)
- Create: `scripts/db-snapshot.sh` and `scripts/db-snapshot.bat`
- Tests: the existing installer and update test suites (`scripts/*.test.ts`, `scripts/ci/windows/Test-WindowsInstallers.ps1`). Read them first and follow their patterns.
- Reference: memory note "old script runs on upgrade". `update.sh` git-pulls itself, so the OLD copy of the script runs the upgrade. The new key and snapshot logic must therefore also work when the new tree is run by the old script. Test the old-script-with-new-tree path.

**Interfaces:**
- Produces: `secrets/blackvault_encryption_key` (mode 600) next to the compose file; `backups/blackvault-<YYYYmmdd-HHMMSS>.{db,sql}`; and compose `secrets:` wiring that mounts the key at `/run/secrets/blackvault_encryption_key`.

- [ ] **Step 1: Failing tests.**
  - The install script creates a valid 64-hex key file with mode 600 and prints the boxed message: "BACK THIS FILE UP. Without it your serial numbers and NFA records cannot be recovered."
  - It never overwrites an existing key file.
  - The update script creates the key only if it is missing.
  - The update script runs the snapshot BEFORE starting the new image, and aborts with a non-zero exit when the snapshot fails.
  - The snapshot uses the SQLite copy for the sqlite provider and `pg_dump` via the db container for postgres (with Docker stubbed, as the existing tests do), and prints the plaintext warning.
  - Compose renders: `docker compose config` with the generated files contains the secret mount.
  - The Windows harness covers the same checks for the `.bat` files.
  - The old `update.sh` from `origin/develop` running against this tree still starts successfully: the new compose requires the secret file, so the new image's entrypoint check, or the compose file itself, must give a clear message when the key is absent. Decide which in the report.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement. **Step 4:** Run the tests until they PASS, then lint.
- [ ] **Step 5: Injection.** Make `update.sh` skip the snapshot-failure check. A test must FAIL; then restore.
- [ ] **Step 6: Commit** `git commit -m "feat(encryption): installers generate the key, updates snapshot the database first"`.

---

### Task 8: Remove legacy crypto, export warning, docs

**Files:**
- Delete: `src/lib/crypto.ts`, `scripts/decrypt-serials.ts`, and the `decrypt-serials` npm script.
- Modify:
  - Every remaining importer of `decryptField`/`encryptField`: `src/app/api/firearms/route.ts`, `src/app/api/firearms/[id]/route.ts`, `src/app/vault/[id]/page.tsx` and `src/app/api/exports/full-armory/route.ts`. Values are already plaintext via the extension, so remove the calls.
  - The export page(s): one line saying "Exports contain serial numbers in plain text."
  - `README.md` and `CONTRIBUTING.md`.
  - `docs/release-checklist.md`, which mentions `VAULT_ENCRYPTION_KEY`.
- Tests: `scripts/migrate-sqlite-to-postgres` test (P4: ciphertext and hashes copy unchanged and still decrypt on Postgres), plus the existing export tests.

- [ ] **Step 1: Failing tests.**
  - P4 migrator round-trip.
  - The export page shows the warning.
  - A grep test: no file imports `@/lib/crypto`.
- [ ] **Step 2:** Run the tests and confirm they FAIL. **Step 3:** Implement and document.
  - README: what is encrypted, where the key lives, "BACK UP THE KEY", sealed backups, rotation, and the update snapshot being plaintext.
  - CONTRIBUTING: the registry rule (a new sensitive field means a registry entry, a String column and a migration), the extension order, the raw-SQL ban, and `core.mjs` being the only crypto.
  - Verify every doc sentence against the code, and list each claim with its `file:line` in the report.
- [ ] **Step 4:** Run the full `npm test` with `timeout 900`, typecheck, lint, and `npm run build` with `timeout 900`. **Step 5: Commit** `git commit -m "refactor(encryption): retire the V1 crypto shim; docs and export warning"`.

---

### Task 9: Whole-branch verification and PR

- [ ] **Step 1:** Run lint, typecheck, `npm test` three times, and `npm run build`, and record the counts.
- [ ] **Step 2: Real image, fresh volume.**
  - The install script generates the key.
  - Create an admin and a firearm with a serial and NFA data.
  - `sqlite3` and `psql` against the real volumes show `bv2:` for every listed field. The app shows plaintext.
  - Creating a duplicate serial is refused.
  - Create a sealed backup. Its file contains no plaintext needle.
  - Restore it on a second fresh install with a different key: the data appears.
  - A wrong passphrase changes nothing. An old plain backup restores with the warning.
  - Rotate the key: the new key id is everywhere, there is one `KEY_ROTATED` event, and starting with the `.old` key is refused.
  - The audit log shows NFA fields as redacted.
  - Take screenshots.
- [ ] **Step 3: Upgrade from the `develop` image with data,** on SQLite and on PostgreSQL.
  - Run the update script from `develop`. Per the old-script memory note, test both the old script and the new script.
  - Check that a snapshot is taken first.
  - Check that every listed field is encrypted, the canonical app-level inventory hash is unchanged, and exactly one `ENCRYPTION_ENABLED` event exists.
  - Restart and confirm nothing changes.
  - Missing, conflicting and wrong keys are each refused, with the documented message and no row changed.
- [ ] **Step 4:** Build the acceptance table: the spec's 8 criteria, each mapped to its evidence.
- [ ] **Step 5:** Open a draft PR with `gh pr create --draft --repo doomcrewinc/BlackVaultArmory --base develop`. Include the summary, the acceptance table and the known limitations, and end the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Never merge.
- [ ] **Step 6:** CI must be green on the final head on both time-zone legs and the Windows job. Report the run URL.
