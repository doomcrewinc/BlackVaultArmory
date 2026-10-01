import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

/**
 * scripts/rotate-encryption-key.mjs against REAL databases, run exactly as
 * the container runs it: `node scripts/rotate-encryption-key.mjs --old-key-file
 * <path> --new-key-file <path>` (field-encryption spec §3 "Rotation").
 *
 * Harness mirrors src/lib/encryption/startup.real-db.test.ts:
 * - default: a throw-away SQLite file with `connection_limit=1`, migrated with
 *   `prisma migrate deploy`, deleted afterwards. The dev database is never touched.
 * - with ENCRYPTION_REAL_DB_PG_URL set (a scratch PostgreSQL database), the
 *   same suite runs against PostgreSQL.
 *
 * Key material never goes through BLACKVAULT_ENCRYPTION_KEY (the fixed test
 * key vitest.config.ts pins for every other suite): this script reads two
 * explicit key FILES, so each test writes its own old/new key files into a
 * scratch dir and passes them as --old-key-file/--new-key-file.
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.ENCRYPTION_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-rotate-key-${process.pid}-${Date.now()}`;
  if (pg) {
    process.env.DB_PROVIDER = "postgresql";
    process.env.DATABASE_URL = pg;
  } else {
    process.env.DB_PROVIDER = "sqlite";
    process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  }
  return { pg, dir, file: `${dir}/t.db` };
});

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient } from "@/lib/prisma";
import { decryptValue, deriveKeys, encryptValue, envelopeKeyId, fingerprint, generateKeyHex, parseKeyHex } from "@/lib/encryption/core.mjs";
import { aadFor, ENCRYPTED_FIELDS } from "@/lib/encryption/fields";
import { ENCRYPTED_FIELDS as ROTATION_FIELDS } from "./rotate-encryption-key.mjs";

type Row = Record<string, unknown>;
type FieldKeysLike = { id: string; enc: Buffer; idx: Buffer };

const KEY_CHECK_AAD = "AppSettings.encryptionKeyCheck";
const KEY_CHECK_PLAINTEXT = "blackvault-key-check";

// ── the mirror itself (no DB needed) ──────────────────────────────
describe("scripts/rotate-encryption-key.mjs's ENCRYPTED_FIELDS mirror", () => {
  it("is byte-for-byte identical to src/lib/encryption/fields.ts's ENCRYPTED_FIELDS", () => {
    const sortKey = (f: { model: string; field: string }) => `${f.model}.${f.field}`;
    const real = [...ENCRYPTED_FIELDS].map((f) => ({ ...f })).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const mirrored = [...ROTATION_FIELDS].map((f) => ({ ...f })).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    expect(mirrored).toEqual(real);
  });
});

// ── real-DB suite ──────────────────────────────────────────────────
describe(`scripts/rotate-encryption-key.mjs against real ${ctx.pg ? "PostgreSQL" : "SQLite (connection_limit=1)"}`, () => {
  let raw: PrismaClient;

  function within<T>(ms: number, p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
    });
    return Promise.race([p, limit]).finally(() => clearTimeout(timer));
  }

  function keyFile(name: string, hex: string): string {
    const p = `${ctx.dir}/${name}`;
    writeFileSync(p, hex, "utf8");
    return p;
  }

  function keysFromHex(hex: string): FieldKeysLike {
    return deriveKeys(parseKeyHex(hex));
  }

  function runScript(args: string[]) {
    return spawnSync("node", ["scripts/rotate-encryption-key.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env },
    });
  }

  /** Every table this suite writes, emptied in FK order. */
  async function wipe() {
    await raw.auditEvent.deleteMany();
    await raw.accessory.deleteMany();
    await raw.gear.deleteMany();
    await raw.firearm.deleteMany();
    await raw.appSettings.deleteMany();
  }

  /** Every stored row exactly as stored — proves "nothing changed" byte for byte. */
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

  function enc(keys: FieldKeysLike, model: string, field: string, plaintext: string): string {
    return encryptValue(keys, aadFor(model, field), plaintext);
  }

  /** Seeds one Firearm (full NFA paperwork), one bare Firearm (serial only), one Accessory, one Gear, and the key check — all under `keys`. */
  async function seed(keys: FieldKeysLike) {
    await raw.firearm.create({
      data: {
        id: "f-nfa",
        name: "Rotate Test NFA",
        manufacturer: "Glock",
        model: "19",
        caliber: "9mm",
        serialNumber: enc(keys, "Firearm", "serialNumber", "SN-ROTATE-1"),
        serialNumberHash: fingerprint(keys, "SN-ROTATE-1"),
        type: "PISTOL",
        nfaClass: "SBR",
        nfaTransferMethod: enc(keys, "Firearm", "nfaTransferMethod", "FORM_1"),
        nfaControlNumber: enc(keys, "Firearm", "nfaControlNumber", "CTRL-0001"),
        nfaApprovalDate: enc(keys, "Firearm", "nfaApprovalDate", "2026-01-15T00:00:00.000Z"),
        nfaTaxPaid: enc(keys, "Firearm", "nfaTaxPaid", "200"),
        nfaRegisteredTo: enc(keys, "Firearm", "nfaRegisteredTo", "Family Trust"),
        acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
      },
    });
    await raw.firearm.create({
      data: {
        id: "f-plain",
        name: "Rotate Test Plain",
        manufacturer: "Sig",
        model: "P320",
        caliber: "9mm",
        serialNumber: enc(keys, "Firearm", "serialNumber", "SN-ROTATE-2"),
        serialNumberHash: fingerprint(keys, "SN-ROTATE-2"),
        type: "PISTOL",
        acquisitionDate: new Date("2024-02-01T00:00:00.000Z"),
      },
    });
    await raw.accessory.create({
      data: {
        id: "a-nfa",
        name: "Rotate Test Can",
        manufacturer: "SilencerCo",
        type: "SUPPRESSOR",
        serialNumber: enc(keys, "Accessory", "serialNumber", "ACC-ROTATE-1"),
        serialNumberHash: fingerprint(keys, "ACC-ROTATE-1"),
        nfaControlNumber: enc(keys, "Accessory", "nfaControlNumber", "ACTRL-0001"),
        nfaApprovalDate: enc(keys, "Accessory", "nfaApprovalDate", "2026-02-01T00:00:00.000Z"),
        nfaTaxPaid: enc(keys, "Accessory", "nfaTaxPaid", "200"),
      },
    });
    await raw.accessory.create({ data: { id: "a-plain", name: "Light", manufacturer: "Surefire", type: "LIGHT" } });
    await raw.gear.create({
      data: {
        id: "g-1",
        name: "Plate",
        category: "ARMOR",
        serialNumber: enc(keys, "Gear", "serialNumber", "GEAR-ROTATE-1"),
        serialNumberHash: fingerprint(keys, "GEAR-ROTATE-1"),
      },
    });
    await raw.appSettings.create({
      data: { id: "singleton", encryptionKeyCheck: encryptValue(keys, KEY_CHECK_AAD, KEY_CHECK_PLAINTEXT) },
    });
  }

  beforeAll(async () => {
    mkdirSync(ctx.dir, { recursive: true }); // also holds the key files, even on Postgres
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
    await raw?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await within(10_000, wipe());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rotates every registered field, every fingerprint and the key check; writes exactly one KEY_ROTATED event", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);

    const oldKeyFile = keyFile("old-1", oldHex);
    const newKeyFile = keyFile("new-1", newHex);
    const result = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Rotated encryption key ${oldKeys.id} -> ${newKeys.id}`);
    expect(result.stdout).not.toContain(oldHex);
    expect(result.stdout).not.toContain(newHex);
    expect(result.stderr).not.toContain(oldHex);
    expect(result.stderr).not.toContain(newHex);

    const firearms = await raw.firearm.findMany({ orderBy: { id: "asc" } });
    const nfaFirearm = firearms.find((f) => f.id === "f-nfa")!;
    const plainFirearm = firearms.find((f) => f.id === "f-plain")!;

    for (const d of ENCRYPTED_FIELDS.filter((f) => f.model === "Firearm")) {
      const stored = (nfaFirearm as Row)[d.field] as string | null;
      expect(stored, `Firearm.${d.field}`).not.toBeNull();
      expect(envelopeKeyId(stored as string)).toBe(newKeys.id);
    }
    expect(decryptValue(newKeys, aadFor("Firearm", "serialNumber"), nfaFirearm.serialNumber as unknown as string)).toBe("SN-ROTATE-1");
    expect(decryptValue(newKeys, aadFor("Firearm", "nfaControlNumber"), nfaFirearm.nfaControlNumber as string)).toBe("CTRL-0001");
    expect(decryptValue(newKeys, aadFor("Firearm", "nfaRegisteredTo"), nfaFirearm.nfaRegisteredTo as string)).toBe("Family Trust");
    expect(decryptValue(newKeys, aadFor("Firearm", "nfaTransferMethod"), nfaFirearm.nfaTransferMethod as string)).toBe("FORM_1");
    expect(decryptValue(newKeys, aadFor("Firearm", "nfaApprovalDate"), nfaFirearm.nfaApprovalDate as string)).toBe("2026-01-15T00:00:00.000Z");
    expect(decryptValue(newKeys, aadFor("Firearm", "nfaTaxPaid"), nfaFirearm.nfaTaxPaid as string)).toBe("200");
    expect(nfaFirearm.serialNumberHash).toBe(fingerprint(newKeys, "SN-ROTATE-1"));

    // The bare firearm's null NFA fields stay null; only its serial moves.
    expect(plainFirearm.nfaControlNumber).toBeNull();
    expect(envelopeKeyId(plainFirearm.serialNumber as unknown as string)).toBe(newKeys.id);
    expect(decryptValue(newKeys, aadFor("Firearm", "serialNumber"), plainFirearm.serialNumber as unknown as string)).toBe("SN-ROTATE-2");
    expect(plainFirearm.serialNumberHash).toBe(fingerprint(newKeys, "SN-ROTATE-2"));

    const accessories = await raw.accessory.findMany({ orderBy: { id: "asc" } });
    const nfaAccessory = accessories.find((a) => a.id === "a-nfa")!;
    const plainAccessory = accessories.find((a) => a.id === "a-plain")!;
    expect(decryptValue(newKeys, aadFor("Accessory", "serialNumber"), nfaAccessory.serialNumber as string)).toBe("ACC-ROTATE-1");
    expect(nfaAccessory.serialNumberHash).toBe(fingerprint(newKeys, "ACC-ROTATE-1"));
    expect(decryptValue(newKeys, aadFor("Accessory", "nfaControlNumber"), nfaAccessory.nfaControlNumber as string)).toBe("ACTRL-0001");
    expect(plainAccessory.serialNumber).toBeNull();
    expect(plainAccessory.serialNumberHash).toBeNull();

    const gear = await raw.gear.findUniqueOrThrow({ where: { id: "g-1" } });
    expect(decryptValue(newKeys, aadFor("Gear", "serialNumber"), gear.serialNumber as string)).toBe("GEAR-ROTATE-1");
    expect(gear.serialNumberHash).toBe(fingerprint(newKeys, "GEAR-ROTATE-1"));

    // Key check opens with the NEW key and not the old one.
    const settings = await raw.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    const check = settings.encryptionKeyCheck as string;
    expect(envelopeKeyId(check)).toBe(newKeys.id);
    expect(decryptValue(newKeys, KEY_CHECK_AAD, check)).toBe(KEY_CHECK_PLAINTEXT);
    expect(() => decryptValue(oldKeys, KEY_CHECK_AAD, check)).toThrow(/KEY_MISMATCH|Value was encrypted with key/);

    // Exactly one KEY_ROTATED event.
    const events = await raw.auditEvent.findMany({ where: { action: "KEY_ROTATED" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: null,
      actorName: "system (key rotation)",
      actorIp: null,
      action: "KEY_ROTATED",
    });
    const changes = JSON.parse(events[0].changes as string);
    expect(changes.from).toBe(oldKeys.id);
    expect(changes.to).toBe(newKeys.id);
    expect(changes.counts).toMatchObject({ Firearm: 2, Accessory: 1, Gear: 1 });
    expect(JSON.stringify(changes)).not.toContain(oldHex);
    expect(JSON.stringify(changes)).not.toContain(newHex);
  }, 60_000);

  it("refuses when the old key does not open the key check, and changes nothing", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const wrongHex = generateKeyHex();
    await seed(keysFromHex(oldHex));

    const before = await rawSnapshot();
    const wrongKeyFile = keyFile("old-wrong", wrongHex);
    const newKeyFile = keyFile("new-2", newHex);
    const result = runScript(["--old-key-file", wrongKeyFile, "--new-key-file", newKeyFile]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not match this database's encryption key check/);
    expect(result.stdout).toBe("");
    expect(await rawSnapshot()).toBe(before);
    expect(await raw.auditEvent.count()).toBe(0);
  }, 60_000);

  it("a failure injected mid-transaction (one row under a third, unrelated key) leaves no row changed", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const thirdHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    await seed(oldKeys);

    // Corrupt one field on the accessory (processed after Firearm in model
    // order) so decryptValue throws KEY_MISMATCH partway through the
    // transaction, after the Firearm rows have already been updated on the
    // SAME transaction client — proving the whole thing rolls back together.
    await raw.accessory.update({
      where: { id: "a-nfa" },
      data: { nfaControlNumber: enc(keysFromHex(thirdHex), "Accessory", "nfaControlNumber", "CTRL-WRONG-KEY") },
    });

    const before = await rawSnapshot();
    const oldKeyFile = keyFile("old-3", oldHex);
    const newKeyFile = keyFile("new-3", newHex);
    const result = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/KEY_MISMATCH|Value was encrypted with key/);
    expect(await rawSnapshot()).toBe(before);
    expect(await raw.auditEvent.count()).toBe(0);
    // The key check must still be the OLD one — a half-applied rotation
    // would otherwise strand the database between two keys.
    const settings = await raw.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(decryptValue(oldKeys, KEY_CHECK_AAD, settings.encryptionKeyCheck as string)).toBe(KEY_CHECK_PLAINTEXT);
  }, 60_000);

  it("running the script twice with the same old key fails the second time (key check mismatch), and the second run changes nothing", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const thirdHex = generateKeyHex();
    await seed(keysFromHex(oldHex));

    const oldKeyFile = keyFile("old-4", oldHex);
    const newKeyFile = keyFile("new-4", newHex);
    const first = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(first.status, `stderr: ${first.stderr}`).toBe(0);

    const afterFirst = await rawSnapshot();
    const thirdKeyFile = keyFile("new-4b", thirdHex);
    const second = runScript(["--old-key-file", oldKeyFile, "--new-key-file", thirdKeyFile]);

    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/does not match this database's encryption key check/);
    expect(await rawSnapshot()).toBe(afterFirst);
    expect(await raw.auditEvent.count()).toBe(1); // still just the first run's event
  }, 60_000);

  it("refuses with no encryption key check at all (never started with a key), and changes nothing", async () => {
    // No seed() call: an empty database, so appSettings.encryptionKeyCheck is absent.
    const oldKeyFile = keyFile("old-5", generateKeyHex());
    const newKeyFile = keyFile("new-5", generateKeyHex());
    const result = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No encryption key check found/);
    expect(await raw.auditEvent.count()).toBe(0);
  }, 60_000);

  it("usage: missing flags exit 2 with a usage message, before touching the database", async () => {
    const result = runScript([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: node scripts/rotate-encryption-key.mjs --old-key-file <path> --new-key-file <path>");
  });

  it("a nonexistent key file exits 1 naming the flag, not the key", async () => {
    const newKeyFile = keyFile("new-6", generateKeyHex());
    const result = runScript(["--old-key-file", `${ctx.dir}/does-not-exist`, "--new-key-file", newKeyFile]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--old-key-file");
    expect(result.stderr).toContain("no such file");
  });

  it("a malformed key file exits 1 with a one-line message, no stack trace", async () => {
    const badKeyFile = keyFile("bad-key", "not-64-hex-characters");
    const newKeyFile = keyFile("new-7", generateKeyHex());
    const result = runScript(["--old-key-file", badKeyFile, "--new-key-file", newKeyFile]);
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/64 hex characters/);
  });
});
