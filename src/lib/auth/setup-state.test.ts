import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ count: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { count: mocks.count } } }));

import { hasAnyUser, markUsersExist, resetSetupStateForTests } from "./setup-state";

beforeEach(() => {
  vi.clearAllMocks();
  resetSetupStateForTests();
});

// checkedAt starts at 0 (see resetSetupStateForTests), so "now" values here
// start well past 0 — a `now` of 0 would coincidentally look like "just
// checked" against that initial sentinel and skip the query entirely.
const T0 = 1_700_000_000_000;

describe("hasAnyUser", () => {
  it("caches false for 5s, then re-queries", async () => {
    mocks.count.mockResolvedValue(0);
    expect(await hasAnyUser(T0)).toBe(false);
    expect(await hasAnyUser(T0 + 1_000)).toBe(false); // still within the 5s window — no re-query
    expect(mocks.count).toHaveBeenCalledTimes(1);
    mocks.count.mockResolvedValue(1);
    expect(await hasAnyUser(T0 + 6_000)).toBe(true); // past the window — re-queries, now true
    expect(mocks.count).toHaveBeenCalledTimes(2);
  });

  it("caches true forever once known", async () => {
    mocks.count.mockResolvedValue(1);
    expect(await hasAnyUser(T0)).toBe(true);
    mocks.count.mockResolvedValue(0); // would report false if ever re-queried
    expect(await hasAnyUser(T0 + 1_000_000)).toBe(true);
    expect(mocks.count).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale in-flight count(0) overwrite a concurrent markUsersExist()", async () => {
    // Two requests can race: request A's count() is in flight when request B
    // (the setup flow) finishes creating the first account and calls
    // markUsersExist() synchronously. If A's stale 0 is later allowed to
    // assign `known`, it flips a true back to false and traps the brand new
    // admin in a redirect loop (/ -> /setup -> / ...) for up to 5s.
    let resolveCount!: (n: number) => void;
    mocks.count.mockReturnValue(new Promise<number>((resolve) => (resolveCount = resolve)));

    const inFlight = hasAnyUser(); // starts the count() query, still pending

    markUsersExist(); // request B: setup completes concurrently
    resolveCount(0); // request A's query resolves — stale by now

    await inFlight;
    expect(await hasAnyUser()).toBe(true);
  });
});

describe("markUsersExist / resetSetupStateForTests", () => {
  it("markUsersExist makes hasAnyUser true without touching the DB", async () => {
    markUsersExist();
    expect(await hasAnyUser()).toBe(true);
    expect(mocks.count).not.toHaveBeenCalled();
  });
});
