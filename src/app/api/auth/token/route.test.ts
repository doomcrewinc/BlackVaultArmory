import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashToken } from "@/lib/auth/tokens";

type Row = { kind: string; role: string | null; userId: string | null; usedAt: Date | null; expiresAt: Date | null };

const m = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  return { rows, findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => rows.get(where.tokenHash) ?? null) };
});
vi.mock("@/lib/prisma", () => ({ prisma: { authToken: { findUnique: m.findUnique } } }));

import { GET } from "./route";

const FUTURE = new Date(Date.now() + 86_400_000);
const GONE = { error: "Link expired or already used" };

function get(t?: string) {
  const qs = t === undefined ? "" : `?t=${encodeURIComponent(t)}`;
  return GET(new NextRequest(`http://localhost/api/auth/token${qs}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rows.clear();
  m.rows.set(hashToken("invite-ok"), { kind: "INVITE", role: "ADMIN", userId: null, usedAt: null, expiresAt: FUTURE });
  m.rows.set(hashToken("reset-ok"), { kind: "RESET", role: null, userId: "u1", usedAt: null, expiresAt: FUTURE });
  m.rows.set(hashToken("used"), { kind: "INVITE", role: "USER", userId: null, usedAt: new Date(), expiresAt: FUTURE });
  m.rows.set(hashToken("expired"), { kind: "INVITE", role: "USER", userId: null, usedAt: null, expiresAt: new Date(Date.now() - 1000) });
  m.rows.set(hashToken("SETUPCODE"), { kind: "SETUP", role: null, userId: null, usedAt: null, expiresAt: null });
});

describe("GET /api/auth/token", () => {
  it("returns kind and role for a live invite", async () => {
    const res = await get("invite-ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "INVITE", role: "ADMIN" });
  });

  it("returns kind for a live reset link and nothing identifying", async () => {
    const res = await get("reset-ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kind: "RESET", role: null });
  });

  it("404 for used, expired, unknown, missing, and setup tokens", async () => {
    for (const t of ["used", "expired", "nope", "", undefined, "SETUPCODE"]) {
      const res = await get(t);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(GONE);
    }
  });
});
