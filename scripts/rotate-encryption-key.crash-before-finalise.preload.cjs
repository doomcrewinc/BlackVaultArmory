"use strict";
// Test fixture for scripts/rotate-encryption-key.test.ts (spec 3b Task 5).
//
// Kills the process (exit 9) the instant the rotation tries to rename a staged
// `<name>.rot` over its original — i.e. AFTER the database transaction has
// committed and BEFORE the finalise step moves any file. Staging itself also
// renames, but from `<name>.rot.<8hex>.tmp` (writeAtomic's temp), never from a
// path ending in `.rot`, so staging is not affected.
//
// Loaded with `node --require <this file> scripts/rotate-encryption-key.mjs ...`.
// The script reaches fs through `import { promises as fsp } from "node:fs"` and
// calls `fsp.rename(...)` through that object, which is this same object.
// Test fixture only; never loaded by the real CLI.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsp = require("node:fs").promises;
const original = fsp.rename;
fsp.rename = function patchedRename(src, dest) {
  if (String(src).endsWith(".rot")) {
    process.stderr.write(`[test fixture] simulated crash before renaming ${src}\n`);
    process.exit(9);
  }
  return original.call(this, src, dest);
};
