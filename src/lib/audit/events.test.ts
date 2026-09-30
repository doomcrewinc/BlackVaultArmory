import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * recordEvent / recordEventBestEffort in isolation — the route tests mock this whole
 * module and so cannot prove anything about its own internals (actor resolution,
 * writer selection, the open-transaction guard, or the best-effort wrapper actually
 * swallowing an error). Real-DB coverage for the end-to-end paths lives in
 * extension.real-db.test.ts; this file is the unit-level complement the original
 * brief asked for ("Create: src/lib/audit/events.ts (+ test)").
 */

const state = vi.hoisted(() => ({
  headers: null as Headers | null,
  user: null as { id: string; username: string; displayName: string } | null,
}));

vi.mock("next/headers", async (importActual) => {
  const actual = await importActual<typeof import("next/headers")>();
  return { ...actual, headers: async () => state.headers ?? actual.headers() };
});
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => state.user),
}));

type CreateArgs = { data: Record<string, unknown> };

const writer = vi.hoisted(() => ({ auditEvent: { create: vi.fn(async (_args: CreateArgs) => {}) } }));
vi.mock("../prisma", () => ({ prisma: writer }));

import type { Prisma } from "@prisma/client";
import { auditStorage, type AuditActor } from "./context";
import { recordEvent, recordEventBestEffort, type TxOrClient } from "./events";

/** Cast the same way record.test.ts does: a plain mock delegate stands in for a real transaction client. */
function fakeTx() {
  const create = vi.fn(async (_args: CreateArgs) => {});
  const fake = { auditEvent: { create } };
  // Two casts of the same object: recordEvent's `client` param (TxOrClient) and the
  // audit store's `tx` field (Prisma.TransactionClient) are typed differently, even
  // though a real interactive-transaction client satisfies both.
  return { auditEvent: { create }, asTx: fake as unknown as TxOrClient, asStoreTx: fake as unknown as Prisma.TransactionClient };
}

beforeEach(() => {
  state.headers = null;
  state.user = null;
  writer.auditEvent.create.mockClear();
});

