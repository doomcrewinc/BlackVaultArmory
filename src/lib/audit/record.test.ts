import { describe, expect, it, vi } from "vitest";
import { redactDeep, writeAuditEvent } from "./record";
import { REDACTED } from "./redact";

describe("redactDeep", () => {
  it("redacts sensitive fields at every level, arrays included, and leaves dates and scalars alone", () => {
    const when = new Date("2024-01-01T00:00:00.000Z");
    expect(
      redactDeep({
        serialNumber: "S1",
        name: "n",
        when,
        kids: { create: [{ serialNumber: "S2", apiKey: "k", note: "ok" }] },
      }),
    ).toEqual({ serialNumber: REDACTED, name: "n", when, kids: { create: [{ serialNumber: REDACTED, apiKey: REDACTED, note: "ok" }] } });
  });
});

describe("writeAuditEvent", () => {
  it("writes one row with the actor columns and JSON-text changes", async () => {
    const create = vi.fn().mockResolvedValue({});
    await writeAuditEvent(
      { auditEvent: { create } } as unknown as Parameters<typeof writeAuditEvent>[0],
      {
        action: "UPDATE",
        actor: { actorId: "u1", actorName: "Alice A (@alice)", actorIp: "10.0.0.1" },
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: "Glock (9mm)",
        changes: { name: ["a", "b"] },
      },
    );
    expect(create).toHaveBeenCalledWith({
      data: {
        actorId: "u1",
        actorName: "Alice A (@alice)",
        actorIp: "10.0.0.1",
        action: "UPDATE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: "Glock (9mm)",
        changes: '{"name":["a","b"]}',
      },
    });
  });

  it("stores null for absent entity fields and absent changes", async () => {
    const create = vi.fn().mockResolvedValue({});
    await writeAuditEvent({ auditEvent: { create } } as unknown as Parameters<typeof writeAuditEvent>[0], {
      action: "LOGOUT",
      actor: { actorId: null, actorName: "system", actorIp: null },
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ entityType: null, entityId: null, entityLabel: null, changes: null });
  });
});
