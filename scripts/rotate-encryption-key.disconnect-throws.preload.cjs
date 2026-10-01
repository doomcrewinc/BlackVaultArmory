"use strict";
// Test fixture for scripts/rotate-encryption-key.test.ts (fix round 1, C1).
//
// Patches the generated Prisma client's $disconnect so it throws AFTER
// calling through to the real implementation — simulating a connection
// teardown failure (or an EPIPE-shaped failure) that happens strictly after
// a transaction has already committed. Proves the reviewer's finding: that
// scripts/rotate-encryption-key.mjs must exit 0 in this case, because the
// rotation itself already succeeded.
//
// Loaded with `node --require <this file> scripts/rotate-encryption-key.mjs ...`.
// Plain require() here resolves from this file's own location (scripts/),
// the SAME directory scripts/rotate-encryption-key.mjs resolves
// ".prisma/client-sqlite" / "@prisma/client" from (via its own
// createRequire(import.meta.url)) — so this patches the exact class that
// script instantiates. Test fixture only; never loaded by the real CLI.
const provider = (process.env.DB_PROVIDER || "").trim().toLowerCase();
const moduleName = provider === "" || provider === "sqlite" ? ".prisma/client-sqlite" : "@prisma/client";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require(moduleName);
const original = PrismaClient.prototype.$disconnect;
PrismaClient.prototype.$disconnect = async function patchedDisconnect(...args) {
  await original.apply(this, args);
  throw new Error("simulated post-commit disconnect failure (test fixture)");
};
