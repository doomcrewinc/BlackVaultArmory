import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * Sealed backups and restore (field-encryption spec §3, "Sealed backup
 * format" / "Backup UI" / "Restore"; Task 5 brief Step 1), against a REAL
 * database — a throw-away SQLite file, migrated with `prisma migrate deploy`,
 * deleted afterwards. The dev database is never touched.
 *
 * Why this is worth a real database rather than the mocked-prisma unit tests
 * in route.test.ts / restore/route.test.ts: the claims here are about the
 * REAL encryption extension (base -> encryption -> audit, src/lib/prisma.ts)
 * round-tripping through a real sealed envelope — that no plaintext escapes
 * into the sealed body, that a restore re-encrypts with whatever key is
 * currently loaded (even a different one than the backup was taken under),
 * and that a failed open truly writes nothing. A mocked `@/lib/prisma` proves
 * none of that.
 *
 * The test key is the fixed one from vitest.config.ts (`test.env`); the
 * "different encryption key" test swaps it and resets the key cache.
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-sealed-backup-roundtrip-${process.pid}-${Date.now()}`;
  const dbFile = `${dir}/roundtrip.db`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${dbFile}`;
  return { dir, dbFile };
});

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
  requireAdmin: vi.fn().mockResolvedValue(null),
}));

import { POST as createBackup } from "@/app/api/backup/route";
import { POST as restoreBackup } from "@/app/api/backup/restore/route";
import { prisma, createRawPrismaClient } from "@/lib/prisma";
import { envelopeKeyId, keyId, openBackup, parseKeyHex } from "@/lib/encryption/core.mjs";
import { resetFieldKeysForTests } from "@/lib/encryption/keys";

const PASSPHRASE = "correct horse battery staple";
const TEST_KEY = process.env.BLACKVAULT_ENCRYPTION_KEY as string;
const OTHER_KEY = "11".repeat(32);

