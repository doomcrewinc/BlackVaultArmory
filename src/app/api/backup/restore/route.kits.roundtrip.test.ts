import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { NextRequest } from "next/server";
import { BACKUP_MODELS } from "@/lib/backup/models";

/**
 * A real backup -> wipe -> restore round trip for a KIT and all six kinds of
 * line it can hold, against a THROW-AWAY SQLite file. Nothing here touches the
 * dev database: the whole run lives in a temp directory that is deleted
 * afterwards.
 *
 * Why this one is worth a database. `KitItem` sits LAST in BACKUP_MODELS
 * because it references five inventory models (Gear, Supply, Accessory,
 * AmmoStock, Firearm) plus `Kit` — six parents, more than any other model in
 * the registry. Restore inserts in registry order, so if that placement were
 * wrong the insert fails on a foreign key, which is precisely what makes this
 * test worth having rather than a second reading of the array. The registry
 * itself exists because exactly this kind of code-level reasoning silently
 * failed for MaintenanceLog and BatteryChangeLog and cascade-deleted real
 * user data while reporting success.
 *
 * Separate file from route.roundtrip.test.ts (gear) so the two get their own
 * database and neither inherits the other's rows; the cost is one more
 * `prisma migrate deploy` against an empty temp file.
 *
 * The temp DATABASE_URL is set in vi.hoisted, which runs before the imported
 * modules are evaluated, so the real @/lib/prisma singleton binds to the temp
 * file rather than being mocked. Only globals are used inside the factory —
 * imported bindings are not initialised yet.
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-kit-restore-roundtrip-${process.pid}-${Date.now()}`;
  const dbFile = `${dir}/roundtrip.db`;
  const url = `file:${dbFile}`;

  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = url;

  return { dir, url };
});

vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
}));

import { POST as createBackup } from "@/app/api/backup/route";
import { POST as restoreBackup } from "@/app/api/backup/restore/route";
import { prisma } from "@/lib/prisma";

const KIT_ID = "kit-roundtrip-1";
const FIREARM_ID = "kit-rt-firearm";
const ACCESSORY_ID = "kit-rt-accessory";
const AMMO_ID = "kit-rt-ammo";
const GEAR_ID = "kit-rt-gear";
const SUPPLY_ID = "kit-rt-supply";

/** One line id per source kind, plus the label-only line. */
const LINES = {
  gear: "kit-rt-line-gear",
  supply: "kit-rt-line-supply",
  accessory: "kit-rt-line-accessory",
  ammo: "kit-rt-line-ammo",
  firearm: "kit-rt-line-firearm",
  label: "kit-rt-line-label",
} as const;

