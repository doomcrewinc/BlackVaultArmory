import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  // Spec 3b Task 5: every run gets its own scratch uploads root (IMAGE_UPLOAD_DIR), so the
  // script never sees the repo's own uploads/ folder.
  return { pg, dir, file: `${dir}/t.db`, uploads: `${dir}/uploads` };
});

import type { PrismaClient } from "@prisma/client";
import { createRawPrismaClient } from "@/lib/prisma";
import {
  decryptFile, decryptValue, deriveKeys, encryptFile, encryptValue, envelopeKeyId, fileKeyId, fingerprint, generateKeyHex, parseKeyHex,
} from "@/lib/encryption/core.mjs";
import { aadFor, ENCRYPTED_FIELDS } from "@/lib/encryption/fields";
import { ENCRYPTED_FIELDS as ROTATION_FIELDS, uploadsRoot as rotationUploadsRoot } from "./rotate-encryption-key.mjs";
import { uploadsRoot } from "@/lib/files/storage";
import { runFileStartup } from "@/lib/files/startup";
import { resetFieldKeysForTests } from "@/lib/encryption/keys";

type Row = Record<string, unknown>;
type FieldKeysLike = { id: string; enc: Buffer; idx: Buffer; file: Buffer };

/** The probe's answer line. Spec 3b added a second `FILES ...` line; callers only ever read the first. */
const firstLine = (stdout: string) => stdout.split("\n")[0].trim();

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

