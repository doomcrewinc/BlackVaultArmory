import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BACKUP_MODELS } from "@/lib/backup/models";
import { openBackup } from "@/lib/encryption/core.mjs";

// The real requireAdmin, driven by the session lookup: ADMIN by default, USER/null per test.
const auth = vi.hoisted(() => ({ validateSession: vi.fn() }));
const ADMIN_SESSION = { sessionId: "s1", user: { id: "u1", username: "admin", displayName: "Admin", role: "ADMIN" } };
const USER_SESSION = { sessionId: "s2", user: { id: "u2", username: "jeff", displayName: "Jeff", role: "USER" } };
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "t" }) }) }));
vi.mock("@/lib/auth/sessions", () => ({ SESSION_COOKIE: "bv_session", validateSession: auth.validateSession }));

const mocks = vi.hoisted(() => ({
  findManyCalls: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  settingsFindUnique: vi.fn(),
  recordEvent: vi.fn(async (_client: unknown, _e: { action: string }) => {}),
}));

vi.mock("@/lib/audit/events", () => ({
  recordEvent: mocks.recordEvent,
  recordEventBestEffort: async (client: unknown, e: { action: string }) => {
    try {
      await mocks.recordEvent(client, e);
    } catch (err) {
      console.error(`[audit] failed to record ${e.action} (request otherwise succeeded):`, err);
    }
  },
}));

vi.mock("@/lib/prisma", async () => {
  const { BACKUP_MODELS: models } = await vi.importActual<typeof import("@/lib/backup/models")>(
    "@/lib/backup/models"
  );
  const prisma: Record<string, unknown> = {
    appSettings: { findUnique: mocks.settingsFindUnique },
  };
  for (const m of models) {
    prisma[m.delegate] = {
      findMany: vi.fn(async () => {
        mocks.findManyCalls.push(m.delegate);
        mocks.inFlight += 1;
        mocks.maxInFlight = Math.max(mocks.maxInFlight, mocks.inFlight);
        await new Promise((r) => setTimeout(r, 1));
        mocks.inFlight -= 1;
        return [{ id: `${m.delegate}-1` }];
      }),
    };
  }
  return { prisma };
});

import { POST } from "./route";

const PASSPHRASE = "correct horse battery staple";

function backupRequest(body: unknown = { passphrase: PASSPHRASE }) {
  return new NextRequest("http://localhost/api/backup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Opens the sealed response body with the test passphrase and parses the plaintext backup JSON. */
async function openedBody(response: Response, passphrase = PASSPHRASE) {
  const envelope = JSON.parse(await response.text());
  return JSON.parse(openBackup(passphrase, envelope));
}

describe("POST /api/backup", () => {
  beforeEach(() => {
    mocks.findManyCalls.length = 0;
    mocks.inFlight = 0;
    mocks.maxInFlight = 0;
    mocks.settingsFindUnique.mockResolvedValue({ includeUploadsInBackup: true, backupDestinationPath: null });
    auth.validateSession.mockResolvedValue(ADMIN_SESSION);
    mocks.recordEvent.mockClear();
  });

  it("401 when signed out, nothing exported", async () => {
    auth.validateSession.mockResolvedValue(null);
    const response = await POST(backupRequest());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
    expect(mocks.findManyCalls).toEqual([]);
  });

  it("403 Admins only for a USER, nothing exported", async () => {
    auth.validateSession.mockResolvedValue(USER_SESSION);
    const response = await POST(backupRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Admins only" });
    expect(mocks.findManyCalls).toEqual([]);
  });

  it("400 when the passphrase is under 12 characters, nothing exported", async () => {
    const response = await POST(backupRequest({ passphrase: "tooshort" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Passphrase must be at least 12 characters." });
    expect(mocks.findManyCalls).toEqual([]);
  });

  it("400 when the passphrase is missing or not a string", async () => {
    const response = await POST(backupRequest({}));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Passphrase must be at least 12 characters." });
  });

  it("returns 200 with the sealed envelope as an attachment, never plaintext JSON", async () => {
    const response = await POST(backupRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const disposition = response.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).toMatch(/filename="blackvault-backup-\d{8}-\d{6}\.sealed\.json"/);

    const envelope = JSON.parse(await response.text());
    expect(envelope.format).toBe("blackvault-sealed-backup");
    // Not readable without the passphrase: no field of the plaintext backup
    // (e.g. a BACKUP_MODELS key) appears in the raw envelope text.
    expect(JSON.stringify(envelope)).not.toContain("firearms");
  });

  it("the opened envelope exports every registered model, including the ones restore used to destroy", async () => {
    const response = await POST(backupRequest());
    const json = await openedBody(response);

    for (const { key, delegate } of BACKUP_MODELS) {
      expect(json[key], key).toEqual([{ id: `${delegate}-1` }]);
    }
    expect(json.maintenanceLogs).toHaveLength(1);
    expect(json.batteryChangeLogs).toHaveLength(1);
    expect(json.dateNormalizationAudits).toHaveLength(1);
    expect(
      Object.keys(json)
        .filter((k) => k !== "meta")
        .sort(),
    ).toEqual(BACKUP_MODELS.map((m) => m.key).sort());
  });

  it("stamps version 1.1 and counts every key", async () => {
    const json = await openedBody(await POST(backupRequest()));

    expect(json.meta.version).toBe("1.1");
    expect(Object.keys(json.meta.counts).sort()).toEqual(BACKUP_MODELS.map((m) => m.key).sort());
    for (const { key } of BACKUP_MODELS) expect(json.meta.counts[key]).toBe(1);
  });

  it("a wrong passphrase cannot open another backup's envelope", async () => {
    const response = await POST(backupRequest());
    const envelope = JSON.parse(await response.text());
    expect(() => openBackup("a different passphrase entirely", envelope)).toThrow(/Wrong passphrase/);
  });

  it("records a BACKUP_CREATED event naming the file and sealed: true", async () => {
    const response = await POST(backupRequest());
    const filename = response.headers.get("X-Backup-Filename");
    expect(mocks.recordEvent).toHaveBeenCalledWith(null, {
      action: "BACKUP_CREATED",
      entityLabel: filename,
      changes: { file: filename, sealed: true },
    });
  });

  it("records no event when signed out, not an admin, or the passphrase is rejected", async () => {
    auth.validateSession.mockResolvedValue(null);
    await POST(backupRequest());
    auth.validateSession.mockResolvedValue(USER_SESSION);
    await POST(backupRequest());
    auth.validateSession.mockResolvedValue(ADMIN_SESSION);
    await POST(backupRequest({ passphrase: "short" }));
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("queries sequentially, never concurrently (SQLite connection_limit=1)", async () => {
    await POST(backupRequest());

    expect(mocks.findManyCalls).toHaveLength(BACKUP_MODELS.length);
    expect(mocks.maxInFlight).toBe(1);
  });

  it("never exports AppSettings", async () => {
    const json = await openedBody(await POST(backupRequest()));
    expect(json.appSettings).toBeUndefined();
    expect(json.settings).toBeUndefined();
  });
});