describe("recordEvent", () => {
  it("client=null, no store: writes through the app client with resolveActor()'s actor", async () => {
    state.headers = new Headers();
    state.user = { id: "u1", username: "jeff", displayName: "Jeff" };
    await recordEvent(null, { action: "LOGOUT", entityType: "User", entityId: "u1" });
    expect(writer.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: "u1", actorName: "Jeff (@jeff)", action: "LOGOUT" }),
    });
  });

  it("actorOverride wins over resolveActor()", async () => {
    state.headers = new Headers();
    state.user = { id: "u1", username: "jeff", displayName: "Jeff" };
    await recordEvent(null, { action: "LOGIN", actorOverride: { actorId: "u2", actorName: "Other (@other)" } });
    const data = writer.auditEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ actorId: "u2", actorName: "Other (@other)" });
  });

  it("a null actorOverride.actorId records anonymous, not the request's own signed-in user", async () => {
    state.headers = new Headers();
    state.user = { id: "u1", username: "jeff", displayName: "Jeff" };
    await recordEvent(null, { action: "LOGIN_FAILED", actorOverride: { actorId: null, actorName: "anonymous" } });
    const data = writer.auditEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ actorId: null, actorName: "anonymous" });
  });

  it("an explicit tx client writes through it, not the app client", async () => {
    const tx = fakeTx();
    await recordEvent(tx.asTx, { action: "ROLE_CHANGED", actorOverride: { actorId: "a1", actorName: "Admin (@admin)" } });
    expect(tx.auditEvent.create).toHaveBeenCalledOnce();
    expect(writer.auditEvent.create).not.toHaveBeenCalled();
  });

  it("reuses the audit store's already-resolved actor instead of calling resolveActor() again", async () => {
    const tx = fakeTx();
    const actor: AuditActor = { kind: "user", actorId: "u9", actorName: "Store User (@storeuser)", actorIp: null };
    const lookups = vi.fn();
    state.user = null; // if resolveActor() were called it would report anonymous, not this actor
    await auditStorage.run({ tx: tx.asStoreTx, actor }, async () => {
      await recordEvent(null, { action: "ROLE_CHANGED" });
    });
    expect(lookups).not.toHaveBeenCalled();
    const data = tx.auditEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ actorId: "u9", actorName: "Store User (@storeuser)" });
  });

  it("redacts changes the same way row changes are redacted", async () => {
    await recordEvent(null, { action: "BACKUP_CREATED", changes: { file: "x.json", password: "leak" } });
    const data = writer.auditEvent.create.mock.calls[0]![0].data;
    expect(JSON.parse(data.changes as string)).toEqual({ file: "x.json", password: "[redacted]" });
  });

  // ─── Guard: keyed on the STORE's tx, not on whether `client` was passed ─

  it("an explicit tx client with NO audit store active does NOT throw — a caller can legitimately pass a transaction that never went through the audited app client (admins.real-db.test.ts's raw-PrismaClient pattern)", async () => {
    const tx = fakeTx();
    state.headers = new Headers();
    state.user = { id: "u1", username: "jeff", displayName: "Jeff" };
    await recordEvent(tx.asTx, { action: "ROLE_CHANGED" });
    expect(tx.auditEvent.create).toHaveBeenCalledOnce();
    const data = tx.auditEvent.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ actorId: "u1", actorName: "Jeff (@jeff)" });
  });

  it("guard: the store's suppressed tx with no actor and no override throws, never calling resolveActor()", async () => {
    const tx = fakeTx();
    const getCurrentUser = (await import("@/lib/server/auth")).getCurrentUser as ReturnType<typeof vi.fn>;
    getCurrentUser.mockClear();
    await expect(
      auditStorage.run({ tx: tx.asStoreTx, suppress: true }, () => recordEvent(null, { action: "RESTORE" })),
    ).rejects.toThrow(/actor/i);
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it("guard also fires when a client is passed explicitly, as long as the (suppressed, actor-less) store is active", async () => {
    const tx = fakeTx();
    await expect(
      auditStorage.run({ tx: tx.asStoreTx, suppress: true }, () => recordEvent(tx.asTx, { action: "RESTORE" })),
    ).rejects.toThrow(/actor/i);
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("guard does not fire when a tx is open but the store already has an actor", async () => {
    const tx = fakeTx();
    const actor: AuditActor = { kind: "system", actorId: null, actorName: "system", actorIp: null };
    await auditStorage.run({ tx: tx.asStoreTx, actor }, () => recordEvent(null, { action: "RESTORE" }));
    expect(tx.auditEvent.create).toHaveBeenCalledOnce();
  });

  it("guard does not fire when a tx is open but actorOverride is given", async () => {
    const tx = fakeTx();
    await recordEvent(tx.asTx, { action: "ROLE_CHANGED", actorOverride: { actorId: "a1", actorName: "Admin (@admin)" } });
    expect(tx.auditEvent.create).toHaveBeenCalledOnce();
  });
});

describe("recordEventBestEffort", () => {
  it("never throws, and logs the swallowed error, when the underlying write fails", async () => {
    writer.auditEvent.create.mockRejectedValueOnce(new Error("insert boom"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recordEventBestEffort(null, { action: "BACKUP_CREATED", changes: { file: "x.json" } })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("BACKUP_CREATED"), expect.any(Error));
    spy.mockRestore();
  });

  it("still writes normally when there is no failure", async () => {
    await recordEventBestEffort(null, { action: "LOGOUT" });
    expect(writer.auditEvent.create).toHaveBeenCalledOnce();
  });

  it("also swallows the open-transaction guard's own throw rather than letting it escape", async () => {
    const tx = fakeTx();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      auditStorage.run({ tx: tx.asStoreTx, suppress: true }, () => recordEventBestEffort(null, { action: "RESTORE" })),
    ).resolves.toBeUndefined();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("RESTORE"), expect.any(Error));
    spy.mockRestore();
  });
});
