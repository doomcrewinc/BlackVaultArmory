import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { ENCRYPTED_FIELDS, aadFor, encryptedFieldsFor, isEncryptedField } from "./fields";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

describe("ENCRYPTED_FIELDS", () => {
  // D1 (docs/superpowers/specs/2026-09-30-field-encryption-design.md): the
  // exact list of encrypted fields. Hardcoded on purpose — unlike
  // DATE_ONLY_FIELDS or AUDITED_MODELS, this list is not "every column of a
  // kind", it is a deliberate, small, security-relevant allowlist. A DMMF
  // guard below separately confirms every entry is backed by a real `String`
  // schema column.
  const expected = [
    { model: "Firearm", delegate: "firearm", field: "serialNumber", kind: "string", fingerprint: true },
    { model: "Firearm", delegate: "firearm", field: "nfaControlNumber", kind: "string" },
    { model: "Firearm", delegate: "firearm", field: "nfaRegisteredTo", kind: "string" },
    { model: "Firearm", delegate: "firearm", field: "nfaTransferMethod", kind: "string" },
    { model: "Firearm", delegate: "firearm", field: "nfaApprovalDate", kind: "date" },
    { model: "Firearm", delegate: "firearm", field: "nfaTaxPaid", kind: "number" },
    { model: "Accessory", delegate: "accessory", field: "serialNumber", kind: "string", fingerprint: true },
    { model: "Accessory", delegate: "accessory", field: "nfaControlNumber", kind: "string" },
    { model: "Accessory", delegate: "accessory", field: "nfaRegisteredTo", kind: "string" },
    { model: "Accessory", delegate: "accessory", field: "nfaTransferMethod", kind: "string" },
    { model: "Accessory", delegate: "accessory", field: "nfaApprovalDate", kind: "date" },
    { model: "Accessory", delegate: "accessory", field: "nfaTaxPaid", kind: "number" },
    { model: "Gear", delegate: "gear", field: "serialNumber", kind: "string", fingerprint: true },
  ];

  it("has exactly the D1 list, with the documented kinds and fingerprint flag", () => {
    const actual = ENCRYPTED_FIELDS.map((f) => ({ ...f }));
    expect(actual.sort((a, b) => (a.model + a.field).localeCompare(b.model + b.field))).toEqual(
      expected.sort((a, b) => (a.model + a.field).localeCompare(b.model + b.field)),
    );
  });

  it("marks fingerprint true only on serialNumber", () => {
    for (const f of ENCRYPTED_FIELDS) {
      if (f.field === "serialNumber") expect(f.fingerprint).toBe(true);
      else expect(f.fingerprint).toBeUndefined();
    }
  });

  it("nothing else is encrypted — Gear has only serialNumber", () => {
    expect(encryptedFieldsFor("Gear").map((f) => f.field)).toEqual(["serialNumber"]);
  });

  // DMMF guard: every registered field must be backed by a real `String`
  // column (ciphertext is text), and every model with a `fingerprint: true`
  // field must have a `serialNumberHash` String column. Same pattern as
  // src/lib/audit/registry.test.ts.
  const schemaModels = Prisma.dmmf.datamodel.models;
  const findField = (modelName: string, fieldName: string) =>
    schemaModels.find((m) => m.name === modelName)?.fields.find((f) => f.name === fieldName);

  it("sees the schema it is asserting against", () => {
    expect(schemaModels.length).toBeGreaterThan(10);
  });

  it("backs every registered field with a String schema column", () => {
    for (const { model, field } of ENCRYPTED_FIELDS) {
      const schemaField = findField(model, field);
      expect(schemaField, `${model}.${field} is missing from the schema`).toBeDefined();
      expect(schemaField?.type, `${model}.${field} must be type String`).toBe("String");
    }
  });

  it("gives every fingerprint model a serialNumberHash String field", () => {
    const fingerprintModels = new Set(ENCRYPTED_FIELDS.filter((f) => f.fingerprint).map((f) => f.model));
    for (const model of fingerprintModels) {
      const hashField = findField(model, "serialNumberHash");
      expect(hashField, `${model}.serialNumberHash is missing`).toBeDefined();
      expect(hashField?.type).toBe("String");
    }
  });

  it("Firearm.serialNumberHash is unique and Firearm.serialNumber is not", () => {
    const serialNumber = findField("Firearm", "serialNumber");
    const serialNumberHash = findField("Firearm", "serialNumberHash");
    expect(serialNumber?.isUnique).toBeFalsy();
    expect(serialNumber?.isId).toBeFalsy();
    expect(serialNumberHash?.isUnique).toBe(true);
  });
});