// Spec 3b Task 5: the script is plain .mjs and cannot import src/lib/files/storage.ts, so it
// mirrors uploadsRoot(); this keeps the two from drifting (same rule as ENCRYPTED_FIELDS above).
describe("scripts/rotate-encryption-key.mjs's uploadsRoot mirror", () => {
  it.each([
    ["unset", {}],
    ["empty", { IMAGE_UPLOAD_DIR: "" }],
    ["absolute", { IMAGE_UPLOAD_DIR: "/srv/blackvault/uploads" }],
    ["relative", { IMAGE_UPLOAD_DIR: "some/relative/uploads" }],
    ["trailing slash", { IMAGE_UPLOAD_DIR: "/srv/up/" }],
  ])("matches src/lib/files/storage.ts's uploadsRoot() (%s)", (_l, env) => {
    const e = env as unknown as NodeJS.ProcessEnv;
    expect(rotationUploadsRoot(e)).toBe(uploadsRoot(e));
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
      env: { ...process.env, IMAGE_UPLOAD_DIR: ctx.uploads },
    });
  }

  /** Runs the script under `node --require <preloadPath>` — the injection mechanism fix round 1's C1 test needs. */
  function runScriptWithPreload(args: string[], preloadPath: string) {
    return spawnSync("node", ["--require", preloadPath, "scripts/rotate-encryption-key.mjs", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, IMAGE_UPLOAD_DIR: ctx.uploads },
    });
  }

  const DISCONNECT_THROWS_PRELOAD = path.join(process.cwd(), "scripts", "rotate-encryption-key.disconnect-throws.preload.cjs");

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

  /**
   * Seeds one Firearm (full NFA paperwork), one bare Firearm (serial only), one Accessory, one Gear, and the key
   * check — all under `keys`. `updatedAt`, when given, is written explicitly on every rotated-model row (Prisma
   * honours an explicit value over its own `@updatedAt` auto-set), for the I4 "rotation preserves updatedAt" test.
   */
  async function seed(keys: FieldKeysLike, updatedAt?: Date) {
    const stamp = updatedAt ? { updatedAt } : {};
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
        ...stamp,
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
        ...stamp,
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
        ...stamp,
      },
    });
    await raw.accessory.create({ data: { id: "a-plain", name: "Light", manufacturer: "Surefire", type: "LIGHT", ...stamp } });
    await raw.gear.create({
      data: {
        id: "g-1",
        name: "Plate",
        category: "ARMOR",
        serialNumber: enc(keys, "Gear", "serialNumber", "GEAR-ROTATE-1"),
        serialNumberHash: fingerprint(keys, "GEAR-ROTATE-1"),
        ...stamp,
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
    rmSync(ctx.uploads, { recursive: true, force: true });
    mkdirSync(ctx.uploads, { recursive: true });
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

    expect(result.status).toBe(3); // F5: refused before any transaction, distinct from a failed rotation (1)
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

    expect(second.status).toBe(3);
    expect(second.stderr).toMatch(/does not match this database's encryption key check/);
    expect(await rawSnapshot()).toBe(afterFirst);
    expect(await raw.auditEvent.count()).toBe(1); // still just the first run's event
  }, 60_000);

  it("refuses with no encryption key check at all (never started with a key), and changes nothing", async () => {
    // No seed() call: an empty database, so appSettings.encryptionKeyCheck is absent.
    const oldKeyFile = keyFile("old-5", generateKeyHex());
    const newKeyFile = keyFile("new-5", generateKeyHex());
    const result = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);

    expect(result.status).toBe(3);
    expect(result.stderr).toMatch(/No encryption key check found/);
    expect(await raw.auditEvent.count()).toBe(0);
  }, 60_000);

  it("usage: missing flags exit 2 with a usage message, before touching the database", async () => {
    const result = runScript([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Usage: node scripts/rotate-encryption-key.mjs [--probe] --old-key-file <path> --new-key-file <path>",
    );
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

  // ── fix round 1 ────────────────────────────────────────────────

  it("I4: preserves updatedAt on every rotated row", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const fixedUpdatedAt = new Date("2020-06-15T12:00:00.000Z");
    await seed(oldKeys, fixedUpdatedAt);

    const oldKeyFile = keyFile("old-i4", oldHex);
    const newKeyFile = keyFile("new-i4", newHex);
    const result = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);

    const rows = [
      ...(await raw.firearm.findMany()),
      ...(await raw.accessory.findMany()),
      ...(await raw.gear.findMany()),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((row.updatedAt as Date).toISOString(), `${row.id}.updatedAt`).toBe(fixedUpdatedAt.toISOString());
    }
  }, 60_000);

  it("M4: a failure mid-rotation names the model, id and field", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const thirdHex = generateKeyHex();
    await seed(keysFromHex(oldHex));
    await raw.accessory.update({
      where: { id: "a-nfa" },
      data: { nfaControlNumber: enc(keysFromHex(thirdHex), "Accessory", "nfaControlNumber", "CTRL-WRONG-KEY") },
    });

    const oldKeyFile = keyFile("old-m4", oldHex);
    const newKeyFile = keyFile("new-m4", newHex);
    const result = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot rotate Accessory.nfaControlNumber for id a-nfa");
  }, 60_000);

  // ── C1: probe mode ───────────────────────────────────────────────

  it("--probe reports OLD before rotation and NEW after, exiting 0 both times", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    await seed(keysFromHex(oldHex));
    const oldKeyFile = keyFile("old-probe-1", oldHex);
    const newKeyFile = keyFile("new-probe-1", newHex);

    const before = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(before.status, `stderr: ${before.stderr}`).toBe(0);
    expect(firstLine(before.stdout)).toBe("OLD");

    const rotated = runScript(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(rotated.status, `stderr: ${rotated.stderr}`).toBe(0);

    const after = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(after.status, `stderr: ${after.stderr}`).toBe(0);
    expect(firstLine(after.stdout)).toBe("NEW");
  }, 60_000);

  it("--probe reports NEITHER, and exits 0, when the key check opens under neither file", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const thirdHex = generateKeyHex();
    await seed(keysFromHex(thirdHex)); // key check under a key neither file names
    const oldKeyFile = keyFile("old-probe-2", oldHex);
    const newKeyFile = keyFile("new-probe-2", newHex);

    const result = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(firstLine(result.stdout)).toBe("NEITHER");
  }, 60_000);

  it("--probe exits non-zero (prints nothing on stdout) when it cannot tell: no key check at all", async () => {
    const oldKeyFile = keyFile("old-probe-3", generateKeyHex());
    const newKeyFile = keyFile("new-probe-3", generateKeyHex());

    const result = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/cannot determine which key/);
  });

  // ── final review F1: post-rotation compaction ────────────────────

  const VACUUM_THROWS_PRELOAD = path.join(process.cwd(), "scripts", "rotate-encryption-key.vacuum-throws.preload.cjs");
  const pendingFlag = async () =>
    (await raw.appSettings.findUniqueOrThrow({ where: { id: "singleton" }, select: { encryptionCompactionPending: true } }))
      .encryptionCompactionPending;

  /** Enough rows that the rewrite frees whole pages (on a page or two SQLite's defragmentation zeroes the gaps by itself). */
  async function seedBulk(keys: FieldKeysLike, n = 400) {
    await raw.gear.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        id: `g-bulk-${i}`,
        name: `Bulk ${i}`,
        category: "ARMOR",
        serialNumber: enc(keys, "Gear", "serialNumber", `BULK-${i}`),
        serialNumberHash: fingerprint(keys, `BULK-${i}`),
      })),
    });
  }

  const fileHolds = (needle: string) => !ctx.pg && readFileSync(ctx.file).includes(Buffer.from(needle));

  it("F1: after a committed rotation the database is compacted — no OLD-key envelope left in the SQLite file — and the marker is cleared", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);
    await seedBulk(oldKeys);
    if (!ctx.pg) expect(fileHolds(`bv2:${oldKeys.id}:`)).toBe(true);

    const result = runScript(["--old-key-file", keyFile("old-f1", oldHex), "--new-key-file", keyFile("new-f1", newHex)]);
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Rotated encryption key ${oldKeys.id} -> ${newKeys.id}`);
    expect(result.stdout).toContain("Compacted the database (removed old-key ciphertext from free space).");
    expect(result.stderr).toBe("");
    expect(await pendingFlag()).toBe(false);
    if (!ctx.pg) {
      expect(fileHolds(`bv2:${oldKeys.id}:`)).toBe(false);
      expect(fileHolds(`bv2:${newKeys.id}:`)).toBe(true);
    }
  }, 60_000);

  it("F1: a failed post-rotation compaction is a warning: exit 0, rotation committed, marker left set for the app's next start", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);
    await seedBulk(oldKeys);

    const result = runScriptWithPreload(
      ["--old-key-file", keyFile("old-f1b", oldHex), "--new-key-file", keyFile("new-f1b", newHex)],
      VACUUM_THROWS_PRELOAD,
    );
    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Rotated encryption key ${oldKeys.id} -> ${newKeys.id}`);
    expect(result.stderr).toContain(
      "Warning: rotation committed, but compacting the database failed: simulated compaction failure: database or disk is full (test fixture). Old-key ciphertext may remain in free space; BlackVault retries the compaction on its next start.",
    );
    const settings = await raw.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(decryptValue(newKeys, KEY_CHECK_AAD, settings.encryptionKeyCheck as string)).toBe(KEY_CHECK_PLAINTEXT);
    expect(await pendingFlag()).toBe(true);
    if (!ctx.pg) expect(fileHolds(`bv2:${oldKeys.id}:`)).toBe(true); // the residue the next start removes
  }, 60_000);

  // ── C1: the reviewer's post-commit injection ─────────────────────

  it("C1: exits 0 when $disconnect throws AFTER the transaction has committed — the rotation already succeeded", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);

    const oldKeyFile = keyFile("old-c1", oldHex);
    const newKeyFile = keyFile("new-c1", newHex);
    const result = runScriptWithPreload(
      ["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile],
      DISCONNECT_THROWS_PRELOAD,
    );

    expect(result.status, `stdout: ${result.stdout} stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`Rotated encryption key ${oldKeys.id} -> ${newKeys.id}`);
    expect(result.stderr).toMatch(/Warning: rotation committed, but disconnecting from the database afterwards failed/);

    // The commit really happened: every row is under the NEW key, and the
    // key check only opens with the NEW key — proving this isn't exit 0
    // papering over a rollback.
    const firearm = await raw.firearm.findUniqueOrThrow({ where: { id: "f-nfa" } });
    expect(envelopeKeyId(firearm.serialNumber as unknown as string)).toBe(newKeys.id);
    const settings = await raw.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(decryptValue(newKeys, KEY_CHECK_AAD, settings.encryptionKeyCheck as string)).toBe(KEY_CHECK_PLAINTEXT);
    const events = await raw.auditEvent.findMany({ where: { action: "KEY_ROTATED" } });
    expect(events).toHaveLength(1);

    // And the wrapper's recovery tool agrees: the probe reads NEW, so a
    // wrapper that runs it after a non-zero exit from this script would
    // correctly complete the swap rather than deleting the new key file.
    const probe = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(probe.status).toBe(0);
    expect(firstLine(probe.stdout)).toBe("NEW");
  }, 60_000);
  // ── spec 3b Task 5: uploaded files ───────────────────────────────

  const CRASH_BEFORE_FINALISE_PRELOAD = path.join(process.cwd(), "scripts", "rotate-encryption-key.crash-before-finalise.preload.cjs");
  const ENOSPC_ROT_PRELOAD = path.join(process.cwd(), "scripts", "rotate-encryption-key.enospc-rot.preload.cjs");

  /**
   * Uploaded files exactly as the app stores them: BVF1 under `keys`, AAD bound to the basename.
   * The image name has a cuid-style `-` (Review Focus 4). Returns relative path → plaintext.
   */
  const UPLOADED: Record<string, Buffer> = {
    "images/firearm_cm1abc-xyz_1700000000000.jpg": Buffer.from("\xff\xd8\xff\xe0 fake jpeg bytes ".repeat(200), "latin1"),
    "images/gear_g-1_1700000000001.png": Buffer.from("\x89PNG fake png bytes", "latin1"),
    "documents/1700000000002-receipt.pdf": Buffer.from("%PDF-1.7 fake document ".repeat(50), "latin1"),
  };

  function seedFiles(keys: FieldKeysLike): Record<string, Buffer> {
    for (const [rel, plain] of Object.entries(UPLOADED)) {
      const abs = path.join(ctx.uploads, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, encryptFile(keys, path.basename(abs), plain), { mode: 0o600 });
    }
    return UPLOADED;
  }

  /** Every regular file under the uploads root (relative, sorted), hidden ones included. */
  function listUploads(dir = ctx.uploads, rel = ""): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(abs);
      if (st.isDirectory()) out.push(...listUploads(abs, r));
      else out.push(r);
    }
    return out;
  }

  /** Every file's bytes, keyed by relative path — proves "nothing changed" on disk. */
  function uploadsSnapshot(): Record<string, string> {
    return Object.fromEntries(
      listUploads().map((r) => {
        const abs = path.join(ctx.uploads, r);
        return [r, lstatSync(abs).isSymbolicLink() ? `link:${abs}` : readFileSync(abs).toString("base64")];
      }),
    );
  }

  const workFiles = () => listUploads().filter((r) => r.endsWith(".rot") || r.endsWith(".tmp"));

  function expectAllUnder(keys: FieldKeysLike, files: Record<string, Buffer>) {
    for (const [rel, plain] of Object.entries(files)) {
      const stored = readFileSync(path.join(ctx.uploads, rel));
      expect(fileKeyId(stored), rel).toBe(keys.id);
      expect(decryptFile(keys, path.basename(rel), stored).equals(plain), rel).toBe(true);
    }
  }

  it("files: after rotation every uploaded file is under the new key, decrypts to the original bytes, and no .rot/.tmp remains", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);
    const files = seedFiles(oldKeys);
    // Left alone: a plaintext file (the app's startup encrypts it) and a dotfile (never scanned).
    writeFileSync(path.join(ctx.uploads, "images", "not-yet-encrypted.png"), "plain");
    writeFileSync(path.join(ctx.uploads, ".DS_Store"), "x");

    const result = runScript(["--old-key-file", keyFile("old-files-1", oldHex), "--new-key-file", keyFile("new-files-1", newHex)]);

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Re-encrypted 3 uploaded files under the new key.");
    expectAllUnder(newKeys, files);
    expect(workFiles()).toEqual([]);
    expect(readFileSync(path.join(ctx.uploads, "images", "not-yet-encrypted.png"), "utf8")).toBe("plain");
    expect(readFileSync(path.join(ctx.uploads, ".DS_Store"), "utf8")).toBe("x");
    const events = await raw.auditEvent.findMany({ where: { action: "KEY_ROTATED" } });
    expect(JSON.parse(events[0].changes as string).files).toBe(3);
  }, 60_000);

  it("files: a database failure before the commit leaves every original untouched and deletes every .rot", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    await seed(oldKeys);
    seedFiles(oldKeys);
    // Same mid-transaction injection as above: one field under a third key.
    await raw.accessory.update({
      where: { id: "a-nfa" },
      data: { nfaControlNumber: enc(keysFromHex(generateKeyHex()), "Accessory", "nfaControlNumber", "X") },
    });
    const filesBefore = uploadsSnapshot();
    const dbBefore = await rawSnapshot();

    const result = runScript(["--old-key-file", keyFile("old-files-2", oldHex), "--new-key-file", keyFile("new-files-2", newHex)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Cannot rotate Accessory\.nfaControlNumber/);
    expect(uploadsSnapshot()).toEqual(filesBefore);
    expect(workFiles()).toEqual([]);
    expect(await rawSnapshot()).toBe(dbBefore);
  }, 60_000);

  it("files: a crash after the commit, before finalising, leaves .rot files under the new key; the app's startup (runFileStartup) finishes them", async () => {
    // The NEW key is the suite's fixed test key, so the app-side getFieldKeys() — what
    // runFileStartup uses — is the new key, exactly as after the wrapper's key-file swap.
    const oldHex = generateKeyHex();
    const newHex = process.env.BLACKVAULT_ENCRYPTION_KEY as string;
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);
    const files = seedFiles(oldKeys);
    const oldKeyFile = keyFile("old-files-3", oldHex);
    const newKeyFile = keyFile("new-files-3", newHex);

    const result = runScriptWithPreload(["--old-key-file", oldKeyFile, "--new-key-file", newKeyFile], CRASH_BEFORE_FINALISE_PRELOAD);
    expect(result.status, `stdout: ${result.stdout} stderr: ${result.stderr}`).toBe(9); // the injected exit

    // The database committed …
    const settings = await raw.appSettings.findUniqueOrThrow({ where: { id: "singleton" } });
    expect(decryptValue(newKeys, KEY_CHECK_AAD, settings.encryptionKeyCheck as string)).toBe(KEY_CHECK_PLAINTEXT);
    // … the originals are still under the OLD key, and every one has a .rot under the NEW key
    // that decrypts with the ORIGINAL file's basename (what startup verifies before renaming).
    expectAllUnder(oldKeys, files);
    for (const [rel, plain] of Object.entries(files)) {
      const rot = readFileSync(path.join(ctx.uploads, `${rel}.rot`));
      expect(fileKeyId(rot)).toBe(newKeys.id);
      expect(decryptFile(newKeys, path.basename(rel), rot).equals(plain)).toBe(true);
    }

    // The probe (what the wrappers run after a non-zero exit) sees NEW plus the staged files.
    const probe = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout.split("\n").filter(Boolean)).toEqual(["NEW", "FILES old=3 new=0 rot=3"]);

    // The app's next start (on the swapped-in new key) finishes the rotation.
    resetFieldKeysForTests();
    const startup = await within(
      30_000,
      runFileStartup(raw, { cwd: ctx.dir, env: { IMAGE_UPLOAD_DIR: ctx.uploads } as unknown as NodeJS.ProcessEnv }),
    );
    expect(startup.finishedRotations).toBe(3);
    expectAllUnder(newKeys, files);
    expect(workFiles()).toEqual([]);
  }, 60_000);

  it.each([
    ["under a third key", (rel: string, plain: Buffer) => encryptFile(keysFromHex(generateKeyHex()), path.basename(rel), plain)],
    ["with a damaged BVF1 header", (_rel: string, plain: Buffer) => Buffer.concat([Buffer.from("BVF1\x01ZZZZZZZZ", "latin1"), plain, Buffer.alloc(40)])],
  ])("files: a file %s refuses up front with exit 3, names the file, and nothing changes", async (_l, make) => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    await seed(oldKeys);
    seedFiles(oldKeys);
    const bad = "images/zz_from-elsewhere_1.jpg";
    writeFileSync(path.join(ctx.uploads, bad), make(bad, Buffer.from("other bytes")));
    const filesBefore = uploadsSnapshot();
    const dbBefore = await rawSnapshot();

    const result = runScript(["--old-key-file", keyFile("old-files-4", oldHex), "--new-key-file", keyFile("new-files-4", newHex)]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain(path.join(ctx.uploads, bad));
    expect(result.stderr).toContain("Nothing was changed");
    expect(result.stdout).toBe("");
    expect(uploadsSnapshot()).toEqual(filesBefore);
    expect(await rawSnapshot()).toBe(dbBefore);
  }, 60_000);

  it("files: a leftover .rot under the OLD key (an earlier rotation never finished) refuses up front with exit 3", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    await seed(oldKeys);
    seedFiles(oldKeys);
    const rel = "images/gear_g-1_1700000000001.png";
    writeFileSync(path.join(ctx.uploads, `${rel}.rot`), encryptFile(oldKeys, path.basename(rel), Buffer.from("staged")));
    const filesBefore = uploadsSnapshot();
    const dbBefore = await rawSnapshot();

    const result = runScript(["--old-key-file", keyFile("old-files-5", oldHex), "--new-key-file", keyFile("new-files-5", newHex)]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain(path.join(ctx.uploads, `${rel}.rot`));
    expect(uploadsSnapshot()).toEqual(filesBefore);
    expect(await rawSnapshot()).toBe(dbBefore);
  }, 60_000);

  it("files: a symlinked folder inside the uploads root refuses up front with exit 3", async () => {
    const oldHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    await seed(oldKeys);
    seedFiles(oldKeys);
    const outside = path.join(ctx.dir, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(ctx.uploads, "linked"));
    const filesBefore = uploadsSnapshot();

    const result = runScript(["--old-key-file", keyFile("old-files-6", oldHex), "--new-key-file", keyFile("new-files-6", generateKeyHex())]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain(path.join(ctx.uploads, "linked"));
    expect(uploadsSnapshot()).toEqual(filesBefore);
  }, 60_000);

  it("files (Review Focus 5): disk full while writing a .rot leaves every original intact, cleans up the partial file and every staged .rot, and the run fails before the commit", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    await seed(oldKeys);
    seedFiles(oldKeys);
    const filesBefore = uploadsSnapshot();
    const dbBefore = await rawSnapshot();

    // The preload lets the FIRST .rot through, then makes the second one's write land half its bytes and fail ENOSPC.
    const result = runScriptWithPreload(
      ["--old-key-file", keyFile("old-files-7", oldHex), "--new-key-file", keyFile("new-files-7", newHex)],
      ENOSPC_ROT_PRELOAD,
    );

    expect(result.status, `stdout: ${result.stdout} stderr: ${result.stderr}`).toBe(1);
    expect(result.stderr).toMatch(/ENOSPC/);
    expect(result.stderr).toMatch(/\.rot/);
    expect(uploadsSnapshot()).toEqual(filesBefore);
    expect(workFiles()).toEqual([]);
    expect(await rawSnapshot()).toBe(dbBefore);
    const probe = runScript(["--probe", "--old-key-file", keyFile("old-files-7b", oldHex), "--new-key-file", keyFile("new-files-7b", newHex)]);
    expect(firstLine(probe.stdout)).toBe("OLD");
  }, 60_000);

  it("files: --probe's second line counts files under the old key, the new key, and .rot files; the first line is unchanged", async () => {
    const oldHex = generateKeyHex();
    const newHex = generateKeyHex();
    const oldKeys = keysFromHex(oldHex);
    const newKeys = keysFromHex(newHex);
    await seed(oldKeys);
    seedFiles(oldKeys);
    // One file already under the new key, one plaintext (counted nowhere), one stray .rot, one hidden folder's file.
    writeFileSync(path.join(ctx.uploads, "images", "already_new_1.jpg"), encryptFile(newKeys, "already_new_1.jpg", Buffer.from("n")));
    writeFileSync(path.join(ctx.uploads, "images", "plain.png"), "plain");
    writeFileSync(path.join(ctx.uploads, "images", "stray.jpg.rot"), encryptFile(newKeys, "stray.jpg", Buffer.from("s")));
    mkdirSync(path.join(ctx.uploads, ".pre-encryption-20260101-000000"), { recursive: true });
    writeFileSync(path.join(ctx.uploads, ".pre-encryption-20260101-000000", "x.jpg"), encryptFile(oldKeys, "x.jpg", Buffer.from("h")));
    const oldKeyFile = keyFile("old-files-8", oldHex);
    const newKeyFile = keyFile("new-files-8", newHex);

    const probe = runScript(["--probe", "--old-key-file", oldKeyFile, "--new-key-file", newKeyFile]);
    expect(probe.status, probe.stderr).toBe(0);
    expect(probe.stdout).toBe("OLD\nFILES old=3 new=1 rot=1\n");
  }, 60_000);
});
