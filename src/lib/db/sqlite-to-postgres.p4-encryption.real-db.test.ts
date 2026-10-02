import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import type { PrismaClient } from "@prisma/client";
import { migrateSqliteToPostgres, MIGRATION_MODELS, type DbClient } from "./sqlite-to-postgres";
import { deriveKeys, decryptValue, encryptValue, fingerprint, loadMasterKey } from "../encryption/core.mjs";
import { aadFor } from "../encryption/fields";
import { encodeForStorage, withEncryption } from "../encryption/extension";

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
 * sqlite-to-postgres.test.ts uses: Firearm, Accessory AND Gear rows written
 * on SQLite through the field-encryption core (the exact module the app and
 * the rotation script import — no second copy of any crypto logic, spec §3),
 * including the type-changed `nfaApprovalDate`/`nfaTaxPaid` columns (the P3
 * risk: SQLite and Postgres store these as different stored
 * representations BEFORE encryption, but once encrypted they are opaque
 * `bv2:` text either way), land byte-identical on Postgres, the SAME key
 * still opens them there, and — the part that actually matters to a
 * migrated user — the real field-encryption extension's STRICT read path
 * (`src/lib/encryption/extension.ts`'s `withEncryption`) decodes the
 * migrated Postgres row back to the exact original plaintext, proving the
 * AAD (`<Model>.<field>`, fields.ts `aadFor`) really is provider-independent
 * as the plan note assumes.
 *
 * Fix round 1 (I6): the original version of this test seeded a Firearm
 * without the required `acquisitionDate`, which `PrismaClientValidationError`
 * at `beforeAll` — hidden by `any`-typed client variables. The clients below
 * are typed as the real `PrismaClient` (SQLite's generated client is
 * structurally identical — see src/lib/prisma.ts's own comment), so a future
 * missing required field fails `npm run typecheck`, not just a real
 * PostgreSQL run.
 *
 * Gated by ENCRYPTION_REAL_DB_PG_URL, the SAME env var the other encryption
 * real-DB suites use (src/lib/encryption/extension.real-db.test.ts,
 * src/lib/encryption/startup.real-db.test.ts) for their PostgreSQL leg — a
 * scratch database, reset by `prisma migrate deploy` in beforeAll, never
 * real data. Skipped entirely when it is not set.
 */
const PG_URL = process.env.ENCRYPTION_REAL_DB_PG_URL;

const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
const dir = `${base}/bv-p4-sqlite-to-pg-${process.pid}-${Date.now()}`;
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

/** Both generated clients share this constructor shape; see src/lib/prisma.ts's loadPrismaClient. */
type ClientCtor = new (options: { datasourceUrl: string }) => PrismaClient;

/** The subset of MIGRATION_MODELS' delegates this file needs for its own pre-test cleanup. */
type DeleteManyDelegate = { deleteMany(): Promise<unknown> };

const SERIAL = "P4-ENC-FIREARM-0001";
const ACCESSORY_SERIAL = "P4-ENC-ACCESSORY-0001";
const GEAR_SERIAL = "P4-ENC-GEAR-0001";
const CONTROL = "NFA-CTL-99";
const NFA_DATE = new Date("2024-03-01T00:00:00.000Z");
const NFA_TAX = 200.5;

describe.skipIf(!PG_URL)("P4: migrate-sqlite-to-postgres copies ciphertext and fingerprints unchanged", () => {
  let sqlite: PrismaClient;
  let postgres: PrismaClient;
  const keys = deriveKeys(loadMasterKey(process.env).key);

  const serialCipher = encryptValue(keys, aadFor("Firearm", "serialNumber"), SERIAL);
  const controlCipher = encryptValue(keys, aadFor("Firearm", "nfaControlNumber"), CONTROL);
  const serialHash = fingerprint(keys, SERIAL);
  const accessorySerialCipher = encryptValue(keys, aadFor("Accessory", "serialNumber"), ACCESSORY_SERIAL);
  const accessorySerialHash = fingerprint(keys, ACCESSORY_SERIAL);
  const gearSerialCipher = encryptValue(keys, aadFor("Gear", "serialNumber"), GEAR_SERIAL);
  const gearSerialHash = fingerprint(keys, GEAR_SERIAL);
  // The real app-code path for the type-changed columns (serialize, then
  // encrypt) — not hand-rolled, so this seed matches exactly what the
  // startup encryption migration / the app's own writes would have stored.
  const nfaApprovalDateCipher = encodeForStorage("Firearm", "nfaApprovalDate", NFA_DATE);
  const nfaTaxPaidCipher = encodeForStorage("Firearm", "nfaTaxPaid", NFA_TAX);

  beforeAll(async () => {
    mkdirSync(dir, { recursive: true });
    migrateSchema("sqlite", sqliteUrl);
    migrateSchema("postgres", PG_URL!);

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SqliteClient: ClientCtor = require(".prisma/client-sqlite").PrismaClient;
    sqlite = new SqliteClient({ datasourceUrl: sqliteUrl });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const PostgresClient: ClientCtor = require("@prisma/client").PrismaClient;
    postgres = new PostgresClient({ datasourceUrl: PG_URL! });

    // Target must be empty for the migrator's own refusal check; this is a
    // scratch database reset by `prisma migrate deploy`'s baseline, but a
    // previous failed run could have left rows — clear every table the
    // migrator touches before seeding the source.
    for (const m of [...MIGRATION_MODELS].reverse()) {
      await (postgres as unknown as Record<string, DeleteManyDelegate>)[m.delegate].deleteMany();
    }

    // Seed the SQLite SOURCE directly with the raw stored form (bv2:
    // ciphertext + hex fingerprint) — the same shape the app's encryption
    // extension would have written, bypassing it entirely since this test
    // wants exact control over the stored bytes it later diffs. Firearm's
    // acquisitionDate is required (fix round 1, I6).
    await sqlite.firearm.create({
      data: {
        id: "p4-firearm-1",
        name: "P4 Test Firearm",
        manufacturer: "Acme",
        model: "T1",
        caliber: "9mm",
        type: "PISTOL",
        acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
        serialNumber: serialCipher,
        serialNumberHash: serialHash,
        nfaControlNumber: controlCipher,
        nfaApprovalDate: nfaApprovalDateCipher,
        nfaTaxPaid: nfaTaxPaidCipher,
      },
    });
    await sqlite.accessory.create({
      data: {
        id: "p4-accessory-1",
        name: "P4 Test Accessory",
        manufacturer: "Acme",
        type: "SUPPRESSOR",
        serialNumber: accessorySerialCipher,
        serialNumberHash: accessorySerialHash,
      },
    });
    await sqlite.gear.create({
      data: {
        id: "p4-gear-1",
        name: "P4 Test Gear",
        category: "KNIFE",
        serialNumber: gearSerialCipher,
        serialNumberHash: gearSerialHash,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([sqlite?.$disconnect(), postgres?.$disconnect()]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("copies Firearm, Accessory and Gear from SQLite to PostgreSQL with VERIFIED output", async () => {
    const lines: string[] = [];
    // A narrow structural cast at this one boundary only: migrateSqliteToPostgres
    // takes the minimal DbClient shape (sqlite-to-postgres.ts), not the full
    // generated PrismaClient type, so its $transaction generic signature
    // does not line up with Prisma's own. Every seed/read call above and
    // below keeps the real PrismaClient type, which is what makes a missing
    // required field (fix round 1, I6) a typecheck error.
    const code = await migrateSqliteToPostgres({
      source: sqlite as unknown as DbClient,
      connectTarget: () => postgres as unknown as DbClient,
      dryRun: false,
      force: false,
      log: (l) => lines.push(l),
    });
    expect(code, lines.join("\n")).toBe(0);
    expect(lines.join("\n")).toContain("VERIFIED");
  });

  it("the ciphertext and fingerprints on Postgres are byte-identical to what SQLite stored", async () => {
    const firearm = await postgres.firearm.findUnique({ where: { id: "p4-firearm-1" } });
    expect(firearm).not.toBeNull();
    expect(firearm!.serialNumber).toBe(serialCipher);
    expect(firearm!.serialNumberHash).toBe(serialHash);
    expect(firearm!.nfaControlNumber).toBe(controlCipher);
    expect(firearm!.nfaApprovalDate).toBe(nfaApprovalDateCipher);
    expect(firearm!.nfaTaxPaid).toBe(nfaTaxPaidCipher);
    // Sanity: the copied value really is the bv2: envelope, not a re-encoded
    // or re-encrypted one.
    expect(firearm!.serialNumber.startsWith("bv2:")).toBe(true);

    const accessory = await postgres.accessory.findUnique({ where: { id: "p4-accessory-1" } });
    expect(accessory?.serialNumber).toBe(accessorySerialCipher);
    expect(accessory?.serialNumberHash).toBe(accessorySerialHash);

    const gear = await postgres.gear.findUnique({ where: { id: "p4-gear-1" } });
    expect(gear?.serialNumber).toBe(gearSerialCipher);
    expect(gear?.serialNumberHash).toBe(gearSerialHash);
  });

  it("the SAME key decrypts the Postgres-copied ciphertext directly (AAD is model+field, not provider)", async () => {
    const firearm = await postgres.firearm.findUnique({ where: { id: "p4-firearm-1" } });
    expect(decryptValue(keys, aadFor("Firearm", "serialNumber"), firearm!.serialNumber)).toBe(SERIAL);
    expect(decryptValue(keys, aadFor("Firearm", "nfaControlNumber"), firearm!.nfaControlNumber!)).toBe(CONTROL);
    expect(fingerprint(keys, SERIAL)).toBe(firearm!.serialNumberHash);

    const accessory = await postgres.accessory.findUnique({ where: { id: "p4-accessory-1" } });
    expect(decryptValue(keys, aadFor("Accessory", "serialNumber"), accessory!.serialNumber!)).toBe(ACCESSORY_SERIAL);

    const gear = await postgres.gear.findUnique({ where: { id: "p4-gear-1" } });
    expect(decryptValue(keys, aadFor("Gear", "serialNumber"), gear!.serialNumber!)).toBe(GEAR_SERIAL);
  });

  it("the real field-encryption extension, reading through Postgres, decodes every migrated row back to its original plaintext", async () => {
    // This is the case that actually matters to a migrated user: not core.mjs
    // called directly (above), but the SAME strict-read extension the app
    // uses (src/lib/encryption/extension.ts withEncryption), against the
    // POSTGRES client the migration just populated.
    const appPg = withEncryption(postgres);

    const firearm = await appPg.firearm.findUnique({ where: { id: "p4-firearm-1" } });
    expect(firearm?.serialNumber).toBe(SERIAL);
    expect(firearm?.nfaControlNumber).toBe(CONTROL);
    expect(firearm?.nfaApprovalDate).toBeInstanceOf(Date);
    expect((firearm?.nfaApprovalDate as unknown as Date).getTime()).toBe(NFA_DATE.getTime());
    expect(firearm?.nfaTaxPaid).toBe(NFA_TAX);

    const accessory = await appPg.accessory.findUnique({ where: { id: "p4-accessory-1" } });
    expect(accessory?.serialNumber).toBe(ACCESSORY_SERIAL);

    const gear = await appPg.gear.findUnique({ where: { id: "p4-gear-1" } });
    expect(gear?.serialNumber).toBe(GEAR_SERIAL);
  });
});