describe("encryptedFieldsFor / isEncryptedField / aadFor", () => {
  it("filters by model", () => {
    const firearmFields = encryptedFieldsFor("Firearm").map((f) => f.field).sort();
    expect(firearmFields).toEqual(
      ["nfaApprovalDate", "nfaControlNumber", "nfaRegisteredTo", "nfaTaxPaid", "nfaTransferMethod", "serialNumber"].sort(),
    );
    expect(encryptedFieldsFor("NotARealModel")).toEqual([]);
  });

  it("isEncryptedField matches the registry, by model and field", () => {
    expect(isEncryptedField("Firearm", "serialNumber")).toBe(true);
    expect(isEncryptedField("Firearm", "nfaTaxPaid")).toBe(true);
    expect(isEncryptedField("Firearm", "name")).toBe(false);
    expect(isEncryptedField("Gear", "nfaControlNumber")).toBe(false);
    expect(isEncryptedField("NotARealModel", "serialNumber")).toBe(false);
  });

  it("aadFor returns Model.field", () => {
    expect(aadFor("Firearm", "serialNumber")).toBe("Firearm.serialNumber");
    expect(aadFor("AppSettings", "encryptionKeyCheck")).toBe("AppSettings.encryptionKeyCheck");
  });
});

// ── raw-SQL guard ────────────────────────────────────────────────────────
// Raw SQL bypasses the encryption extension entirely, so a query that reads
// or writes an encrypted column by name through $queryRaw/$executeRaw (or
// their *Unsafe variants) would see ciphertext as if it were plaintext, or
// write plaintext where the extension would have encrypted it. This scans
// the real source tree — not a hardcoded list of "known-safe" files — the
// same shape of guard as the field registry itself.
describe("raw SQL never mentions an encrypted column", () => {
  const RAW_CALL = /\$(?:query|execute)Raw(?:Unsafe)?\b/;
  const WINDOW = 10;

  const registeredFieldNames = [...new Set(ENCRYPTED_FIELDS.map((f) => f.field))];
  const watchedNames = [...registeredFieldNames, "serialNumberHash"];
  const nameRegexes = watchedNames.map((name) => new RegExp(`\\b${name}\\b`));

  function isExcluded(relPath: string): boolean {
    if (relPath.includes(`${path.sep}migrations${path.sep}`)) return true;
    if (/\.test\.(ts|tsx|mjs|js)$/.test(relPath)) return true;
    return false;
  }

  function collectFiles(dir: string, matchExt: (p: string) => boolean): string[] {
    const out: string[] = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        out.push(...collectFiles(full, matchExt));
      } else if (matchExt(full)) {
        out.push(full);
      }
    }
    return out;
  }

  const srcFiles = collectFiles(path.join(REPO_ROOT, "src"), (p) => /\.(ts|tsx|mjs)$/.test(p));
  const scriptFiles = collectFiles(path.join(REPO_ROOT, "scripts"), () => true);
  const allFiles = [...srcFiles, ...scriptFiles]
    .map((p) => path.relative(REPO_ROOT, p))
    .filter((p) => !isExcluded(p));

  it("scans a non-empty, real file set", () => {
    expect(allFiles.length).toBeGreaterThan(20);
  });

  it("finds no registered field name within 10 lines of a raw SQL call", () => {
    const violations: string[] = [];

    for (const relPath of allFiles) {
      const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      const lines = text.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (!RAW_CALL.test(lines[i])) continue;

        const start = Math.max(0, i - WINDOW);
        const end = Math.min(lines.length - 1, i + WINDOW);
        for (let j = start; j <= end; j++) {
          const hit = nameRegexes.find((re) => re.test(lines[j]));
          if (hit) {
            violations.push(`${relPath}:${i + 1} raw SQL call near line ${j + 1} mentions ${hit.source}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
