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

const admin = new PrismaClient({ datasourceUrl: adminUrl });
let failed = 0;
try {
  // Serial on purpose: every file gets its own database and runs to completion
  // (and the database is dropped) before the next starts, so the awaits in this
  // loop are the point, not a missed Promise.all.
  for (const [i, file] of FILES.entries()) {
    const name = `bv_scratch_test_${process.pid}_${i}`;
    // Serial on purpose (see above): this database must exist before the file runs.
    await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    try {
      const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", file], {
        stdio: "inherit",
        env: { ...process.env, ENCRYPTION_REAL_DB_PG_URL: url.href, AUDIT_REAL_DB_PG_URL: url.href, BV_TEST_POSTGRES_URL: url.href },
      });
      if (run.status !== 0) {
        failed += 1;
        console.error(`FAILED: ${file}`);
      }
    } finally {
      // Serial on purpose (see above): drop this file's database before the next one is created.
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  }
} finally {
  await admin.$disconnect();
}
process.exit(failed ? 1 : 0);
