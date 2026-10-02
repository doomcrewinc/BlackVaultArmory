"use strict";
// Test fixture for scripts/rotate-encryption-key.test.ts (final review F1).
//
// Patches the generated Prisma client's $executeRawUnsafe so every VACUUM
// statement throws — the post-commit compaction failing (e.g. a full disk:
// VACUUM needs free space about the size of the database). Proves the
// rotation still exits 0 with a warning and leaves
// AppSettings.encryptionCompactionPending set for the app's next start.
// Loaded with `node --require <this file> scripts/rotate-encryption-key.mjs ...`;
// resolves the same client class the script does (see the sibling
// rotate-encryption-key.disconnect-throws.preload.cjs). Test fixture only.
const provider = (process.env.DB_PROVIDER || "").trim().toLowerCase();
const moduleName = provider === "" || provider === "sqlite" ? ".prisma/client-sqlite" : "@prisma/client";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require(moduleName);
const original = PrismaClient.prototype.$executeRawUnsafe;
PrismaClient.prototype.$executeRawUnsafe = function patchedExecuteRawUnsafe(query, ...values) {
  if (/^\s*VACUUM\b/i.test(String(query))) {
    return Promise.reject(new Error("simulated compaction failure: database or disk is full (test fixture)"));
  }
  return original.call(this, query, ...values);
};
