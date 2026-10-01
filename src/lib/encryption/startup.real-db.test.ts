import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";

/**
 * Startup (field-encryption spec §2, "Startup sequence") against a REAL
 * database: the key check, the one-time encryption migration, its rollback,
 * the legacy `enc:` path, and how it coexists with the date migration.
 *
 * Harness and stall rules are the extension suite's
 * (./extension.real-db.test.ts):
 * - default: a throw-away SQLite file with `connection_limit=1`, migrated with
 *   `prisma migrate deploy`, deleted afterwards. The dev database is never
 *   touched.
 * - with ENCRYPTION_REAL_DB_PG_URL set (a scratch PostgreSQL database), the
 *   same suite runs against PostgreSQL.
 * - every Prisma call that could deadlock is raced against a timer.
 *
 * The key is the fixed test key from vitest.config.ts (`test.env`); tests
 * that need another key (or none) swap process.env and reset the key cache.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.ENCRYPTION_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-enc-startup-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

// Outside a request: the real next/headers throws, and the actor is `system`.
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => null),
  requireAuth: vi.fn(async () => null),
  requireAdmin: vi.fn(async () => null),
}));

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient, prisma } from "@/lib/prisma";
import { encryptValue, fingerprint, isEncrypted, keyId, EncryptionKeyError } from "@/lib/encryption/core.mjs";
import { getFieldKeys, resetFieldKeysForTests } from "@/lib/encryption/keys";
import { ENCRYPTED_FIELDS } from "@/lib/encryption/fields";
import { parsePlaintextValue } from "@/lib/encryption/extension";
import {
  assertEncryptionKey,
  decryptLegacyEnc,
  EncryptionMigrationError,
  LegacyDecryptError,
  runEncryptionMigration,
} from "@/lib/encryption/startup";
import { normalizeInstant, runLegacyDateMigration } from "@/lib/date-migration";
import { register } from "@/instrumentation";

type Row = Record<string, unknown>;

const TEST_KEY = process.env.BLACKVAULT_ENCRYPTION_KEY as string;
const OTHER_KEY = "11".repeat(32);
const LEGACY_KEY = "a5".repeat(32);

let raw: PrismaClient;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** Runs `fn` with BLACKVAULT_ENCRYPTION_KEY set to `key` (or unset), restoring the test key afterwards. */
async function withKey<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (key === null) delete process.env.BLACKVAULT_ENCRYPTION_KEY;
  else process.env.BLACKVAULT_ENCRYPTION_KEY = key;
  resetFieldKeysForTests();
  try {
    return await fn();
  } finally {
    process.env.BLACKVAULT_ENCRYPTION_KEY = TEST_KEY;
    resetFieldKeysForTests();
  }
}

/** The pre-V1 `encryptField` (src/lib/crypto.ts before V1), to seed legacy values. */
function legacyEncrypt(hex: string, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `enc:${iv.toString("base64")}:${ct.toString("base64")}:${c.getAuthTag().toString("base64")}`;
}

/** Every table a test here writes, emptied in FK order. */
async function wipe() {
  await raw.auditEvent.deleteMany();
  await raw.dateNormalizationAudit.deleteMany();
  await raw.authToken.deleteMany();
  await raw.accessory.deleteMany();
  await raw.gear.deleteMany();
  await raw.firearm.deleteMany();
  await raw.appSettings.deleteMany();
}

/** Every stored row of the three encrypted models plus settings and audit, exactly as stored. */
async function rawSnapshot(): Promise<string> {
  const order = { orderBy: { id: "asc" as const } };
  return JSON.stringify({
    firearm: await raw.firearm.findMany(order),
    accessory: await raw.accessory.findMany(order),
    gear: await raw.gear.findMany(order),
    settings: await raw.appSettings.findMany(order),
    audit: await raw.auditEvent.findMany(order),
  });
}

