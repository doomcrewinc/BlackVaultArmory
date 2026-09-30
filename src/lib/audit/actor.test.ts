import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  headers: null as Headers | null,
  user: null as { id: string; username: string; displayName: string } | null,
  lookups: 0,
  fail: false,
}));

vi.mock("next/headers", async (importActual) => {
  const actual = await importActual<typeof import("next/headers")>();
  return { ...actual, headers: async () => state.headers ?? actual.headers() };
});
vi.mock("@/lib/server/auth", () => ({
  getCurrentUser: vi.fn(async () => {
    state.lookups++;
    if (state.fail) throw new Error("db down");
    return state.user;
  }),
}));

import { resolveActor } from "./actor";

describe("resolveActor", () => {
  beforeEach(() => {
    state.headers = null;
    state.user = null;
    state.lookups = 0;
    state.fail = false;
    delete process.env.TRUSTED_PROXIES;
  });

  it("outside a request (the real next/headers throws) → system, no session lookup", async () => {
    expect(await resolveActor()).toEqual({ kind: "system", actorId: null, actorName: "system", actorIp: null });
    expect(state.lookups).toBe(0);
  });

  it("signed-in user → snapshot name; IP only from a trusted proxy's last X-Forwarded-For", async () => {
    process.env.TRUSTED_PROXIES = "10.0.0.1";
    state.headers = new Headers({ "x-forwarded-for": "6.6.6.6, 10.9.8.7" });
    state.user = { id: "u1", username: "jeff", displayName: "Jeff" };
    expect(await resolveActor()).toEqual({ kind: "user", actorId: "u1", actorName: "Jeff (@jeff)", actorIp: "10.9.8.7" });
  });

  it("no user → anonymous; a failing lookup never throws", async () => {
    state.headers = new Headers();
    expect(await resolveActor()).toMatchObject({ kind: "anonymous", actorName: "anonymous", actorId: null });
    state.headers = new Headers();
    state.fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await resolveActor()).toMatchObject({ kind: "anonymous" });
    spy.mockRestore();
  });

  it("memoised per headers object (one request): concurrent and repeated calls share one lookup", async () => {
    state.headers = new Headers();
    state.user = { id: "u1", username: "jeff", displayName: "Jeff" };
    const [a, b] = await Promise.all([resolveActor(), resolveActor()]);
    const c = await resolveActor();
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(state.lookups).toBe(1);
    state.headers = new Headers();
    await resolveActor();
    expect(state.lookups).toBe(2);
  });
});
