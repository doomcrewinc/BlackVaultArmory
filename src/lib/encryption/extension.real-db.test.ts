import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

/**
 * The field-encryption extension against a REAL database, layered exactly as
 * the app ships it: base → encryption → audit (src/lib/prisma.ts). Route tests
 * that `vi.mock("@/lib/prisma")` bypass both extensions and prove nothing here.
 *
 * Harness and stall rules are the audit suite's
 * (src/lib/audit/extension.real-db.test.ts):
 * - default: a throw-away SQLite file with `connection_limit=1` (as
 *   docker-compose ships it), migrated with `prisma migrate deploy`, deleted
 *   afterwards. The dev database is never touched.
 * - with ENCRYPTION_REAL_DB_PG_URL set (a scratch PostgreSQL database, pool
 *   size in its `connection_limit`), the same suite runs against PostgreSQL.
 * - every Prisma call that could deadlock is raced against a timer, so a
 *   deadlock is a failing test, not a hung run.
 *
 * The key is the fixed test key from vitest.config.ts (`test.env`).
 */
const ctx = vi.hoisted(() => {
  const pg = process.env.ENCRYPTION_REAL_DB_PG_URL;
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-enc-real-db-${process.pid}-${Date.now()}`;
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
vi.mock("@/lib/dashboard/revalidate-dashboard", () => ({ revalidateDashboardData: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { REDACTED } from "@/lib/audit/redact";
import { NextRequest } from "next/server";
import { POST as createFirearmRoute } from "@/app/api/firearms/route";
import { PUT as updateFirearmRoute } from "@/app/api/firearms/[id]/route";
import { deriveKeys, encryptValue, fingerprint } from "@/lib/encryption/core.mjs";
import { getFieldKeys } from "@/lib/encryption/keys";
import {
  EncryptedFieldDecryptError,
  EncryptedFieldQueryError,
  decodeFromStorage,
  encodeForStorage,
} from "@/lib/encryption/extension";

type Row = Record<string, unknown>;

/** A client with NO extensions, for reading and corrupting raw stored values. */
function rawClient(): {
  $queryRawUnsafe: (q: string, ...v: unknown[]) => Promise<Row[]>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
  $disconnect: () => Promise<void>;
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = ctx.pg ? require("@prisma/client") : require(".prisma/client-sqlite");
  return new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
}

let raw: ReturnType<typeof rawClient>;

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms (deadlock?)`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** `?` placeholders, rewritten to `$n` on PostgreSQL. */
function sql(text: string): string {
  if (!ctx.pg) return text;
  let n = 0;
  return text.replace(/\?/g, () => `$${++n}`);
}

async function rawSet(table: string, id: string, column: string, value: string | null) {
  await within(5_000, raw.$executeRawUnsafe(sql(`UPDATE "${table}" SET "${column}" = ? WHERE "id" = ?`), value, id));
}

const hashOf = (serial: string) => fingerprint(getFieldKeys(), serial);

async function rawRow(table: string, id: string): Promise<Row> {
  const rows = await within(5_000, raw.$queryRawUnsafe(sql(`SELECT * FROM "${table}" WHERE "id" = ?`), id));
  expect(rows).toHaveLength(1);
  return rows[0];
}

const MARK = "SER-ENC-";
let seq = 0;

function firearmData(overrides: Row = {}) {
  seq++;
  return {
    name: `Enc ${seq}`,
    manufacturer: "Glock",
    model: "19",
    caliber: "9mm",
    serialNumber: `${MARK}${seq}`,
    type: "PISTOL",
    acquisitionDate: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe(`field encryption against real ${ctx.pg ? `PostgreSQL (${ctx.pg.match(/connection_limit=\d+/)?.[0] ?? "default pool"})` : "SQLite (connection_limit=1)"}`, () => {
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
    raw = rawClient();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await raw?.$disconnect();
    if (!ctx.pg) rmSync(ctx.dir, { recursive: true, force: true });
  });

  // ─── Step 1 (GATE): base → encryption → audit layering ─────────

  describe("GATE: layering under the audit extension", () => {
    it("create stores bv2: in the raw row, and the app client reads back the plaintext", async () => {
      const serial = `${MARK}gate-create`;
      const f = await within(8_000, prisma.firearm.create({ data: firearmData({ serialNumber: serial }) }));
      expect(f.serialNumber).toBe(serial);
      const stored = await rawRow("Firearm", f.id);
      expect(String(stored.serialNumber)).toMatch(/^bv2:/);
      expect(stored.serialNumberHash).toMatch(/^[0-9a-f]{64}$/);
      const back = await within(5_000, prisma.firearm.findUnique({ where: { id: f.id } }));
      expect(back?.serialNumber).toBe(serial);
    });

    it("an audited notes update inside a wrapped $transaction: audit before-row is decrypted, stored changes hold no bv2: and no serial; no deadlock / P2028", async () => {
      const serial = `${MARK}gate-update`;
      const f = await within(8_000, prisma.firearm.create({ data: firearmData({ serialNumber: serial }) }));
      const before = new Set((await prisma.auditEvent.findMany({ select: { id: true } })).map((e) => e.id));

      const inside: { row: Row | null } = { row: null };
      await within(
        8_000,
        prisma.$transaction(async (tx) => {
          inside.row = (await tx.firearm.findUnique({ where: { id: f.id } })) as Row | null;
          await tx.firearm.update({ where: { id: f.id }, data: { notes: "cleaned" } });
        }),
      );
      expect(inside.row?.serialNumber).toBe(serial);

      const events = (await prisma.auditEvent.findMany({ orderBy: { at: "asc" } })).filter((e) => !before.has(e.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "UPDATE", entityType: "Firearm", entityId: f.id });
      // The audit layer reads its before/after rows through this same `tx`
      // (extension.ts `delegateOf(c.tx, …).findUnique`), and `inside.row` above
      // proves a read on that client is decrypted. The diff is exactly the
      // notes change: the serial (plaintext on both sides) did not move.
      expect(JSON.parse(events[0].changes ?? "null")).toEqual({ notes: [null, "cleaned"] });
      expect(events[0].changes).not.toContain("bv2:");
      expect(events[0].changes).not.toContain(serial);

      const stored = await rawRow("Firearm", f.id);
      expect(String(stored.serialNumber)).toMatch(/^bv2:/);
      expect(stored.notes).toBe("cleaned");
    });

    it("an audited serial change: the audit diff is redacted, never ciphertext or plaintext", async () => {
      const f = await within(8_000, prisma.firearm.create({ data: firearmData() }));
      const before = new Set((await prisma.auditEvent.findMany({ select: { id: true } })).map((e) => e.id));
      await within(
        8_000,
        prisma.$transaction(async (tx) => {
          await tx.firearm.update({ where: { id: f.id }, data: { serialNumber: `${MARK}gate-changed` } });
        }),
      );
      const events = (await prisma.auditEvent.findMany()).filter((e) => !before.has(e.id));
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].changes ?? "null")).toEqual({
        serialNumber: [REDACTED, REDACTED],
        serialNumberHash: [REDACTED, REDACTED],
      });
      expect(events[0].changes).not.toContain("bv2:");
      expect(events[0].changes).not.toContain(MARK);
    });

    it("the audit CREATE snapshot of an encrypted create holds no bv2: and no serial", async () => {
      const before = new Set((await prisma.auditEvent.findMany({ select: { id: true } })).map((e) => e.id));
      const f = await within(8_000, prisma.firearm.create({ data: firearmData({ nfaControlNumber: "CTRL-1" }) }));
      const events = (await prisma.auditEvent.findMany()).filter((e) => !before.has(e.id));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ action: "CREATE", entityId: f.id });
      const changes = events[0].changes ?? "";
      expect(changes).not.toContain("bv2:");
      expect(changes).not.toContain(MARK);
      expect(changes).not.toContain("CTRL-1");
    });
  });

  // ─── Step 2: full behaviour ────────────────────────────────────

  const NFA_DATE = new Date("2025-03-14T00:00:00.000Z");

  function nfaFields(tag: string) {
    return {
      nfaControlNumber: `CTRL-${tag}`,
      nfaRegisteredTo: `Trust ${tag}`,
      nfaTransferMethod: "FORM_4",
      nfaApprovalDate: NFA_DATE,
      nfaTaxPaid: 200.5,
    };
  }

  const NFA_COLUMNS = ["nfaControlNumber", "nfaRegisteredTo", "nfaTransferMethod", "nfaApprovalDate", "nfaTaxPaid"];

  /** Every registered column that is set is `bv2:`, and the hash is the serial's fingerprint. */
  async function expectStoredEncrypted(table: string, id: string, serial: string | null, columns: string[] = []) {
    const row = await rawRow(table, id);
    if (serial === null) {
      expect(row.serialNumber).toBeNull();
      expect(row.serialNumberHash).toBeNull();
    } else {
      expect(String(row.serialNumber)).toMatch(/^bv2:/);
      expect(row.serialNumberHash).toBe(hashOf(serial));
    }
    for (const c of columns) expect(String(row[c]), `${table}.${c}`).toMatch(/^bv2:/);
    return row;
  }

  function accessoryData(overrides: Row = {}) {
    seq++;
    return { name: `Can ${seq}`, manufacturer: "SilencerCo", type: "SUPPRESSOR", serialNumber: `${MARK}acc-${seq}`, ...overrides };
  }

  describe("writes: every write kind stores ciphertext and the fingerprint", () => {
    it("create (Firearm with every NFA field) → bv2: everywhere, correct hash", async () => {
      const data = firearmData({ ...nfaFields("c") });
      const f = await within(8_000, prisma.firearm.create({ data }));
      await expectStoredEncrypted("Firearm", f.id, data.serialNumber as string, NFA_COLUMNS);
    });

    it("createMany (Accessory and Gear)", async () => {
      const id = `acc-cm-${seq}`;
      const a = accessoryData({ id, ...nfaFields("cm") });
      await within(8_000, prisma.accessory.createMany({ data: [a] }));
      await expectStoredEncrypted("Accessory", id, a.serialNumber, NFA_COLUMNS);

      const g = { id: `gear-cm-${seq}`, name: "Plate", category: "ARMOR", serialNumber: `${MARK}gear-cm` };
      await within(8_000, prisma.gear.createMany({ data: g }));
      await expectStoredEncrypted("Gear", g.id, g.serialNumber);
    });

    it("update (serial and NFA fields)", async () => {
      const f = await within(8_000, prisma.firearm.create({ data: firearmData() }));
      const serial = `${MARK}upd-${seq}`;
      await within(8_000, prisma.firearm.update({ where: { id: f.id }, data: { serialNumber: serial, ...nfaFields("u") } }));
      await expectStoredEncrypted("Firearm", f.id, serial, NFA_COLUMNS);
    });

    it("update with the { set } form", async () => {
      const f = await within(8_000, prisma.firearm.create({ data: firearmData() }));
      const serial = `${MARK}set-${seq}`;
      await within(8_000, prisma.firearm.update({ where: { id: f.id }, data: { serialNumber: { set: serial } } }));
      await expectStoredEncrypted("Firearm", f.id, serial);
    });

    it("updateMany", async () => {
      const a = await within(8_000, prisma.accessory.create({ data: accessoryData() }));
      const serial = `${MARK}um-${seq}`;
      await within(8_000, prisma.accessory.updateMany({ where: { id: a.id }, data: { serialNumber: serial, nfaControlNumber: "CTRL-um" } }));
      await expectStoredEncrypted("Accessory", a.id, serial, ["nfaControlNumber"]);
    });

    it("upsert, create branch (Review Focus 5) and update branch", async () => {
      const id = `gear-up-${seq++}`;
      const created = `${MARK}up-create`;
      await within(8_000, prisma.gear.upsert({
        where: { id },
        create: { id, name: "Helmet", category: "ARMOR", serialNumber: created },
        update: {},
      }));
      await expectStoredEncrypted("Gear", id, created);

      const updated = `${MARK}up-update`;
      await within(8_000, prisma.gear.upsert({ where: { id }, create: { id, name: "x", category: "ARMOR" }, update: { serialNumber: updated } }));
      await expectStoredEncrypted("Gear", id, updated);
    });

    it("nested: a Build create that nests a new Accessory with a serial (Review Focus 5)", async () => {
      const f = await within(8_000, prisma.firearm.create({ data: firearmData() }));
      const serial = `${MARK}nested-build-acc`;
      const build = await within(8_000, prisma.build.create({
        data: {
          name: "Nested",
          firearmId: f.id,
          slots: { create: [{ slotType: "MUZZLE", accessory: { create: accessoryData({ serialNumber: serial, ...nfaFields("nb") }) } }] },
        },
        include: { slots: { include: { accessory: true } } },
      }));
      const acc = build.slots[0].accessory!;
      expect(acc.serialNumber).toBe(serial);
      await expectStoredEncrypted("Accessory", acc.id, serial, NFA_COLUMNS);
    });

    it("nested: a Firearm create that nests builds → slots → accessory.create (Firearm has no direct accessories relation)", async () => {
      const serial = `${MARK}nested-fa-acc`;
      const f = await within(8_000, prisma.firearm.create({
        data: firearmData({
          builds: { create: [{ name: "B", slots: { create: [{ slotType: "OPTIC", accessory: { create: accessoryData({ serialNumber: serial }) } }] } }] },
        }),
        include: { builds: { include: { slots: { include: { accessory: true } } } } },
      }));
      const acc = f.builds[0].slots[0].accessory!;
      expect(acc.serialNumber).toBe(serial);
      await expectStoredEncrypted("Accessory", acc.id, serial);
      await expectStoredEncrypted("Firearm", f.id, f.serialNumber);
    });

    it("nested: connectOrCreate and a nested update of the related row", async () => {
      const f = await within(8_000, prisma.firearm.create({ data: firearmData() }));
      const b = await within(8_000, prisma.build.create({ data: { name: "COC", firearmId: f.id } }));
      const id = `acc-coc-${seq++}`;
      const serial = `${MARK}coc`;
      await within(8_000, prisma.buildSlot.create({
        data: { build: { connect: { id: b.id } }, slotType: "GRIP", accessory: { connectOrCreate: { where: { id }, create: accessoryData({ id, serialNumber: serial }) } } },
      }));
      await expectStoredEncrypted("Accessory", id, serial);

      const changed = `${MARK}coc-changed`;
      await within(8_000, prisma.build.update({
        where: { id: b.id },
        data: { slots: { update: { where: { buildId_slotType: { buildId: b.id, slotType: "GRIP" } }, data: { accessory: { update: { serialNumber: changed } } } } } },
      }));
      await expectStoredEncrypted("Accessory", id, changed);
    });

    it("null stays null, with a null hash", async () => {
      const a = await within(8_000, prisma.accessory.create({ data: accessoryData({ serialNumber: null, nfaControlNumber: null }) }));
      const row = await expectStoredEncrypted("Accessory", a.id, null);
      expect(row.nfaControlNumber).toBeNull();
      expect(a.serialNumber).toBeNull();

      const b = await within(8_000, prisma.accessory.create({ data: accessoryData() }));
      await within(8_000, prisma.accessory.update({ where: { id: b.id }, data: { serialNumber: null, nfaApprovalDate: null, nfaTaxPaid: null } }));
      const after = await expectStoredEncrypted("Accessory", b.id, null);
      expect(after.nfaApprovalDate).toBeNull();
      expect(after.nfaTaxPaid).toBeNull();
    });

    it("Review Focus 3: a notes-only update leaves the serial ciphertext byte-identical and the hash unchanged", async () => {
      const f = await within(8_000, prisma.firearm.create({ data: firearmData({ ...nfaFields("rf3") }) }));
      const before = await rawRow("Firearm", f.id);
      await within(8_000, prisma.firearm.update({ where: { id: f.id }, data: { notes: "only notes" } }));
      const after = await rawRow("Firearm", f.id);
      expect(after.notes).toBe("only notes");
      expect(after.serialNumber).toBe(before.serialNumber);
      expect(after.serialNumberHash).toBe(before.serialNumberHash);
      for (const c of NFA_COLUMNS) expect(after[c], c).toBe(before[c]);
    });
  });

  describe("reads return plaintext", () => {
    let id = "";
    let serial = "";
    let accSerial = "";

    beforeAll(async () => {
      serial = `${MARK}read-${seq}`;
      accSerial = `${MARK}read-acc-${seq}`;
      const f = await prisma.firearm.create({
        data: firearmData({
          serialNumber: serial,
          ...nfaFields("r"),
          builds: { create: [{ name: "R", slots: { create: [{ slotType: "LIGHT", accessory: { create: accessoryData({ serialNumber: accSerial, ...nfaFields("ra") }) } }] } }] },
        }),
      });
      id = f.id;
    });

    function expectPlainFirearm(f: Row | null) {
      expect(f).not.toBeNull();
      expect(f!.serialNumber).toBe(serial);
      expect(f!.nfaControlNumber).toBe("CTRL-r");
      expect(f!.nfaRegisteredTo).toBe("Trust r");
      expect(f!.nfaTransferMethod).toBe("FORM_4");
      expect(f!.nfaApprovalDate).toBeInstanceOf(Date);
      expect((f!.nfaApprovalDate as Date).getTime()).toBe(NFA_DATE.getTime());
      expect(f!.nfaTaxPaid).toBe(200.5);
      expect(typeof f!.nfaTaxPaid).toBe("number");
    }

    it("app-facing types: Date / number on reads, includes and the $transaction client (checked by tsc)", async () => {
      const f = await within(5_000, prisma.firearm.findUniqueOrThrow({
        where: { id },
        include: { builds: { include: { slots: { include: { accessory: true } } } } },
      }));
      expectTypeOf(f.nfaApprovalDate).toEqualTypeOf<Date | null>();
      expectTypeOf(f.nfaTaxPaid).toEqualTypeOf<number | null>();
      expectTypeOf(f.builds[0].slots[0].accessory!.nfaApprovalDate).toEqualTypeOf<Date | null>();
      await within(5_000, prisma.$transaction(async (tx) => {
        const a = await tx.accessory.findFirstOrThrow({ where: { serialNumber: accSerial } });
        expectTypeOf(a.nfaTaxPaid).toEqualTypeOf<number | null>();
        expect(a.nfaTaxPaid).toBe(200.5);
      }));
    });

    it("findUnique, findFirst, findMany", async () => {
      expectPlainFirearm(await within(5_000, prisma.firearm.findUnique({ where: { id } })));
      expectPlainFirearm(await within(5_000, prisma.firearm.findFirst({ where: { id } })));
      const many = await within(5_000, prisma.firearm.findMany({ where: { id: { in: [id] } } }));
      expect(many).toHaveLength(1);
      expectPlainFirearm(many[0]);
    });

    it("include: a firearm with its accessories (through builds → slots)", async () => {
      const f = await within(5_000, prisma.firearm.findUnique({
        where: { id },
        include: { builds: { include: { slots: { include: { accessory: true } } } } },
      }));
      expectPlainFirearm(f);
      const acc = f!.builds[0].slots[0].accessory!;
      expect(acc.serialNumber).toBe(accSerial);
      expect(acc.nfaControlNumber).toBe("CTRL-ra");
      expect(acc.nfaApprovalDate).toBeInstanceOf(Date);
      expect(acc.nfaTaxPaid).toBe(200.5);
    });

    it("select subsets, including a nested select", async () => {
      const f = await within(5_000, prisma.firearm.findUnique({
        where: { id },
        select: { serialNumber: true, nfaApprovalDate: true, builds: { select: { slots: { select: { accessory: { select: { serialNumber: true } } } } } } },
      }));
      expect(f).toEqual({
        serialNumber: serial,
        nfaApprovalDate: NFA_DATE,
        builds: [{ slots: [{ accessory: { serialNumber: accSerial } }] }],
      });
    });

    it("reads through a related model's include (accessory → buildSlots → build → firearm)", async () => {
      const acc = await within(5_000, prisma.accessory.findFirst({
        where: { serialNumber: accSerial },
        include: { buildSlots: { include: { build: { include: { firearm: true } } } } },
      }));
      expect(acc!.serialNumber).toBe(accSerial);
      expectPlainFirearm(acc!.buildSlots[0].build.firearm);
    });
  });

  describe("filters", () => {
    let id = "";
    const serial = `${MARK}filter`;

    beforeAll(async () => {
      id = (await prisma.firearm.create({ data: firearmData({ serialNumber: serial, nfaControlNumber: "x" }) })).id;
    });

    it("serialNumber equality (bare and { equals }) finds the row, on Firearm and on Accessory", async () => {
      expect((await within(5_000, prisma.firearm.findFirst({ where: { serialNumber: serial } })))?.id).toBe(id);
      expect((await within(5_000, prisma.firearm.findFirst({ where: { serialNumber: { equals: serial } } })))?.id).toBe(id);
      expect(await within(5_000, prisma.firearm.findFirst({ where: { serialNumber: `${serial}-nope` } }))).toBeNull();
      expect(await within(5_000, prisma.firearm.count({ where: { OR: [{ serialNumber: serial }, { id: "none" }] } }))).toBe(1);

      const a = await prisma.accessory.create({ data: accessoryData({ serialNumber: `${MARK}acc-filter` }) });
      expect((await within(5_000, prisma.accessory.findFirst({ where: { serialNumber: `${MARK}acc-filter` } })))?.id).toBe(a.id);
    });

    it("serial equality through a relation filter", async () => {
      const b = await prisma.build.create({ data: { name: "rel", firearmId: id } });
      const found = await within(5_000, prisma.build.findFirst({ where: { firearm: { serialNumber: serial } } }));
      expect(found?.id).toBe(b.id);
      const viaIs = await within(5_000, prisma.build.findFirst({ where: { firearm: { is: { serialNumber: serial } } } }));
      expect(viaIs?.id).toBe(b.id);
    });

    it("null checks on an encrypted field are allowed", async () => {
      const n = await within(5_000, prisma.accessory.count({ where: { id: "none", serialNumber: null } }));
      expect(n).toBe(0);
      await within(5_000, prisma.firearm.count({ where: { nfaControlNumber: { not: null } } }));
    });

    const refused: Array<[string, () => Promise<unknown>]> = [
      ["contains", () => prisma.firearm.findFirst({ where: { serialNumber: { contains: "SER" } } })],
      ["startsWith", () => prisma.firearm.findFirst({ where: { serialNumber: { startsWith: "SER" } } })],
      ["in", () => prisma.firearm.findFirst({ where: { serialNumber: { in: [serial] } } })],
      ["not", () => prisma.firearm.findFirst({ where: { serialNumber: { not: serial } } })],
      ["orderBy", () => prisma.firearm.findMany({ orderBy: { serialNumber: "asc" } })],
      ["orderBy through a relation", () => prisma.build.findMany({ orderBy: { firearm: { serialNumber: "asc" } } })],
      ["equality on a field with no fingerprint", () => prisma.firearm.findFirst({ where: { nfaControlNumber: "x" } })],
      ["a contains inside an include's where", () => prisma.build.findMany({ include: { slots: { where: { accessory: { serialNumber: { contains: "x" } } } } } })],
      ["distinct", () => prisma.firearm.findMany({ distinct: ["serialNumber"] })],
      ["groupBy", () => prisma.accessory.groupBy({ by: ["serialNumber"] })],
      ["_max", () => prisma.firearm.aggregate({ _max: { serialNumber: true } })],
    ];
    for (const [name, attempt] of refused) {
      it(`${name} throws EncryptedFieldQueryError`, async () => {
        await expect(within(5_000, attempt())).rejects.toBeInstanceOf(EncryptedFieldQueryError);
      });
    }
  });

  describe("duplicate firearm serial", () => {
    it("a duplicate create fails with Prisma P2002 naming serialNumberHash", async () => {
      const serial = `${MARK}dup`;
      await prisma.firearm.create({ data: firearmData({ serialNumber: serial }) });
      const err = await within(8_000, prisma.firearm.create({ data: firearmData({ serialNumber: serial }) })).catch((e) => e);
      expect(err).toMatchObject({ code: "P2002" });
      expect(String(err.message)).toContain("Unique constraint failed");
      expect(String(err.message)).toContain("serialNumber");
    });

    it("POST /api/firearms and PUT /api/firearms/[id] still answer 409 with the same error", async () => {
      const serial = `${MARK}dup-route`;
      await prisma.firearm.create({ data: firearmData({ serialNumber: serial }) });
      const body = { name: "Dup", manufacturer: "Glock", model: "17", caliber: "9mm", type: "PISTOL", serialNumber: serial, acquisitionDate: "2024-01-01" };
      const post = await within(8_000, createFirearmRoute(
        new NextRequest("http://localhost/api/firearms", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      ));
      expect(post.status).toBe(409);
      expect(await post.json()).toEqual({ error: "A firearm with that serial number already exists" });

      const other = await prisma.firearm.create({ data: firearmData() });
      const put = await within(8_000, updateFirearmRoute(
        new NextRequest(`http://localhost/api/firearms/${other.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ serialNumber: serial }) }),
        { params: Promise.resolve({ id: other.id }) },
      ));
      expect(put.status).toBe(409);
      expect(await put.json()).toEqual({ error: "A firearm with that serial number already exists" });
    });
  });

  describe("undecryptable values", () => {
    it("a corrupted ciphertext throws EncryptedFieldDecryptError carrying model, id and field", async () => {
      const f = await prisma.firearm.create({ data: firearmData({ nfaRegisteredTo: "Trust corrupt" }) });
      const stored = String((await rawRow("Firearm", f.id)).nfaRegisteredTo);
      const parts = stored.split(":");
      parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1); // flip the first ciphertext char
      await rawSet("Firearm", f.id, "nfaRegisteredTo", parts.join(":"));
      const err = await within(5_000, prisma.firearm.findUnique({ where: { id: f.id } })).catch((e) => e);
      expect(err).toBeInstanceOf(EncryptedFieldDecryptError);
      expect(err).toMatchObject({ model: "Firearm", id: f.id, field: "nfaRegisteredTo" });
      expect(String(err.message)).not.toContain("Trust corrupt");
    });

    it("a value encrypted under another key throws EncryptedFieldDecryptError (KEY_MISMATCH)", async () => {
      const a = await prisma.accessory.create({ data: accessoryData() });
      const other = deriveKeys(Buffer.from("11".repeat(32), "hex"));
      await rawSet("Accessory", a.id, "serialNumber", encryptValue(other, "Accessory.serialNumber", "foreign"));
      const err = await within(5_000, prisma.accessory.findUnique({ where: { id: a.id } })).catch((e) => e);
      expect(err).toBeInstanceOf(EncryptedFieldDecryptError);
      expect(err).toMatchObject({ model: "Accessory", id: a.id, field: "serialNumber", code: "KEY_MISMATCH" });
      expect((err.cause as { code?: string }).code).toBe("KEY_MISMATCH");
    });

    it("a value moved into another column (AAD mismatch) does not decrypt", async () => {
      const f = await prisma.firearm.create({ data: firearmData({ nfaControlNumber: "CTRL-move" }) });
      const row = await rawRow("Firearm", f.id);
      await rawSet("Firearm", f.id, "nfaRegisteredTo", String(row.nfaControlNumber));
      const err = await within(5_000, prisma.firearm.findUnique({ where: { id: f.id } })).catch((e) => e);
      expect(err).toMatchObject({ name: "EncryptedFieldDecryptError", field: "nfaRegisteredTo" });
    });
  });

  describe("audit log, across everything above", () => {
    it("no stored audit changes contain ciphertext, a fingerprint, a serial or NFA paperwork", async () => {
      const all = await prisma.auditEvent.findMany();
      expect(all.length).toBeGreaterThan(20);
      const hashes = (await raw.$queryRawUnsafe(`SELECT "serialNumberHash" AS h FROM "Firearm" WHERE "serialNumberHash" IS NOT NULL`)).map((r) => String(r.h));
      expect(hashes.length).toBeGreaterThan(5);
      for (const e of all) {
        const changes = e.changes ?? "";
        expect(changes).not.toContain("bv2:");
        expect(changes).not.toContain(MARK);
        expect(changes).not.toMatch(/CTRL-|Trust /);
        for (const h of hashes) expect(changes).not.toContain(h);
      }
    });
  });

  describe("encodeForStorage / decodeFromStorage", () => {
    it("round-trip a string, a date and a number; null stays null", () => {
      const s = encodeForStorage("Gear", "serialNumber", "G-1")!;
      expect(s).toMatch(/^bv2:/);
      expect(decodeFromStorage("Gear", "serialNumber", s)).toBe("G-1");
      const d = encodeForStorage("Firearm", "nfaApprovalDate", NFA_DATE)!;
      expect(decodeFromStorage("Firearm", "nfaApprovalDate", d)).toEqual(NFA_DATE);
      const n = encodeForStorage("Accessory", "nfaTaxPaid", 200)!;
      expect(decodeFromStorage("Accessory", "nfaTaxPaid", n)).toBe(200);
      expect(encodeForStorage("Firearm", "nfaTaxPaid", null)).toBeNull();
      expect(decodeFromStorage("Firearm", "nfaTaxPaid", null)).toBeNull();
    });

    it("decodes the pre-encryption stored forms (fields.ts P3): epoch-ms and ISO dates, numeric strings", () => {
      expect(decodeFromStorage("Firearm", "nfaApprovalDate", "1790380800000")).toEqual(new Date(1790380800000));
      expect(decodeFromStorage("Firearm", "nfaApprovalDate", "2026-09-25T00:00:00.000Z")).toEqual(new Date("2026-09-25T00:00:00.000Z"));
      expect(decodeFromStorage("Firearm", "nfaTaxPaid", "200.0")).toBe(200);
    });

    it("refuses a field that is not registered", () => {
      expect(() => encodeForStorage("Firearm", "notes", "x")).toThrow();
    });
  });
});