function canonical(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Application values of every row, minus the fingerprint (not an application value). */
function appView(rows: Row[]): Row[] {
  return rows
    .map(({ serialNumberHash: _h, ...rest }) => {
      void _h;
      return rest;
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

/** What the app SHOULD read for pre-encryption raw rows of `model`: the P3 forms parsed, legacy instants normalised in `zone`. */
function expectedAppView(model: "Firearm" | "Accessory" | "Gear", rows: Row[], zone = "UTC"): Row[] {
  return appView(
    rows.map((row) => {
      const out: Row = { ...row };
      for (const d of ENCRYPTED_FIELDS.filter((f) => f.model === model)) {
        const v = row[d.field];
        if (v === null || v === undefined) continue;
        const text = typeof v === "string" && v.startsWith("enc:") ? decryptLegacyEnc(v, { VAULT_ENCRYPTION_KEY: LEGACY_KEY }) : v;
        let parsed = parsePlaintextValue(model, d.field, text as string);
        if (parsed instanceof Date && parsed.getTime() % 86_400_000 !== 0) parsed = normalizeInstant(parsed, zone);
        out[d.field] = parsed;
      }
      return out;
    }),
  );
}

async function inventoryHash(): Promise<string> {
  return sha(
    canonical({
      firearm: appView((await prisma.firearm.findMany()) as unknown as Row[]),
      accessory: appView((await prisma.accessory.findMany()) as unknown as Row[]),
      gear: appView((await prisma.gear.findMany()) as unknown as Row[]),
    }),
  );
}

let seq = 0;
function firearm(overrides: Row = {}) {
  seq++;
  return {
    id: `f${String(seq).padStart(3, "0")}`,
    name: `Startup ${seq}`,
    manufacturer: "Glock",
    model: "19",
    caliber: "9mm",
    serialNumber: `SN-START-${seq}`,
    type: "PISTOL",
    acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Seeds pre-encryption plaintext the way an upgraded install holds it
 * (fields.ts P3): SQLite's numeric-string epoch-ms date and "200.0" tax,
 * Postgres's ISO date and "200" tax, a bare number, and a legacy instant.
 */
async function seedPlaintext() {
  await raw.firearm.create({
    data: firearm({
      id: "f-sqlite-form",
      serialNumber: "SN-PLAIN-1",
      nfaControlNumber: "CTRL-1",
      nfaRegisteredTo: "Trust One",
      nfaTransferMethod: "Form 4",
      nfaApprovalDate: "1790380800000",
      nfaTaxPaid: "200.0",
    }),
  });
  await raw.firearm.create({
    data: firearm({
      id: "f-pg-form",
      serialNumber: "SN-PLAIN-2",
      nfaApprovalDate: "2026-09-25T00:00:00.000Z",
      nfaTaxPaid: "200",
    }),
  });
  await raw.firearm.create({ data: firearm({ id: "f-number", serialNumber: "SN-PLAIN-3" }) });
  // A bare number in the text column (an INTEGER/REAL cell on SQLite; an assignment cast on Postgres).
  await raw.$executeRawUnsafe(`UPDATE "Firearm" SET "nfaTaxPaid" = 200 WHERE "id" = 'f-number'`);
  await raw.firearm.create({ data: firearm({ id: "f-no-nfa", serialNumber: "SN-PLAIN-4" }) });
  await raw.accessory.create({
    data: {
      id: "a-1",
      name: "Can",
      manufacturer: "SilencerCo",
      type: "SUPPRESSOR",
      serialNumber: "ACC-PLAIN-1",
      nfaControlNumber: "ACTRL-1",
      nfaApprovalDate: "1790380800000",
      nfaTaxPaid: "199.99",
    },
  });
  await raw.accessory.create({ data: { id: "a-2", name: "Light", manufacturer: "Surefire", type: "LIGHT" } });
  await raw.gear.create({ data: { id: "g-1", name: "Plate", category: "ARMOR", serialNumber: "GEAR-PLAIN-1" } });
  await raw.gear.create({ data: { id: "g-2", name: "Bag", category: "BAG" } });
}

async function rawRows() {
  const order = { orderBy: { id: "asc" as const } };
  return {
    firearm: (await raw.firearm.findMany(order)) as unknown as Row[],
    accessory: (await raw.accessory.findMany(order)) as unknown as Row[],
    gear: (await raw.gear.findMany(order)) as unknown as Row[],
  };
}

describe(`encryption startup against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  beforeAll(async () => {
    if (!ctx.pg) mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", ctx.pg ? "prisma/postgres/schema.prisma" : "prisma/sqlite/schema.prisma"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: ctx.pg ?? `file:${ctx.file}` },
        stdio: "pipe",
        timeout: 90_000,
      },
    );
    raw = createRawPrismaClient();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await raw?.$disconnect();
    if (!ctx.pg) rmSync(ctx.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await within(10_000, wipe());
    resetFieldKeysForTests();
  });

  afterEach(() => {
    delete process.env.VAULT_ENCRYPTION_KEY;
    vi.restoreAllMocks();
  });

  // ── 1 ──
  it("fresh empty DB with a key: creates the key check; a second start is a no-op", async () => {
    await within(10_000, assertEncryptionKey(raw));
    const settings = await raw.appSettings.findUnique({ where: { id: "singleton" } });
    expect(isEncrypted(settings?.encryptionKeyCheck)).toBe(true);
    expect(settings?.encryptionKeyCheck).toMatch(new RegExp(`^bv2:${keyId(Buffer.from(TEST_KEY, "hex"))}:`));
    expect(await within(10_000, runEncryptionMigration(raw))).toEqual({ counts: { Firearm: 0, Accessory: 0, Gear: 0 } });

    const before = await rawSnapshot();
    await within(10_000, assertEncryptionKey(raw));
    await within(10_000, runEncryptionMigration(raw));
    expect(await rawSnapshot()).toBe(before);
    expect(await raw.auditEvent.count()).toBe(0);
  });

  // ── 2 ──
  it("no key: KEY_MISSING naming both sources, and no row changes", async () => {
    await seedPlaintext();
    const before = await rawSnapshot();
    const err = await withKey(null, () => assertEncryptionKey(raw).catch((e) => e));
    expect(err).toBeInstanceOf(EncryptionKeyError);
    expect(err.code).toBe("KEY_MISSING");
    expect(err.message).toBe(
      "No encryption key. Looked for the file /nonexistent/blackvault-test/no-key-file and the env var BLACKVAULT_ENCRYPTION_KEY. Generate one with: openssl rand -hex 32",
    );
    expect(await rawSnapshot()).toBe(before);
  });

  // ── 3 ──
  it("wrong key against an existing key check: KEY_MISMATCH naming both key ids", async () => {
    await assertEncryptionKey(raw); // creates the check with the test key
    const before = await rawSnapshot();
    const err = await withKey(OTHER_KEY, () => assertEncryptionKey(raw).catch((e) => e));
    expect(err).toBeInstanceOf(EncryptionKeyError);
    expect(err.code).toBe("KEY_MISMATCH");
    const expectedId = keyId(Buffer.from(TEST_KEY, "hex"));
    const providedId = keyId(Buffer.from(OTHER_KEY, "hex"));
    expect(err.message).toContain(`encrypted with key ${expectedId}`);
    expect(err.message).toContain(`the provided key is ${providedId}`);
    expect(await rawSnapshot()).toBe(before);
  });

  it("a tampered key check is refused too (KEY_MISMATCH)", async () => {
    await assertEncryptionKey(raw);
    const check = (await raw.appSettings.findUnique({ where: { id: "singleton" } }))!.encryptionKeyCheck!;
    const parts = check.split(":");
    parts[3] = Buffer.from("not the check").toString("base64url");
    await raw.appSettings.update({ where: { id: "singleton" }, data: { encryptionKeyCheck: parts.join(":") } });
    await expect(assertEncryptionKey(raw)).rejects.toMatchObject({ code: "KEY_MISMATCH" });
  });

  // ── 4 ──
  it("key check absent while bv2: values exist: KEY_CHECK_LOST", async () => {
    await raw.gear.create({
      data: { id: "g-enc", name: "Plate", category: "ARMOR", serialNumber: encryptValue(getFieldKeys(), "Gear.serialNumber", "G-1") },
    });
    const err = await assertEncryptionKey(raw).catch((e) => e);
    expect(err).toBeInstanceOf(EncryptionKeyError);
    expect(err.code).toBe("KEY_CHECK_LOST");
    expect(await raw.appSettings.count()).toBe(0); // no fresh check minted over the lost one
  });

  // ── 5 ──
  it("plaintext data is migrated: every field bv2:, hashes filled, same app values, one event, second run writes nothing", async () => {
    await seedPlaintext();
    const seeded = await rawRows();
    const expectedHash = sha(
      canonical({
        firearm: expectedAppView("Firearm", seeded.firearm),
        accessory: expectedAppView("Accessory", seeded.accessory),
        gear: expectedAppView("Gear", seeded.gear),
      }),
    );

    await within(10_000, assertEncryptionKey(raw));
    const result = await within(30_000, runEncryptionMigration(raw));
    expect(result.counts).toEqual({ Firearm: 4, Accessory: 1, Gear: 1 });

    // Every listed, non-null field is ciphertext; every serial has its fingerprint.
    const after = await rawRows();
    const keys = getFieldKeys();
    for (const [model, rows] of [["Firearm", after.firearm], ["Accessory", after.accessory], ["Gear", after.gear]] as const) {
      for (const row of rows) {
        for (const d of ENCRYPTED_FIELDS.filter((f) => f.model === model)) {
          if (row[d.field] !== null) expect(row[d.field], `${model}.${d.field} ${row.id}`).toMatch(/^bv2:/);
        }
        const before = seeded[model.toLowerCase() as "firearm"].find((r) => r.id === row.id)!;
        expect(row.serialNumberHash).toBe(before.serialNumber === null ? null : fingerprint(keys, before.serialNumber as string));
        expect(row.updatedAt).toEqual(before.updatedAt); // encrypting is not an edit
      }
    }
    const f1 = after.firearm.find((r) => r.id === "f-sqlite-form")!;
    expect(f1.nfaControlNumber).toMatch(/^bv2:/);
    expect(after.firearm.find((r) => r.id === "f-no-nfa")!.nfaApprovalDate).toBeNull();

    // The app client reads exactly what the plaintext meant.
    expect(await inventoryHash()).toBe(expectedHash);
    const viaApp = await prisma.firearm.findUnique({ where: { id: "f-sqlite-form" } });
    expect(viaApp?.nfaApprovalDate).toEqual(new Date(1790380800000));
    expect(viaApp?.nfaTaxPaid).toBe(200);
    expect((await prisma.firearm.findUnique({ where: { id: "f-number" } }))?.nfaTaxPaid).toBe(200);
    expect((await prisma.firearm.findFirst({ where: { serialNumber: "SN-PLAIN-2" } }))?.id).toBe("f-pg-form");

    // Exactly one ENCRYPTION_ENABLED event, by system, with the counts and key id.
    const events = await raw.auditEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "ENCRYPTION_ENABLED", actorName: "system", actorId: null, entityType: null });
    expect(JSON.parse(events[0].changes!)).toEqual({ counts: { Firearm: 4, Accessory: 1, Gear: 1 }, keyId: keys.id });

    // A second start writes nothing.
    const snapshot = await rawSnapshot();
    await assertEncryptionKey(raw);
    expect((await runEncryptionMigration(raw)).counts).toEqual({ Firearm: 0, Accessory: 0, Gear: 0 });
    expect(await rawSnapshot()).toBe(snapshot);
  });

  it("a legacy non-midnight NFA date becomes its calendar day in the configured zone", async () => {
    await raw.appSettings.create({ data: { id: "singleton", timezone: "America/Denver" } });
    // 01:30Z on the 21st was 7:30pm on the 20th in Denver.
    await raw.firearm.create({ data: firearm({ id: "f-legacy-date", nfaApprovalDate: "2026-09-21T01:30:00.000Z" }) });
    await assertEncryptionKey(raw);
    await runEncryptionMigration(raw);
    const f = await prisma.firearm.findUnique({ where: { id: "f-legacy-date" } });
    expect(f?.nfaApprovalDate).toEqual(new Date("2026-09-20T00:00:00.000Z"));
    expect(await raw.dateNormalizationAudit.count()).toBe(0); // no plaintext copy of an encrypted field
  });

  // ── 6 ──
  it("legacy enc: values with the right VAULT_ENCRYPTION_KEY are migrated to bv2:", async () => {
    process.env.VAULT_ENCRYPTION_KEY = LEGACY_KEY;
    await raw.firearm.create({ data: firearm({ id: "f-legacy", serialNumber: legacyEncrypt(LEGACY_KEY, "SN-LEGACY-1") }) });
    await raw.accessory.create({
      data: { id: "a-legacy", name: "Can", manufacturer: "X", type: "SUPPRESSOR", nfaControlNumber: legacyEncrypt(LEGACY_KEY, "CTRL-L") },
    });
    await assertEncryptionKey(raw);
    expect((await runEncryptionMigration(raw)).counts).toEqual({ Firearm: 1, Accessory: 1, Gear: 0 });

    const stored = await raw.firearm.findUnique({ where: { id: "f-legacy" } });
    expect(stored?.serialNumber).toMatch(/^bv2:/);
    expect(stored?.serialNumberHash).toBe(fingerprint(getFieldKeys(), "SN-LEGACY-1"));
    expect((await prisma.firearm.findUnique({ where: { id: "f-legacy" } }))?.serialNumber).toBe("SN-LEGACY-1");
    expect((await prisma.accessory.findUnique({ where: { id: "a-legacy" } }))?.nfaControlNumber).toBe("CTRL-L");
  });

  it.each([
    ["absent", undefined, "VAULT_ENCRYPTION_KEY is not set"],
    ["wrong", "5a".repeat(32), "VAULT_ENCRYPTION_KEY is wrong"],
  ])("legacy enc: with VAULT_ENCRYPTION_KEY %s: refused, names the row and field, full rollback", async (_label, key, reason) => {
    if (key) process.env.VAULT_ENCRYPTION_KEY = key;
    await seedPlaintext(); // plaintext rows that WOULD have been converted first
    await raw.gear.create({ data: { id: "g-legacy", name: "Plate", category: "ARMOR", serialNumber: legacyEncrypt(LEGACY_KEY, "G-L") } });
    await assertEncryptionKey(raw);
    const before = await rawSnapshot();

    const err = await within(30_000, runEncryptionMigration(raw).catch((e) => e));
    expect(err).toBeInstanceOf(EncryptionMigrationError);
    expect(err).toMatchObject({ model: "Gear", id: "g-legacy", field: "serialNumber" });
    expect(err.message).toContain("Gear.serialNumber for id g-legacy");
    expect(err.message).toContain(reason);
    expect(err.message).toContain("Set VAULT_ENCRYPTION_KEY");
    expect(await rawSnapshot()).toBe(before); // Firearm/Accessory conversions rolled back too
  });

  // ── 7 ──
  it("a failure part-way (a throw on the third row) rolls everything back", async () => {
    await seedPlaintext();
    await assertEncryptionKey(raw);
    const before = await rawSnapshot();

    // The raw client, with its transaction client's firearm.update throwing on the third call.
    let updates = 0;
    const failing = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
          target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, p, r) {
                    if (p !== "firearm") return Reflect.get(t, p, r);
                    const delegate = Reflect.get(t, p, r) as unknown as Record<string, (a: unknown) => Promise<unknown>>;
                    return new Proxy(delegate, {
                      get(d, op, dr) {
                        if (op !== "update") return Reflect.get(d, op, dr);
                        return async (args: unknown) => {
                          if (++updates === 3) throw new Error("injected: disk I/O error");
                          return d.update(args);
                        };
                      },
                    });
                  },
                }),
              ),
            opts as never,
          );
      },
    });

    const err = await within(30_000, runEncryptionMigration(failing).catch((e) => e));
    expect(updates).toBe(3);
    expect(err).toBeInstanceOf(EncryptionMigrationError);
    expect(err.message).toContain("injected: disk I/O error");
    expect(await rawSnapshot()).toBe(before);
  });

  // ── carry M4 ──
  it("a serial with no fingerprint after the migration refuses to start, and rolls back", async () => {
    await seedPlaintext();
    await assertEncryptionKey(raw);
    // A bv2: serial whose hash was lost (e.g. a hand-copied row): the migration skips it, the assert catches it.
    await raw.firearm.create({
      data: firearm({ id: "f-nohash", serialNumber: encryptValue(getFieldKeys(), "Firearm.serialNumber", "SN-NOHASH") }),
    });
    const before = await rawSnapshot();
    const err = await runEncryptionMigration(raw).catch((e) => e);
    expect(err).toBeInstanceOf(EncryptionMigrationError);
    expect(err.message).toContain("1 Firearm row(s) have a serial number but no serialNumberHash");
    expect(await rawSnapshot()).toBe(before);
  });

  // ── 8 ──
  it("encryption migration then date migration (the startup order): each value converted once, ciphertext intact", async () => {
    await raw.appSettings.create({ data: { id: "singleton", timezone: "America/Denver" } });
    const legacy = new Date("2026-09-21T01:30:00.000Z"); // 7:30pm on the 20th in Denver
    await raw.firearm.create({
      data: firearm({ id: "f-dates", acquisitionDate: legacy, nfaApprovalDate: legacy.toISOString(), nfaTaxPaid: "200" }),
    });

    await assertEncryptionKey(raw);
    await runEncryptionMigration(raw);
    const encrypted = await raw.firearm.findUnique({ where: { id: "f-dates" } });

    const summary = await within(30_000, runLegacyDateMigration(prisma, "America/Denver"));
    expect(summary).toMatchObject({ normalized: 1, failed: 0 });

    const stored = await raw.firearm.findUnique({ where: { id: "f-dates" } });
    // The date migration rewrote only acquisitionDate; the encrypted columns are byte-identical.
    for (const d of ENCRYPTED_FIELDS.filter((f) => f.model === "Firearm")) {
      expect(stored?.[d.field as keyof typeof stored], d.field).toEqual(encrypted?.[d.field as keyof typeof encrypted]);
    }
    const app = await prisma.firearm.findUnique({ where: { id: "f-dates" } });
    expect(app?.acquisitionDate).toEqual(new Date("2026-09-20T00:00:00.000Z"));
    expect(app?.nfaApprovalDate).toEqual(new Date("2026-09-20T00:00:00.000Z"));
    expect(app?.nfaTaxPaid).toBe(200);
    expect((await raw.dateNormalizationAudit.findMany()).map((a) => a.field)).toEqual(["acquisitionDate"]);

    // Both again, in either order: nothing changes.
    const snapshot = await rawSnapshot();
    const audits = await raw.dateNormalizationAudit.findMany();
    await runLegacyDateMigration(prisma, "America/Denver");
    await runEncryptionMigration(raw);
    await runLegacyDateMigration(prisma, "America/Denver");
    expect(await rawSnapshot()).toBe(snapshot);
    expect(await raw.dateNormalizationAudit.findMany()).toEqual(audits);
  });

  it("why startup runs the date migration AFTER the encryption migration: before it, strict reads make it fail the row", async () => {
    const legacy = new Date("2026-09-21T01:30:00.000Z");
    await raw.firearm.create({ data: firearm({ id: "f-order", acquisitionDate: legacy }) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const early = await within(30_000, runLegacyDateMigration(prisma, "UTC"));
    // The audit layer's before-row read decrypts the whole row and meets the plaintext serial.
    expect(early).toMatchObject({ normalized: 0, failed: 1 });
    expect((await raw.firearm.findUnique({ where: { id: "f-order" } }))?.acquisitionDate).toEqual(legacy);

    await assertEncryptionKey(raw);
    await runEncryptionMigration(raw);
    const late = await within(30_000, runLegacyDateMigration(prisma, "UTC"));
    expect(late).toMatchObject({ normalized: 1, failed: 0 });
  });

  // ── 9 ──
  describe("register() in production mode", () => {
    const saved = { ...process.env };
    beforeEach(() => {
      Object.assign(process.env, { NODE_ENV: "production", NEXT_RUNTIME: "nodejs", PUBLIC_URL: "https://vault.example.com" });
      delete process.env.NEXT_PHASE;
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      process.env = { ...saved };
      resetFieldKeysForTests();
    });

    it("no key: refuses to start (exit 1) with the KEY_MISSING line, and changes nothing", async () => {
      await seedPlaintext();
      const before = await rawSnapshot();
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      await withKey(null, () => within(30_000, register()));
      expect(exit).toHaveBeenCalledWith(1);
      expect(vi.mocked(console.error).mock.calls[0][0]).toBe(
        "[encryption] No encryption key. Looked for the file /nonexistent/blackvault-test/no-key-file and the env var BLACKVAULT_ENCRYPTION_KEY. Generate one with: openssl rand -hex 32",
      );
      expect(await rawSnapshot()).toBe(before);
    });

    it("with the key: starts, and the seeded plaintext is encrypted", async () => {
      await seedPlaintext();
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      await within(60_000, register());
      expect(exit).not.toHaveBeenCalled();
      expect((await raw.firearm.findUnique({ where: { id: "f-sqlite-form" } }))?.serialNumber).toMatch(/^bv2:/);
      expect(await raw.auditEvent.count({ where: { action: "ENCRYPTION_ENABLED" } })).toBe(1);
    }, 90_000);
  });
});

// ─── Unit: decryptLegacyEnc ─────────────────────────────────────

describe("decryptLegacyEnc", () => {
  it("decrypts a value written by the pre-V1 encryptField", () => {
    expect(decryptLegacyEnc(legacyEncrypt(LEGACY_KEY, "SN-123 ünï"), { VAULT_ENCRYPTION_KEY: LEGACY_KEY })).toBe("SN-123 ünï");
  });

  it("throws (never returns a placeholder) when the key is missing, invalid or wrong, or the value is damaged", () => {
    const v = legacyEncrypt(LEGACY_KEY, "x");
    expect(() => decryptLegacyEnc(v, {})).toThrow(new LegacyDecryptError("VAULT_ENCRYPTION_KEY is not set; it is needed to read this legacy enc: value."));
    expect(() => decryptLegacyEnc(v, { VAULT_ENCRYPTION_KEY: "abc" })).toThrow(/must be 64 hex/);
    expect(() => decryptLegacyEnc(v, { VAULT_ENCRYPTION_KEY: OTHER_KEY })).toThrow(/is wrong/);
    expect(() => decryptLegacyEnc("enc:a:b", { VAULT_ENCRYPTION_KEY: LEGACY_KEY })).toThrow(/malformed/);
    const [iv, ct, tag] = v.slice(4).split(":");
    expect(() => decryptLegacyEnc(`enc:${iv}:${ct}:${tag.slice(0, 8)}`, { VAULT_ENCRYPTION_KEY: LEGACY_KEY })).toThrow(/malformed/);
    expect(() => decryptLegacyEnc("plain", { VAULT_ENCRYPTION_KEY: LEGACY_KEY })).toThrow(LegacyDecryptError);
  });

});
