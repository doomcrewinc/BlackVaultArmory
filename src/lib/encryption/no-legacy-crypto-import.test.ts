import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 8: the V1 crypto shim (src/lib/crypto.ts — a passthrough encryptField
 * plus a decryptField that unwrapped pre-V1 `enc:` values) is retired. The
 * field-encryption extension now decrypts every registered field on every
 * read (src/lib/encryption/extension.ts), so every call site that used to
 * wrap a value with decryptField() already receives plaintext and must not
 * call it any more. This scans the real source tree — not a hardcoded list
 * of "known-safe" files — for any import of the now-deleted module, so a
 * stray import (or a reintroduced file) fails CI instead of silently double
 * -wrapping an already-plaintext value or shipping a dead import.
 */
const REPO_ROOT = path.join(__dirname, "..", "..", "..");
const IMPORT_RE = /@\/lib\/crypto\b|\.\.?\/.*\blib\/crypto(?:\.ts)?["']/;

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

describe("no file imports the retired src/lib/crypto.ts (Task 8)", () => {
  const srcFiles = collectFiles(path.join(REPO_ROOT, "src"), (p) => /\.(ts|tsx|mjs|js)$/.test(p));
  const scriptFiles = collectFiles(path.join(REPO_ROOT, "scripts"), (p) => /\.(ts|mjs|js)$/.test(p));
  const allFiles = [...srcFiles, ...scriptFiles].map((p) => path.relative(REPO_ROOT, p));

  it("scans a non-empty, real file set", () => {
    expect(allFiles.length).toBeGreaterThan(20);
  });

  it("src/lib/crypto.ts itself no longer exists", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "src/lib/crypto.ts"))).toBe(false);
  });

  it("scripts/decrypt-serials.ts no longer exists", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "scripts/decrypt-serials.ts"))).toBe(false);
  });

  it("finds no import of @/lib/crypto (or a relative lib/crypto) anywhere in src/ or scripts/", () => {
    const SELF = path.relative(REPO_ROOT, __filename);
    const violations: string[] = [];
    for (const relPath of allFiles) {
      if (relPath === SELF) continue; // this guard's own description text mentions the module by name
      const text = fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^(\/\/|\*|\/\*)/.test(line)) continue; // comments may still mention it historically
        const isImportLine = /^import\b.*\bfrom\b/.test(line) || /\brequire\(/.test(line);
        if (isImportLine && IMPORT_RE.test(line)) {
          violations.push(`${relPath}:${i + 1}: ${line}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("package.json has no decrypt-serials script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.["decrypt-serials"]).toBeUndefined();
  });
});
