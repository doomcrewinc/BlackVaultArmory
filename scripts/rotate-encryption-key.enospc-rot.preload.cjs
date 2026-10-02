"use strict";
// Test fixture for scripts/rotate-encryption-key.test.ts (spec 3b Task 5,
// Review Focus 5: disk full while writing a `.rot`).
//
// The first staged `.rot` is written normally. For the second one, the temp
// file's first write lands only HALF the bytes (a short write, as a filling
// disk produces) and the next write fails with ENOSPC — so a partial temp
// file really exists on disk at the moment of failure, and the test can prove
// it was cleaned up along with the `.rot` already staged.
//
// Loaded with `node --require <this file> scripts/rotate-encryption-key.mjs ...`;
// patches the same `fs.promises` object the script calls through.
// Test fixture only; never loaded by the real CLI.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fsp = require("node:fs").promises;
const originalOpen = fsp.open;
const ROT_TMP = /\.rot\.[0-9a-f]{8}\.tmp$/;
let rotOpens = 0;
fsp.open = async function patchedOpen(p, ...rest) {
  const handle = await originalOpen.call(this, p, ...rest);
  if (ROT_TMP.test(String(p)) && ++rotOpens === 2) {
    const realWrite = handle.write.bind(handle);
    let calls = 0;
    handle.write = async (buf, offset, length, ...more) => {
      calls++;
      if (calls === 1) return realWrite(buf, offset, Math.max(1, Math.floor(length / 2)), ...more);
      const e = new Error(`ENOSPC: no space left on device, write (test fixture) ${p}`);
      e.code = "ENOSPC";
      throw e;
    };
  }
  return handle;
};
