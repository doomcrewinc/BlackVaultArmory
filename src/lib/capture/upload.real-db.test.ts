import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import sharp from "sharp";

/**
 * The public capture upload against REAL databases and a real (temporary) uploads folder: two
 * uploads racing for the last slot of a pass store exactly one, the row-audit events of an upload
 * are recorded under the pass's creator, and paperwork lands on the pass's item. The app client is
 * the audited one (`withAudit(withEncryption(base))`), as in production.
 *
 * SQLite always runs, with the shipped `connection_limit=1` and with a pooled client. PostgreSQL
 * runs only when BV_TEST_POSTGRES_URL points at a scratch database (it is reset with
 * `prisma migrate reset --force`, so never point it at real data).
 */
const ctx = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const dir = `${base}/bv-capture-upload-real-db-${process.pid}-${Date.now()}`;
  process.env.DB_PROVIDER = "sqlite";
  process.env.DATABASE_URL = `file:${dir}/t.db?connection_limit=1`;
  process.env.IMAGE_UPLOAD_DIR = `${dir}/uploads`;
  process.env.TRUSTED_PROXIES = "10.0.0.0/8";
  return { dir, file: `${dir}/t.db`, uploads: `${dir}/uploads` };
});

vi.mock("@/lib/prisma", () => {
  const holder: { current: unknown } = { current: undefined };
  const prisma = new Proxy({}, { get: (_t, key) => Reflect.get(holder.current as object, key) });
  return { prisma, __holder: holder };
});

import type { PrismaClient } from "@prisma/client";
import * as prismaModule from "@/lib/prisma";
import { withAudit } from "@/lib/audit/extension";
import { withEncryption } from "@/lib/encryption/extension";
import { PASS_MAX_UPLOADS, createPass } from "./pass";
import { handleCaptureUpload } from "./upload";

vi.setConfig({ testTimeout: 30_000 });

const holder = (prismaModule as unknown as { __holder: { current: unknown } }).__holder;
const PG_URL = process.env.BV_TEST_POSTGRES_URL;
const MINUTE = 60_000;

let jpeg: Buffer;

function makeApp(base: PrismaClient): PrismaClient {
  return withAudit(withEncryption(base)) as unknown as PrismaClient;
}

async function seed(client: PrismaClient) {
  for (const model of ["auditEvent", "photo", "document", "capturePass", "session", "user", "gear", "ammoStock"] as const) {
    await (client[model] as unknown as { deleteMany(): Promise<unknown> }).deleteMany();
  }
  const user = await client.user.create({
    data: { username: "ann", displayName: "Ann", passwordHash: "x", role: "USER" },
  });
  const session = await client.session.create({
    data: { userId: user.id, tokenHash: `h-${Date.now()}-${Math.random()}`, expiresAt: new Date(Date.now() + 60 * MINUTE) },
  });
  const gear = await client.gear.create({ data: { name: "Plate carrier", category: "ARMOR" } });
  const ammo = await client.ammoStock.create({ data: { caliber: "9mm", brand: "Acme" } });
  return { userId: user.id, sessionId: session.id, gearId: gear.id, ammoId: ammo.id };
}

function uploadRequest(token: string, fields: Record<string, string>) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(jpeg)], "x.jpg", { type: "image/jpeg" }));
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`http://localhost/api/capture/${token}/upload`, {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": "10.2.0.1" },
  });
}

