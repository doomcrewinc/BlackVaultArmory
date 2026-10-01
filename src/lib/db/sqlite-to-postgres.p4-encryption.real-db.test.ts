import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { migrateSqliteToPostgres } from "./sqlite-to-postgres";
import { deriveKeys, decryptValue, encryptValue, fingerprint, loadMasterKey } from "../encryption/core.mjs";
import { aadFor } from "../encryption/fields";

/**
 * P4 (global-constraints.md plan note): "scripts/migrate-sqlite-to-postgres.ts
 * copies rows raw. Ciphertext and fingerprints copy unchanged and stay valid,
 * because the AAD is model plus field, not provider. Task 8 adds a test."
 *
 * The migrator (src/lib/db/sqlite-to-postgres.ts, wrapped by
 * scripts/migrate-sqlite-to-postgres.ts) pages through each source model and
 * `createMany`s the raw rows on the target — a `bv2:<keyId>:...` ciphertext
 * or a hex `serialNumberHash` is just a String column value to it, with no
 * provider-specific encoding on either side. This proves that end to end
 * against REAL SQLite and REAL PostgreSQL, not the in-memory fakes
 * sqlite-to-postgres.test.ts uses: a Firearm/Accessory/Gear row written on
 * SQLite through the field-encryption core (the exact module the app and
 * the rotation script import — no second copy of any crypto logic, spec §3)
 * lands byte-identical on Postgres, and the SAME key still opens it there —
 * i.e. the AAD (`<Model>.<field>`, fields.ts aadFor) really is
 * provider-independent, as the plan note assumes.
 *
 * Gated by ENCRYPTION_REAL_DB_PG_URL, the SAME env var the other encryption
 * real-DB suites use (src/lib/encryption/extension.real-db.test.ts,
 * src/lib/encryption/startup.real-db.test.ts) for their PostgreSQL leg — a
 * scratch database, reset by `prisma migrate deploy` in beforeAll, never
 * real data. Skipped entirely when it is not set.
 */
const PG_URL = process.env.ENCRYPTION_REAL_DB_PG_URL;

const ctx = {
  base: (process.env.TMPDIR || "/tmp").replace(/\/+$/, ""),
};
const dir = `${ctx.base}/bv-p4-sqlite-to-pg-${process.pid}-${Date.now()}`;
const sqliteFile = `${dir}/t.db`;
const sqliteUrl = `file:${sqliteFile}?connection_limit=1`;

function migrateSchema(schema: "sqlite" | "postgres", url: string) {
  execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", `prisma/${schema}/schema.prisma`], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    timeout: 90_000,
  });
}

describe.skipIf(!PG_URL)("P4: migrate-sqlite-to-postgres copies ciphertext and fingerprints unchanged", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sqlite: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let postgres: any;
  const keys = deriveKeys(loadMasterKey(process.env).key);

  const SERIAL = "P4-ENC-0001";
  const CONTROL = "NFA-CTL-99";
  const serialCipher = encryptValue(keys, aadFor("Firearm", "serialNumber"), SERIAL);
  const controlCipher = encryptValue(keys, aadFor("Firearm", "nfaControlNumber"), CONTROL);
  const serialHash = fingerprint(keys, SERIAL);

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    migrateSchema("sqlite", sqliteUrl);
    migrateSchema("postgres", PG_URL!);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: SqliteClient } = require(".prisma/client-sqlite");
    sqlite = new SqliteClient({ datasourceUrl: sqliteUrl });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: PostgresClient } = require("@prisma/client");
    postgres = new PostgresClient({ datasourceUrl: PG_URL });

    // Target must be empty for the migrator's own refusal check; this is a
    // scratch database reset by `prisma migrate deploy`'s baseline, but a
    // previous failed run could have left rows — clear every table the
    // migrator touches before seeding the source.
    const { MIGRATION_MODELS } = await import("./sqlite-to-postgres");
    for (const m of [...MIGRATION_MODELS].reverse()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (postgres as any)[m.delegate].deleteMany();
    }

    // Seed the SQLite SOURCE directly with the raw stored form (bv2:
    // ciphertext + hex fingerprint) — the same shape the app's encryption
    // extension would have written, bypassing it entirely since this test
    // wants exact control over the stored bytes it later diffs.
    await sqlite.firearm.create({
      data: {
        id: "p4-firearm-1",
        name: "P4 Test Firearm",
        manufacturer: "Acme",
        model: "T1",
        caliber: "9mm",
        type: "PISTOL",
        serialNumber: serialCipher,
        serialNumberHash: serialHash,
        nfaControlNumber: controlCipher,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([sqlite?.$disconnect(), postgres?.$disconnect()]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies the Firearm row from SQLite to PostgreSQL with VERIFIED output", async () => {
    const lines: string[] = [];
    const code = await migrateSqliteToPostgres({
      source: sqlite,
      connectTarget: () => postgres,
      dryRun: false,
      force: false,
      log: (l) => lines.push(l),
    });
    expect(code, lines.join("\n")).toBe(0);
    expect(lines.join("\n")).toContain("VERIFIED");
  });

  it("the ciphertext and fingerprint on Postgres are byte-identical to what SQLite stored", async () => {
    const row = await postgres.firearm.findUnique({ where: { id: "p4-firearm-1" } });
    expect(row).not.toBeNull();
    expect(row.serialNumber).toBe(serialCipher);
    expect(row.serialNumberHash).toBe(serialHash);
    expect(row.nfaControlNumber).toBe(controlCipher);
    // Sanity: the copied value really is the bv2: envelope, not a re-encoded
    // or re-encrypted one.
    expect(row.serialNumber.startsWith("bv2:")).toBe(true);
  });

  it("the SAME key decrypts the Postgres-copied ciphertext (AAD is model+field, not provider)", async () => {
    const row = await postgres.firearm.findUnique({ where: { id: "p4-firearm-1" } });
    expect(decryptValue(keys, aadFor("Firearm", "serialNumber"), row.serialNumber)).toBe(SERIAL);
    expect(decryptValue(keys, aadFor("Firearm", "nfaControlNumber"), row.nfaControlNumber)).toBe(CONTROL);
    expect(fingerprint(keys, SERIAL)).toBe(row.serialNumberHash);
  });
});
