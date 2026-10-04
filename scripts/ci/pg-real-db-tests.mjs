// Runs the real-database PostgreSQL test files one at a time, each against its
// own freshly created database on the server named by PG_REAL_DB_ADMIN_URL
// (a URL for any database on that server, e.g. the `postgres` one).
// The files migrate and wipe the database they are given and encrypt rows
// under their own keys, so two of them must never share one.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

// The files to run live in pg-real-db-files.json; pg-real-db-files.test.ts fails
// if a test file that reads a PostgreSQL URL is missing from it.
const FILES = JSON.parse(readFileSync(new URL("./pg-real-db-files.json", import.meta.url), "utf8"));

const adminUrl = process.env.PG_REAL_DB_ADMIN_URL;
if (!adminUrl) {
  console.error("PG_REAL_DB_ADMIN_URL is not set.");
  process.exit(2);
}

// One file may take this long; a test that hangs on the database is then
// killed and counted as failed instead of holding the runner.
const FILE_TIMEOUT_MS = 10 * 60_000;

const admin = new PrismaClient({ datasourceUrl: adminUrl });

// Creates a database for one test file, runs the file against it, and drops
// the database whether or not the file passed. Resolves to true when the
// file passed.
async function runOnOwnDatabase(file, index) {
  const name = `bv_scratch_test_${process.pid}_${index}`;
  await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  try {
    const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", file], {
      stdio: "inherit",
      env: { ...process.env, ENCRYPTION_REAL_DB_PG_URL: url.href, AUDIT_REAL_DB_PG_URL: url.href, BV_TEST_POSTGRES_URL: url.href },
      timeout: FILE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    if (run.error?.code === "ETIMEDOUT") {
      console.error(`TIMED OUT after ${FILE_TIMEOUT_MS / 60_000} minutes: ${file}`);
    }
    return run.status === 0;
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }
}

let failed = 0;
try {
  // Serial on purpose: every file gets its own database and runs to completion
  // (and the database is dropped) before the next starts, so the await in this
  // loop is the point, not a missed Promise.all.
  for (const [i, file] of FILES.entries()) {
    const passed = await runOnOwnDatabase(file, i);
    if (!passed) {
      failed += 1;
      console.error(`FAILED: ${file}`);
    }
  }
} finally {
  await admin.$disconnect();
}
process.exit(failed ? 1 : 0);
