import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const db = vi.hoisted(() => {
  const firearm = { findUnique: vi.fn(), update: vi.fn() };
  const maintenanceLog = { create: vi.fn(), delete: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() };
  const client = {
    firearm,
    maintenanceLog,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ firearm, maintenanceLog })),
  };
  return client;
});
vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { POST } from "./route";
import { DELETE } from "./[entryId]/route";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const post = (body: unknown) =>
  POST(new NextRequest("http://localhost/api/firearms/f1/maintenance", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "f1" }),
  });
const del = () =>
  DELETE(new NextRequest("http://localhost/api/firearms/f1/maintenance/e1", { method: "DELETE" }), {
    params: Promise.resolve({ id: "f1", entryId: "e1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.maintenanceLog.create.mockImplementation(async ({ data }: { data: object }) => ({ id: "e-new", ...data }));
  db.firearm.update.mockImplementation(async ({ data }: { data: object }) => ({
    lastMaintenanceDate: null,
    maintenanceIntervalDays: 90,
    ...data,
  }));
});

describe("POST /api/firearms/[id]/maintenance", () => {
  it("logging work done after the last service resets the clock and keeps the interval", async () => {
    db.firearm.findUnique.mockResolvedValue({ id: "f1", lastMaintenanceDate: d("2026-07-03"), maintenanceIntervalDays: 90 });
    const res = await post({ date: "2026-10-01", notes: "Cleaned and Oiled" });
    expect(res.status).toBe(201);
    expect(db.firearm.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "f1" }, data: { lastMaintenanceDate: d("2026-10-01") } }),
    );
    const body = await res.json();
    expect(body.notes).toBe("Cleaned and Oiled");
    expect(body.firearm.lastMaintenanceDate).toBe("2026-10-01T00:00:00.000Z");
    expect(body.firearm.maintenanceIntervalDays).toBe(90);
  });

  it.each([
    ["an older, forgotten job does not move the date back", "2026-07-03", "2026-05-01", "2026-07-03"],
    ["the first entry sets the date", null, "2026-10-01", "2026-10-01"],
  ])("%s", async (_name, current, entry, expected) => {
    db.firearm.findUnique.mockResolvedValue({
      id: "f1",
      lastMaintenanceDate: current ? d(current) : null,
      maintenanceIntervalDays: 90,
    });
    await post({ date: entry, notes: "work" });
    expect(db.firearm.update.mock.calls[0][0].data).toEqual({ lastMaintenanceDate: d(expected) });
  });

  it("a next-due date makes the entry the last service and sets the interval from it", async () => {
    db.firearm.findUnique.mockResolvedValue({ id: "f1", lastMaintenanceDate: d("2026-07-03"), maintenanceIntervalDays: 90 });
    await post({ date: "2026-10-01", notes: "work", nextDueDate: "2026-11-30" });
    expect(db.firearm.update.mock.calls[0][0].data).toEqual({
      lastMaintenanceDate: d("2026-10-01"),
      maintenanceIntervalDays: 60,
    });
  });

  it("writes the entry and the firearm in one transaction", async () => {
    db.firearm.findUnique.mockResolvedValue({ id: "f1", lastMaintenanceDate: null, maintenanceIntervalDays: null });
    await post({ date: "2026-10-01", notes: "work" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(typeof db.$transaction.mock.calls[0][0]).toBe("function");
  });

  it.each([
    [{ notes: "x" }, 400],
    [{ date: "2026-10-01", notes: "  " }, 400],
    [{ date: "not-a-date", notes: "x" }, 400],
  ])("rejects %j", async (body, status) => {
    db.firearm.findUnique.mockResolvedValue({ id: "f1", lastMaintenanceDate: null, maintenanceIntervalDays: null });
    expect((await post(body)).status).toBe(status);
    expect(db.maintenanceLog.create).not.toHaveBeenCalled();
  });

  it("404 for an unknown firearm", async () => {
    db.firearm.findUnique.mockResolvedValue(null);
    expect((await post({ date: "2026-10-01", notes: "x" })).status).toBe(404);
  });
});

describe("DELETE /api/firearms/[id]/maintenance/[entryId]", () => {
  it("deleting the last service falls back to the latest remaining entry", async () => {
    db.maintenanceLog.findUnique.mockResolvedValue({ id: "e1", firearmId: "f1", date: d("2026-10-01") });
    db.firearm.findUnique.mockResolvedValue({ lastMaintenanceDate: d("2026-10-01"), maintenanceIntervalDays: 90 });
    db.maintenanceLog.findFirst.mockResolvedValue({ date: d("2026-07-03") });
    const res = await del();
    expect(db.maintenanceLog.delete).toHaveBeenCalledWith({ where: { id: "e1" } });
    expect(db.firearm.update.mock.calls[0][0].data).toEqual({ lastMaintenanceDate: d("2026-07-03") });
    expect((await res.json()).firearm.lastMaintenanceDate).toBe("2026-07-03T00:00:00.000Z");
  });

  it.each([
    ["an entry that was not the last service", "2026-07-03", { date: d("2026-10-01") }],
    ["the only entry", "2026-10-01", null],
  ])("deleting %s leaves the date alone", async (_name, deleted, remaining) => {
    db.maintenanceLog.findUnique.mockResolvedValue({ id: "e1", firearmId: "f1", date: d(deleted) });
    db.firearm.findUnique.mockResolvedValue({ lastMaintenanceDate: d("2026-10-01"), maintenanceIntervalDays: 90 });
    db.maintenanceLog.findFirst.mockResolvedValue(remaining);
    const res = await del();
    expect(res.status).toBe(200);
    expect(db.firearm.update).not.toHaveBeenCalled();
  });

  it("404 when the entry belongs to another firearm", async () => {
    db.maintenanceLog.findUnique.mockResolvedValue({ id: "e1", firearmId: "other", date: d("2026-10-01") });
    expect((await del()).status).toBe(404);
    expect(db.maintenanceLog.delete).not.toHaveBeenCalled();
  });
});