function backupRequest(passphrase = PASSPHRASE) {
  return new NextRequest("http://localhost/api/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
}

function restoreRequest(body: unknown) {
  return new NextRequest("http://localhost/api/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function takeBackup(passphrase = PASSPHRASE) {
  const response = await createBackup(backupRequest(passphrase));
  const rawText = await response.text();
  const envelope = JSON.parse(rawText);
  return { response, rawText, envelope };
}

/** Runs `fn` with BLACKVAULT_ENCRYPTION_KEY set to `key`, restoring the test key afterwards. */
async function withKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  process.env.BLACKVAULT_ENCRYPTION_KEY = key;
  resetFieldKeysForTests();
  try {
    return await fn();
  } finally {
    process.env.BLACKVAULT_ENCRYPTION_KEY = TEST_KEY;
    resetFieldKeysForTests();
  }
}

describe("sealed backup round trip (field-encryption spec §3)", () => {
  beforeAll(() => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
      { cwd: process.cwd(), env: { ...process.env }, stdio: "pipe" },
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    // The RAW client, not the app client: AuditEvent is append-only on the
    // audited client (deleteMany would throw), and a prior test's "different
    // key" row would otherwise need the CURRENT key to decrypt for the
    // audit layer's own delete-snapshot — exactly the mismatch being cleaned
    // up. Raw bypasses both the audit guard and the decrypt.
    const raw = createRawPrismaClient();
    try {
      await raw.firearm.deleteMany();
      await raw.accessory.deleteMany();
      await raw.auditEvent.deleteMany();
    } finally {
      await raw.$disconnect();
    }
    resetFieldKeysForTests();
    process.env.BLACKVAULT_ENCRYPTION_KEY = TEST_KEY;
  });

  it("the sealed body contains no plaintext serial, name or note", async () => {
    await prisma.firearm.create({
      data: {
        id: "needle-firearm",
        name: "NeedleName-XYZ",
        manufacturer: "Acme",
        model: "Test",
        caliber: "9mm",
        serialNumber: "NeedleSerial-123",
        type: "PISTOL",
        acquisitionDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });

    const { response, rawText, envelope } = await takeBackup();

    expect(response.status).toBe(200);
    expect(envelope.format).toBe("blackvault-sealed-backup");
    expect(rawText).not.toContain("NeedleName-XYZ");
    expect(rawText).not.toContain("NeedleSerial-123");

    // And the plaintext really is in there, reachable with the passphrase —
    // otherwise "no plaintext" would be true for a trivial/broken reason.
    const opened = openBackup(PASSPHRASE, envelope);
    expect(opened).toContain("NeedleName-XYZ");
    expect(opened).toContain("NeedleSerial-123");
  });

  it("backs up, wipes, and restores with the passphrase — the canonical inventory is unchanged", async () => {
    await prisma.firearm.create({
      data: {
        id: "rt-firearm-1",
        name: "Round Trip Rifle",
        manufacturer: "Acme",
        model: "RT",
        caliber: "5.56",
        serialNumber: "RT-SERIAL-1",
        type: "RIFLE",
        nfaClass: "SBR",
        nfaControlNumber: "CTRL-1",
        nfaRegisteredTo: "Trust One",
        nfaTransferMethod: "FORM_4",
        nfaApprovalDate: new Date("2024-03-12T00:00:00.000Z"),
        nfaTaxPaid: 200,
        acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
      },
    });

    const before = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-1" } });

    const { envelope } = await takeBackup();
    await prisma.firearm.deleteMany();
    expect(await prisma.firearm.count()).toBe(0);

    const restoreResponse = await restoreBackup(restoreRequest({ sealed: envelope, passphrase: PASSPHRASE }));
    const restored = await restoreResponse.json();

    expect(restoreResponse.status).toBe(200);
    expect(restored.success).toBe(true);
    expect(restored.counts.firearms).toBe(1);

    const after = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-1" } });
    expect(after.name).toBe(before.name);
    expect(after.serialNumber).toBe(before.serialNumber);
    expect(after.nfaControlNumber).toBe(before.nfaControlNumber);
    expect(after.nfaRegisteredTo).toBe(before.nfaRegisteredTo);
    expect(after.nfaApprovalDate?.toISOString()).toBe(before.nfaApprovalDate?.toISOString());
    expect(after.nfaTaxPaid).toBe(before.nfaTaxPaid);
  }, 30_000);

  it("restoring onto a database with a DIFFERENT encryption key works, and the restored raw rows carry the new key id", async () => {
    await prisma.firearm.create({
      data: {
        id: "rt-firearm-2",
        name: "Key Rotation Rifle",
        manufacturer: "Acme",
        model: "RT2",
        caliber: "5.56",
        serialNumber: "RT-SERIAL-2",
        type: "RIFLE",
        acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
      },
    });

    const { envelope } = await takeBackup();
    await prisma.firearm.deleteMany();

    await withKey(OTHER_KEY, async () => {
      const restoreResponse = await restoreBackup(restoreRequest({ sealed: envelope, passphrase: PASSPHRASE }));
      expect(restoreResponse.status).toBe(200);

      // Decrypted value is intact under the app client...
      const row = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-2" } });
      expect(row.serialNumber).toBe("RT-SERIAL-2");

      // ...and the RAW stored ciphertext now carries the NEW key's id, not the
      // one the backup was taken under.
      const raw = createRawPrismaClient();
      try {
        const rawRow = await raw.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-2" } });
        expect(envelopeKeyId(rawRow.serialNumber as string)).toBe(keyId(parseKeyHex(OTHER_KEY)));
      } finally {
        await raw.$disconnect();
      }
    });
  }, 30_000);

  it("a wrong passphrase returns 400 and changes nothing (row counts and the audit count are unchanged)", async () => {
    await prisma.firearm.create({
      data: {
        id: "rt-firearm-3",
        name: "Untouched Rifle",
        manufacturer: "Acme",
        model: "RT3",
        caliber: "5.56",
        serialNumber: "RT-SERIAL-3",
        type: "RIFLE",
        acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
      },
    });

    const { envelope } = await takeBackup();
    const countBefore = await prisma.firearm.count();
    const auditCountBefore = await prisma.auditEvent.count();

    const restoreResponse = await restoreBackup(
      restoreRequest({ sealed: envelope, passphrase: "a totally wrong passphrase here" }),
    );
    const json = await restoreResponse.json();

    expect(restoreResponse.status).toBe(400);
    expect(json.error).toBe("Wrong passphrase or damaged file.");
    expect(await prisma.firearm.count()).toBe(countBefore);
    expect(await prisma.auditEvent.count()).toBe(auditCountBefore);
    const row = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-3" } });
    expect(row.serialNumber).toBe("RT-SERIAL-3");
  });

  it("an old plain v1.1 backup still restores, and RESTORE records sealed: false", async () => {
    await prisma.firearm.create({
      data: {
        id: "rt-firearm-4",
        name: "Plain Backup Rifle",
        manufacturer: "Acme",
        model: "RT4",
        caliber: "5.56",
        serialNumber: "RT-SERIAL-4",
        type: "RIFLE",
        acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
      },
    });

    // The route always seals; a plain v1.1 file is simulated by opening a
    // real envelope straight back into the plaintext backup body restore
    // already accepts unwrapped (the "plain backup path" the brief requires
    // stays untouched).
    const { envelope } = await takeBackup();
    const plainPayload = JSON.parse(openBackup(PASSPHRASE, envelope));

    await prisma.firearm.deleteMany();

    const restoreResponse = await restoreBackup(restoreRequest(plainPayload));
    const json = await restoreResponse.json();

    expect(restoreResponse.status).toBe(200);
    expect(json.success).toBe(true);
    const row = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-4" } });
    expect(row.serialNumber).toBe("RT-SERIAL-4");

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "RESTORE" },
      orderBy: { at: "desc" },
    });
    expect(JSON.parse(event.changes as string).sealed).toBe(false);
  }, 30_000);

  describe("Accessory full-auto rating", () => {
    const ROWS = [
      { id: "rt-can-yes", fullAutoRating: "YES", fullAutoLimitedTo: null },
      { id: "rt-can-no", fullAutoRating: "NO", fullAutoLimitedTo: null },
      { id: "rt-can-limited", fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56 NATO only" },
      { id: "rt-can-unrecorded", fullAutoRating: null, fullAutoLimitedTo: null },
    ];

    async function seedSuppressors() {
      for (const row of ROWS) {
        await prisma.accessory.create({
          data: { ...row, type: "SUPPRESSOR", name: row.id, manufacturer: "Acme" },
        });
      }
    }

    async function storedValues() {
      const rows = await prisma.accessory.findMany({ orderBy: { id: "asc" } });
      return Object.fromEntries(
        rows.map((row) => [row.id, [row.fullAutoRating, row.fullAutoLimitedTo]]),
      );
    }

    it("keeps all four ratings and the Limited text through a sealed backup and restore", async () => {
      await seedSuppressors();
      const { envelope } = await takeBackup();
      await prisma.accessory.deleteMany();

      const response = await restoreBackup(restoreRequest({ sealed: envelope, passphrase: PASSPHRASE }));

      expect(response.status).toBe(200);
      expect(await storedValues()).toEqual({
        "rt-can-yes": ["YES", null],
        "rt-can-no": ["NO", null],
        "rt-can-limited": ["LIMITED", "5.56 NATO only"],
        "rt-can-unrecorded": [null, null],
      });
    }, 30_000);

    it("restores a backup made before the columns existed with nulls", async () => {
      await seedSuppressors();
      const { envelope } = await takeBackup();
      const plainPayload = JSON.parse(openBackup(PASSPHRASE, envelope));
      for (const row of plainPayload.accessories) {
        delete row.fullAutoRating;
        delete row.fullAutoLimitedTo;
      }
      await prisma.accessory.deleteMany();

      const response = await restoreBackup(restoreRequest(plainPayload));

      expect(response.status).toBe(200);
      expect(Object.values(await storedValues())).toEqual(ROWS.map(() => [null, null]));
    }, 30_000);

    it.each([
      ["a row whose type is not a suppressor", { type: "OPTIC" }, [null, null]],
      ["text beside a Yes rating", { fullAutoRating: "YES", fullAutoLimitedTo: "left over" }, ["YES", null]],
      ["a Limited rating without text", { fullAutoRating: "LIMITED", fullAutoLimitedTo: null }, ["LIMITED", null]],
      ["an unknown rating", { fullAutoRating: "MAYBE" }, [null, null]],
    ])("restores %s by the same rule as the API", async (_label, edit, expected) => {
      await seedSuppressors();
      const { envelope } = await takeBackup();
      const plainPayload = JSON.parse(openBackup(PASSPHRASE, envelope));
      const edited = plainPayload.accessories.find((row: { id: string }) => row.id === "rt-can-limited");
      Object.assign(edited, edit);
      await prisma.accessory.deleteMany();

      const response = await restoreBackup(restoreRequest(plainPayload));

      expect(response.status).toBe(200);
      expect((await storedValues())["rt-can-limited"]).toEqual(expected);
    }, 30_000);
  });

  it("the server-side copy at backupDestinationPath is the sealed envelope, never plaintext", async () => {
    const destDir = `${ctx.dir}/server-copy`;
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", backupDestinationPath: destDir },
      update: { backupDestinationPath: destDir },
    });
    await prisma.firearm.create({
      data: {
        id: "rt-firearm-5",
        name: "Server Copy Rifle",
        manufacturer: "Acme",
        model: "RT5",
        caliber: "5.56",
        serialNumber: "RT-SERIAL-5",
        type: "RIFLE",
        acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
      },
    });

    const response = await createBackup(backupRequest());
    expect(response.status).toBe(200);
    const savedToPathHeader = response.headers.get("X-Backup-Saved-To");
    expect(savedToPathHeader).toBeTruthy();
    const savedToPath = decodeURIComponent(savedToPathHeader as string);

    const onDisk = readFileSync(savedToPath, "utf8");
    expect(onDisk).not.toContain("Server Copy Rifle");
    expect(onDisk).not.toContain("RT-SERIAL-5");
    const onDiskEnvelope = JSON.parse(onDisk);
    expect(onDiskEnvelope.format).toBe("blackvault-sealed-backup");
    // It is the SAME envelope the response carried, opened with the same passphrase.
    expect(openBackup(PASSPHRASE, onDiskEnvelope)).toContain("RT-SERIAL-5");

    await prisma.appSettings.update({ where: { id: "singleton" }, data: { backupDestinationPath: null } });
  });

  // --- Review I1: legacy non-midnight NFA instant, zone-corrected like startup ---

  it("I1: a legacy non-midnight NFA instant restores as the SAME calendar day as acquisitionDate, in the owner's configured zone", async () => {
    await prisma.appSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", timezone: "Australia/Sydney" },
      update: { timezone: "Australia/Sydney" },
    });
    try {
      await prisma.firearm.create({
        data: {
          id: "rt-firearm-i1",
          name: "Sydney Date Rifle",
          manufacturer: "Acme",
          model: "I1",
          caliber: "5.56",
          serialNumber: "RT-SERIAL-I1",
          type: "RIFLE",
          nfaClass: "SBR",
          nfaTransferMethod: "FORM_4",
          acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
          nfaApprovalDate: new Date("2024-03-12T00:00:00.000Z"),
        },
      });
      const { data: backup } = await (async () => {
        const response = await createBackup(backupRequest());
        const envelope = JSON.parse(await response.text());
        return { data: JSON.parse(openBackup(PASSPHRASE, envelope)) };
      })();

      // Simulate a PRE-normalisation legacy build's value: local midnight
      // 2024-03-12 in Sydney (UTC+11 in March), stored as the raw instant
      // rather than UTC midnight — exactly the shape runLegacyDateMigration
      // corrects for every OTHER date-only column.
      const legacyInstant = "2024-03-11T13:00:00.000Z";
      const row = (backup.firearms as Record<string, unknown>[])[0];
      row.acquisitionDate = legacyInstant;
      row.nfaApprovalDate = legacyInstant;

      await prisma.firearm.deleteMany();
      const response = await restoreBackup(restoreRequest(backup));
      const json = await response.json();
      expect(response.status, JSON.stringify(json)).toBe(200);

      const restored = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-i1" } });
      expect(restored.acquisitionDate.toISOString().slice(0, 10)).toBe("2024-03-12");
      expect(restored.nfaApprovalDate?.toISOString().slice(0, 10)).toBe("2024-03-12");
    } finally {
      await prisma.appSettings.update({ where: { id: "singleton" }, data: { timezone: null } });
    }
  }, 30_000);

  // --- Review M2: a real content error (duplicate serial) is 400, not 500 ---

  it("M2: a real duplicate serial inside an otherwise well-formed backup is 400, and nothing is written", async () => {
    await prisma.firearm.create({
      data: {
        id: "rt-firearm-existing",
        name: "Existing Rifle",
        manufacturer: "Acme",
        model: "EX",
        caliber: "9mm",
        serialNumber: "RT-SERIAL-EXISTING",
        type: "PISTOL",
        acquisitionDate: new Date("2025-01-01T00:00:00.000Z"),
      },
    });
    const before = await prisma.firearm.count();

    const response = await restoreBackup(
      restoreRequest({
        meta: { version: "1.1" },
        firearms: [
          {
            id: "dup-1", name: "Dup One", manufacturer: "Acme", model: "D", caliber: "9mm",
            serialNumber: "SAME-SERIAL", type: "PISTOL", acquisitionDate: "2025-01-01T00:00:00.000Z",
          },
          {
            id: "dup-2", name: "Dup Two", manufacturer: "Acme", model: "D", caliber: "9mm",
            serialNumber: "SAME-SERIAL", type: "PISTOL", acquisitionDate: "2025-01-01T00:00:00.000Z",
          },
        ],
        accessories: [], ammoStocks: [], gear: [], supplies: [], builds: [], buildSlots: [],
        documents: [], imageCache: [], rangeSessions: [], rangeSessionAmmoLinks: [],
        ammoTransactions: [], roundCountLogs: [], sessionDrills: [], maintenanceLogs: [],
        batteryChangeLogs: [], dateNormalizationAudits: [], kits: [], kitItems: [],
      }),
    );
    const json = await response.json();

    expect(response.status, JSON.stringify(json)).toBe(400);
    expect(json.error).not.toContain("SAME-SERIAL");
    // Rolled back: the pre-existing row survives, and neither duplicate landed.
    expect(await prisma.firearm.count()).toBe(before);
    const existing = await prisma.firearm.findUniqueOrThrow({ where: { id: "rt-firearm-existing" } });
    expect(existing.serialNumber).toBe("RT-SERIAL-EXISTING");
  });

  // --- Review round 2, M1 (not fixed in round 1): Prisma's OWN log:["error"] ---
  // printed row data to stdout/stderr directly, independent of this route's
  // own console.error call. src/lib/prisma.ts now constructs every client
  // with log: [{ emit: "event", level: "error" }] and a handler that never
  // logs the event's .message (confirmed unsafe — see the comment at its
  // definition), only .target. This is a REAL Prisma validation error (a
  // genuine wrong-type column value), not a mocked error shape, with every
  // console method AND the raw stdout/stderr write streams captured.

  it("M1 (fix round 2): a real Prisma validation error during restore never prints the row's name or notes, on any output channel", async () => {
    const canaryName = "StdoutLeakCanaryName";
    const canaryNote = "StdoutLeakCanaryNote";
    const captured: string[] = [];
    const consoleSpies = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
      }),
    );
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    let response: Response;
    try {
      response = await restoreBackup(
        restoreRequest({
          meta: { version: "1.1" },
          firearms: [
            {
              id: "validation-leak-1",
              name: canaryName,
              manufacturer: 12345, // wrong type: a real PrismaClientValidationError, not a mock
              model: "M",
              caliber: "9mm",
              serialNumber: "VALIDATION-LEAK-SER-1",
              type: "PISTOL",
              notes: canaryNote,
              acquisitionDate: "2025-01-01T00:00:00.000Z",
            },
          ],
          accessories: [], ammoStocks: [], gear: [], supplies: [], builds: [], buildSlots: [],
          documents: [], imageCache: [], rangeSessions: [], rangeSessionAmmoLinks: [],
          ammoTransactions: [], roundCountLogs: [], sessionDrills: [], maintenanceLogs: [],
          batteryChangeLogs: [], dateNormalizationAudits: [], kits: [], kitItems: [],
        }),
      );
    } finally {
      process.stdout.write = outWrite;
      process.stderr.write = errWrite;
      consoleSpies.forEach((s) => s.mockRestore());
    }
    const json = await response.json();

    expect(response.status, JSON.stringify(json)).toBe(400);
    const all = captured.join("\n");
    expect(all).not.toContain(canaryName);
    expect(all).not.toContain(canaryNote);
    expect(JSON.stringify(json)).not.toContain(canaryName);
    expect(JSON.stringify(json)).not.toContain(canaryNote);
    // The suppression actually ran (not a vacuous pass because nothing logged at all).
    expect(all).toContain("PrismaClientValidationError");
  });
});