function suite(getBase: () => PrismaClient, getApp: () => PrismaClient) {
  const open = async (type: "gear" | "ammo" = "gear") => {
    const base = getBase();
    const seeded = await seed(base);
    // createPass runs on the plain client: on the audited one its array-form transaction needs a second connection.
    holder.current = base;
    const made = await createPass({
      entityType: type,
      entityId: type === "gear" ? seeded.gearId : seeded.ammoId,
      createdById: seeded.userId,
      sessionId: seeded.sessionId,
    });
    holder.current = getApp();
    return { ...made, ...seeded };
  };
  const events = (entityType: string) =>
    getBase().auditEvent.findMany({ where: { entityType, action: "CREATE" } });

  beforeEach(() => {
    rmSync(ctx.uploads, { recursive: true, force: true });
  });

  it("two concurrent uploads on a pass at 49: one 201, one 410 full, one Photo row", async () => {
    const pass = await open();
    await getBase().capturePass.update({ where: { id: pass.id }, data: { uploadCount: PASS_MAX_UPLOADS - 1 } });
    const results = await Promise.all([
      handleCaptureUpload(uploadRequest(pass.token, { kind: "photo" }), pass.token),
      handleCaptureUpload(uploadRequest(pass.token, { kind: "photo" }), pass.token),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
    const loser = results.find((r) => r.status === 410)!;
    expect((await loser.json()).reason).toBe("full");
    expect(await getBase().photo.count()).toBe(1);
    expect((await getBase().capturePass.findUniqueOrThrow({ where: { id: pass.id } })).uploadCount).toBe(PASS_MAX_UPLOADS);
  });

  it("a photo upload is audited under the pass's creator and lands on the pass's item", async () => {
    const pass = await open();
    const res = await handleCaptureUpload(uploadRequest(pass.token, { kind: "photo", gearId: "other" }), pass.token);
    expect(res.status).toBe(201);
    const photo = await getBase().photo.findFirstOrThrow();
    expect(photo).toMatchObject({ gearId: pass.gearId, viaPass: true, createdById: pass.userId });
    const [event, ...rest] = await events("Photo");
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ entityId: photo.id, actorId: pass.userId, actorName: "Ann (@ann)", actorIp: "10.2.0.1" });
  });

  it("paperwork on an ammo pass creates a Document with ammoStockId set, audited under the creator", async () => {
    const pass = await open("ammo");
    const res = await handleCaptureUpload(uploadRequest(pass.token, { kind: "paperwork", docType: "RECEIPT" }), pass.token);
    expect(res.status).toBe(201);
    const body = await res.json();
    const doc = await getBase().document.findUniqueOrThrow({ where: { id: body.id } });
    expect(doc).toMatchObject({
      ammoStockId: pass.ammoId,
      firearmId: null,
      type: "RECEIPT",
      notes: "Added from a phone capture pass",
    });
    expect(doc.name).toMatch(/^Receipt \d{4}-\d{2}-\d{2}$/);
    const [event] = await events("Document");
    expect(event).toMatchObject({ entityId: doc.id, actorId: pass.userId });
    expect(readdirSync(`${ctx.uploads}/documents`)).toHaveLength(1);
  });

  it("a rejected picture gives the slot back and leaves no row", async () => {
    const pass = await open();
    const form = new FormData();
    form.set("kind", "photo");
    form.set("file", new File([new TextEncoder().encode("not a picture")], "x.jpg"));
    const res = await handleCaptureUpload(
      new Request("http://localhost/x", { method: "POST", body: form, headers: { "x-forwarded-for": "10.2.0.1" } }),
      pass.token,
    );
    expect(res.status).toBe(400);
    expect((await getBase().capturePass.findUniqueOrThrow({ where: { id: pass.id } })).uploadCount).toBe(0);
    expect(await getBase().photo.count()).toBe(0);
  });
}

describe("capture upload against real SQLite", () => {
  let shipped: PrismaClient;
  let pooled: PrismaClient;
  let shippedApp: PrismaClient;
  let pooledApp: PrismaClient;

  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    mkdirSync(ctx.dir, { recursive: true });
    execFileSync("npx", ["prisma", "migrate", "deploy", "--schema", "prisma/sqlite/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "sqlite", DATABASE_URL: `file:${ctx.file}` },
      stdio: "pipe",
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: SqliteClient } = require(".prisma/client-sqlite");
    shipped = new SqliteClient({ datasourceUrl: `file:${ctx.file}?connection_limit=1` }) as PrismaClient;
    pooled = new SqliteClient({ datasourceUrl: `file:${ctx.file}?connection_limit=4` }) as PrismaClient;
    shippedApp = makeApp(shipped);
    pooledApp = makeApp(pooled);
  }, 60_000);

  afterAll(async () => {
    await shipped?.$disconnect();
    await pooled?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  describe("shipped client (connection_limit=1)", () => suite(() => shipped, () => shippedApp));
  describe("pooled client (connection_limit=4)", () => suite(() => pooled, () => pooledApp));
});

describe.skipIf(!PG_URL)("capture upload against real PostgreSQL (BV_TEST_POSTGRES_URL)", () => {
  let pg: PrismaClient;
  let pgApp: PrismaClient;

  beforeAll(async () => {
    jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#336699" } }).jpeg().toBuffer();
    execFileSync("npx", ["prisma", "migrate", "reset", "--force", "--skip-seed", "--schema", "prisma/postgres/schema.prisma"], {
      cwd: process.cwd(),
      env: { ...process.env, DB_PROVIDER: "postgres", DATABASE_URL: PG_URL },
      stdio: "pipe",
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaClient: PgClient } = require("@prisma/client");
    pg = new PgClient({ datasourceUrl: `${PG_URL}${PG_URL!.includes("?") ? "&" : "?"}connection_limit=4` }) as PrismaClient;
    pgApp = makeApp(pg);
  }, 120_000);

  afterAll(async () => {
    await pg?.$disconnect();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  suite(() => pg, () => pgApp);
});