function restoreRequest(body: unknown) {
  return new NextRequest("http://localhost/api/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed() {
  // Sequential — SQLite here runs connection_limit=1.
  await prisma.firearm.create({
    data: {
      id: FIREARM_ID,
      name: "Truck Gun",
      manufacturer: "Acme",
      model: "M4",
      caliber: "5.56",
      serialNumber: "KIT-RT-SERIAL-1",
      type: "RIFLE",
      acquisitionDate: new Date("2025-01-15T00:00:00.000Z"),
    },
  });
  await prisma.accessory.create({
    data: {
      id: ACCESSORY_ID,
      name: "Red Dot",
      manufacturer: "DotCo",
      type: "OPTIC",
      quantity: 2,
    },
  });
  await prisma.ammoStock.create({
    data: { id: AMMO_ID, caliber: "5.56", brand: "Federal", quantity: 300 },
  });
  await prisma.gear.create({
    data: {
      id: GEAR_ID,
      name: "Front Plate",
      category: "ARMOR",
      quantity: 2,
      expirationDate: new Date("2027-01-01T00:00:00.000Z"),
    },
  });
  await prisma.supply.create({
    data: {
      id: SUPPLY_ID,
      name: "Water Pouches",
      category: "WATER",
      quantity: 12,
      unit: "EA",
      expirationDate: new Date("2026-11-01T00:00:00.000Z"),
    },
  });
  await prisma.kit.create({
    data: {
      id: KIT_ID,
      name: "Round Trip Bugout",
      category: "BUGOUT",
      location: "Hall closet",
      notes: "Checked quarterly",
    },
  });
  // One line per source kind, in KIT_ITEM_SOURCES order, plus the label-only
  // line the spec allows for something not tracked in inventory at all.
  await prisma.kitItem.createMany({
    data: [
      { id: LINES.gear, kitId: KIT_ID, gearId: GEAR_ID, quantity: 1, targetQuantity: 2 },
      { id: LINES.supply, kitId: KIT_ID, supplyId: SUPPLY_ID, quantity: 6 },
      { id: LINES.accessory, kitId: KIT_ID, accessoryId: ACCESSORY_ID, quantity: 1 },
      { id: LINES.ammo, kitId: KIT_ID, ammoStockId: AMMO_ID, quantity: 60 },
      { id: LINES.firearm, kitId: KIT_ID, firearmId: FIREARM_ID, quantity: 1 },
      { id: LINES.label, kitId: KIT_ID, label: "Spare bootlaces", quantity: 2, notes: "black" },
    ],
  });
}

describe("backup -> restore round trip for kits", () => {
  beforeAll(() => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"],
      {
        cwd: process.cwd(),
        env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: ctx.url },
        stdio: "pipe",
      },
    );
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it("brings a kit and all six of its lines back pointing at the same records", async () => {
    await seed();

    const backupResponse = await createBackup();
    const backup = await backupResponse.json();

    expect(backupResponse.status).toBe(200);
    // The backup must carry the kit and every line, or the restore below would
    // be proving nothing.
    expect(backup.data.kits).toHaveLength(1);
    expect(backup.data.kitItems).toHaveLength(6);

    // Wipe the way a user's database is replaced: children first.
    await prisma.kitItem.deleteMany();
    await prisma.kit.deleteMany();
    await prisma.supply.deleteMany();
    await prisma.gear.deleteMany();
    await prisma.ammoStock.deleteMany();
    await prisma.accessory.deleteMany();
    await prisma.firearm.deleteMany();
    expect(await prisma.kitItem.count()).toBe(0);
    expect(await prisma.kit.count()).toBe(0);

    const restoreResponse = await restoreBackup(
      restoreRequest({ meta: { version: backup.meta.version }, ...backup.data }),
    );
    const restored = await restoreResponse.json();

    // A 500 here is the failure mode a wrong BACKUP_MODELS order produces:
    // KitItem inserted before Kit or before one of the five inventory tables
    // violates a foreign key and the whole transaction rolls back.
    expect(restoreResponse.status).toBe(200);
    expect(restored.success).toBe(true);
    expect(restored.counts.kits).toBe(1);
    expect(restored.counts.kitItems).toBe(6);

    const kit = await prisma.kit.findUnique({
      where: { id: KIT_ID },
      include: { items: { orderBy: { id: "asc" } } },
    });

    expect(kit).not.toBeNull();
    expect(kit?.name).toBe("Round Trip Bugout");
    expect(kit?.category).toBe("BUGOUT");
    expect(kit?.location).toBe("Hall closet");
    expect(kit?.notes).toBe("Checked quarterly");
    expect(kit?.items).toHaveLength(6);

    const byId = new Map(kit!.items.map((item) => [item.id, item]));

    // Every line still points at the SAME record, by id. This is the assertion
    // the FK ordering exists for — a line that came back detached (null source)
    // would read as an untracked label on the packing list rather than as the
    // plate or the rifle the user put in the bag.
    expect(byId.get(LINES.gear)?.gearId).toBe(GEAR_ID);
    expect(byId.get(LINES.gear)?.quantity).toBe(1);
    expect(byId.get(LINES.gear)?.targetQuantity).toBe(2);
    expect(byId.get(LINES.supply)?.supplyId).toBe(SUPPLY_ID);
    expect(byId.get(LINES.supply)?.quantity).toBe(6);
    expect(byId.get(LINES.accessory)?.accessoryId).toBe(ACCESSORY_ID);
    expect(byId.get(LINES.ammo)?.ammoStockId).toBe(AMMO_ID);
    expect(byId.get(LINES.ammo)?.quantity).toBe(60);
    expect(byId.get(LINES.firearm)?.firearmId).toBe(FIREARM_ID);

    // And the exactly-one-source rule survives the trip: every sourced line
    // still sets exactly one of the five keys, and the label-only line still
    // sets none.
    const sourceKeys = ["gearId", "supplyId", "accessoryId", "ammoStockId", "firearmId"] as const;
    for (const key of Object.values(LINES)) {
      const item = byId.get(key);
      expect(item, key).toBeDefined();
      const set = sourceKeys.filter((field) => item![field] !== null);
      expect(set, key).toHaveLength(key === LINES.label ? 0 : 1);
    }

    const label = byId.get(LINES.label);
    expect(label?.label).toBe("Spare bootlaces");
    expect(label?.notes).toBe("black");
    expect(label?.quantity).toBe(2);

    // The records themselves came back too, not just the lines.
    expect((await prisma.firearm.findUnique({ where: { id: FIREARM_ID } }))?.serialNumber).toBe(
      "KIT-RT-SERIAL-1",
    );
    expect((await prisma.gear.findUnique({ where: { id: GEAR_ID } }))?.name).toBe("Front Plate");
    expect((await prisma.supply.findUnique({ where: { id: SUPPLY_ID } }))?.quantity).toBe(12);
  }, 60_000);

  it("restores a pre-kits backup file, which has neither kits nor kitItems", async () => {
    // The state the previous test left: a populated database. A backup file
    // written before this branch has no `kits` and no `kitItems` key at all,
    // and Task 1 deliberately left both out of V1_0_MODEL_NAMES so that file
    // is still valid.
    const backup = await (await createBackup()).json();
    const preKits = { meta: { version: "1.0" }, ...backup.data } as Record<string, unknown>;
    delete preKits.kits;
    delete preKits.kitItems;

    const response = await restoreBackup(restoreRequest(preKits));
    const json = await response.json();

    // Accepted, and both tables end up EMPTY — correct under the full-replace
    // contract, and the same way a pre-MaintenanceLog backup behaves.
    expect(response.status).toBe(200);
    expect(json.counts.kits).toBe(0);
    expect(json.counts.kitItems).toBe(0);
    expect(await prisma.kit.count()).toBe(0);
    expect(await prisma.kitItem.count()).toBe(0);
    // The inventory the kit pointed at survives, so this is not "the restore
    // failed and nothing came back".
    expect(await prisma.firearm.count()).toBe(1);
    expect(await prisma.gear.count()).toBe(1);
    expect(await prisma.supply.count()).toBe(1);
  }, 60_000);

  it("keeps KitItem last in the registry, after everything it references", () => {
    // The code-level companion to the executed trip above, in the same file so
    // a reader sees both. Kit and the five inventory models must all precede
    // KitItem; nothing may be inserted after it, because nothing references it.
    const order = BACKUP_MODELS.map((m) => m.model);
    expect(order[order.length - 1]).toBe("KitItem");
    for (const referenced of ["Kit", "Gear", "Supply", "Accessory", "AmmoStock", "Firearm"]) {
      expect(order.indexOf(referenced), referenced).toBeLessThan(order.indexOf("KitItem"));
    }
  });
});
