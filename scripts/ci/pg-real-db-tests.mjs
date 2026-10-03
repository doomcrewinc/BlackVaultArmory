// Runs the real-database PostgreSQL test files one at a time, each against its
// own freshly created database on the server named by PG_REAL_DB_ADMIN_URL
// (a URL for any database on that server, e.g. the `postgres` one).
// The files migrate and wipe the database they are given and encrypt rows
// under their own keys, so two of them must never share one.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

const FILES = [
  "src/lib/backup/records.real-db.test.ts",
  "src/lib/backup/full-backup.real-db.test.ts",
  "src/lib/backup/full-restore.real-db.test.ts",
  "src/lib/db/sqlite-to-postgres.p4-encryption.real-db.test.ts",
  "src/lib/encryption/extension.real-db.test.ts",
  "src/lib/encryption/startup.real-db.test.ts",
  "src/lib/audit/extension.real-db.test.ts",
  "src/lib/audit/query.real-db.test.ts",
  "src/app/api/admin/audit/export/route.real-db.test.ts",
  "scripts/rotate-encryption-key.test.ts",
];

const adminUrl = process.env.PG_REAL_DB_ADMIN_URL;
if (!adminUrl) {
  console.error("PG_REAL_DB_ADMIN_URL is not set.");
  process.exit(2);
}

const admin = new PrismaClient({ datasourceUrl: adminUrl });
let failed = 0;
try {
  for (const [i, file] of FILES.entries()) {
    const name = `bv_scratch_test_${process.pid}_${i}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    try {
      const run = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", file], {
        stdio: "inherit",
        env: { ...process.env, ENCRYPTION_REAL_DB_PG_URL: url.href, AUDIT_REAL_DB_PG_URL: url.href },
      });
      if (run.status !== 0) {
        failed += 1;
        console.error(`FAILED: ${file}`);
      }
    } finally {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
  }
} finally {
  await admin.$disconnect();
}
process.exit(failed ? 1 : 0);
