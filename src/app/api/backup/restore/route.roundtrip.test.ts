import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { NextRequest } from "next/server";

/**
 * A real backup -> wipe -> restore round trip for a gear row and its attached
 * document, against a THROW-AWAY SQLite file. Nothing here touches the dev
 * database or truncates real data: the whole run lives in a temp directory that
 * is deleted afterwards.
 *
 * Why it is worth the cost of spinning up a database: every other guarantee
 * about restore ordering is a code-level proof (Gear before Document in the
 * registry, delete-reverse then insert-forward). The registry exists *because*
 * exactly that reasoning silently failed for MaintenanceLog and
 * BatteryChangeLog, so one executed round trip is proportionate to the history.
 *
 * The temp DATABASE_URL is set in vi.hoisted, which runs before the imported
 * modules are evaluated, so the real @/lib/prisma singleton binds to the temp
 * file rather than being mocked. Only globals are used inside the factory —
 * imported bindings are not initialised yet.
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-gear-restore-roundtrip-${process.pid}-${Date.now()}`;
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

const GEAR_ID = "roundtrip-gear-1";
const DOC_ID = "roundtrip-doc-1";

function restoreRequest(body: unknown) {
  return new NextRequest("http://localhost/api/backup/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("backup -> restore round trip for gear", () => {
  beforeAll(() => {
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync(
      "npx",
      [
        "prisma",
        "migrate",
        "deploy",
        "--schema",
        "prisma/sqlite/schema.prisma",
      ],
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

  it("brings a gear item and its attached document back with the link intact", async () => {
    await prisma.gear.create({
      data: {
        id: GEAR_ID,
        name: "Round Trip Bugout",
        manufacturer: "Benchmade",
        model: "535",
        serialNumber: "RT-535",
        category: "KNIFE",
        quantity: 3,
        purchasePrice: 150,
        currentValue: 130,
        storageLocation: "Safe A",
        imageUrl: "/uploads/images/gears/roundtrip.png",
        imageSource: "uploaded",
      },
    });
    await prisma.document.create({
      data: {
        id: DOC_ID,
        name: "Round Trip Receipt",
        type: "RECEIPT",
        fileUrl: "/api/files/documents/roundtrip.pdf",
        gearId: GEAR_ID,
      },
    });

    const backupResponse = await createBackup();
    const backup = await backupResponse.json();

    expect(backupResponse.status).toBe(200);
    // The backup must carry the row and the foreign key, or the restore below
    // would be proving nothing.
    expect(backup.data.gear).toHaveLength(1);
    expect(backup.data.gear[0].imageUrl).toBe(
      "/uploads/images/gears/roundtrip.png",
    );
    expect(backup.data.documents).toHaveLength(1);
    expect(backup.data.documents[0].gearId).toBe(GEAR_ID);

    // Wipe both tables the way a user's database would be replaced.
    await prisma.document.deleteMany();
    await prisma.gear.deleteMany();
    expect(await prisma.gear.count()).toBe(0);
    expect(await prisma.document.count()).toBe(0);

    const restoreResponse = await restoreBackup(
      restoreRequest({
        meta: { version: backup.meta.version },
        ...backup.data,
      }),
    );
    const restored = await restoreResponse.json();

    expect(restoreResponse.status).toBe(200);
    expect(restored.success).toBe(true);
    expect(restored.counts.gear).toBe(1);
    expect(restored.counts.documents).toBe(1);

    // The join is the real assertion: Document must have been inserted after
    // Gear, or its gearId would have violated the foreign key (or, worse for a
    // user, arrived detached).
    const gear = await prisma.gear.findUnique({
      where: { id: GEAR_ID },
      include: { documents: true },
    });

    expect(gear).not.toBeNull();
    expect(gear?.name).toBe("Round Trip Bugout");
    expect(gear?.serialNumber).toBe("RT-535");
    expect(gear?.quantity).toBe(3);
    expect(gear?.purchasePrice).toBe(150);
    expect(gear?.currentValue).toBe(130);
    expect(gear?.imageUrl).toBe("/uploads/images/gears/roundtrip.png");
    expect(gear?.imageSource).toBe("uploaded");
    expect(gear?.documents).toHaveLength(1);
    expect(gear?.documents[0].id).toBe(DOC_ID);
    expect(gear?.documents[0].gearId).toBe(GEAR_ID);
  }, 60_000);

  it("restores a pre-phase-2 backup file, which has no gear key at all", async () => {
    const backup = await (await createBackup()).json();

    // A file taken before this phase has no `gear` key, and its document rows
    // have no gearId column either.
    const v1_0 = {
      meta: { version: "1.0" },
      ...backup.data,
      documents: (backup.data.documents as Record<string, unknown>[]).map(
        (row) => {
          const copy = { ...row };
          delete copy.gearId;
          return copy;
        },
      ),
    } as Record<string, unknown>;
    delete v1_0.gear;

    const response = await restoreBackup(restoreRequest(v1_0));
    const json = await response.json();

    // Accepted (gear is not a required key) and the Gear table ends up empty,
    // which is correct under the full-replace contract — the same way a
    // pre-MaintenanceLog backup behaves. The document survives, unattached.
    expect(response.status).toBe(200);
    expect(json.counts.gear).toBe(0);
    expect(await prisma.gear.count()).toBe(0);

    const doc = await prisma.document.findUnique({ where: { id: DOC_ID } });
    expect(doc).not.toBeNull();
    expect(doc?.gearId).toBeNull();
  }, 60_000);
});
