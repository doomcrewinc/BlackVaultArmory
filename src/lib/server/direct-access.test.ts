import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, create: mocks.create },
  },
}));

import {
  envForcesDirectAccess,
  getDirectAccessState,
  readStoredDirectAccess,
  resetDirectAccessCacheForTests,
  seedDirectAccessSetting,
} from "./direct-access";

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectAccessCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("envForcesDirectAccess", () => {
  it.each([
    ["true", true],
    ["TRUE", false],
    ["1", false],
    ["yes", false],
    [" true", false],
    [undefined, false],
  ])("ALLOW_DIRECT_ACCESS=%s -> %s", (value, expected) => {
    expect(envForcesDirectAccess({ ALLOW_DIRECT_ACCESS: value } as unknown as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("seedDirectAccessSetting", () => {
  it.each([
    ["on", true],
    [" ON ", true],
    ["off", false],
    ["", false],
    [undefined, false],
  ])("seed %s writes %s only where the value is still null", async (seed, value) => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await seedDirectAccessSetting({ DIRECT_ACCESS_INITIAL: seed } as unknown as NodeJS.ProcessEnv);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", allowDirectAccess: null },
      data: { allowDirectAccess: value },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the settings row when none exists", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(null);
    await seedDirectAccessSetting({ DIRECT_ACCESS_INITIAL: "on" } as unknown as NodeJS.ProcessEnv);
    expect(mocks.create).toHaveBeenCalledWith({ data: { id: "singleton", allowDirectAccess: true } });
  });

  it("leaves an already-decided row alone", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue({ id: "singleton" });
    await seedDirectAccessSetting({ DIRECT_ACCESS_INITIAL: "on" } as unknown as NodeJS.ProcessEnv);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("readStoredDirectAccess", () => {
  it("treats a missing row or null as false", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await readStoredDirectAccess(0)).toBe(false);
    resetDirectAccessCacheForTests();
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: null });
    expect(await readStoredDirectAccess(0)).toBe(false);
  });

  it("caches for 5 seconds", async () => {
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: true });
    expect(await readStoredDirectAccess(1_000)).toBe(true);
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: false });
    expect(await readStoredDirectAccess(5_999)).toBe(true);
    expect(await readStoredDirectAccess(6_000)).toBe(false);
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("falls back to the last known value when the database fails", async () => {
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: true });
    await readStoredDirectAccess(0);
    mocks.findUnique.mockRejectedValue(new Error("SQLITE_BUSY"));
    expect(await readStoredDirectAccess(10_000)).toBe(true);
  });

  it("falls back to false when the database fails and nothing is known", async () => {
    mocks.findUnique.mockRejectedValue(new Error("SQLITE_BUSY"));
    expect(await readStoredDirectAccess(0)).toBe(false);
  });
});

describe("getDirectAccessState", () => {
  it("env override wins without touching the database", async () => {
    expect(await getDirectAccessState({ ALLOW_DIRECT_ACCESS: "true" } as unknown as NodeJS.ProcessEnv)).toEqual({
      allowed: true,
      source: "env",
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("otherwise reports the stored setting", async () => {
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: false });
    expect(await getDirectAccessState({} as NodeJS.ProcessEnv)).toEqual({ allowed: false, source: "setting" });
  });
});
