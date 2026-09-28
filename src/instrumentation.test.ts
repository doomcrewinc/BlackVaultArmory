import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/date-migration", () => ({ runStartupDateMigration: vi.fn() }));
vi.mock("./lib/db/split-brain-guard", () => ({ runSplitBrainGuard: vi.fn() }));
const seed = vi.hoisted(() => vi.fn());
vi.mock("./lib/server/direct-access", () => ({ seedDirectAccessSetting: seed }));
const ensureSetupToken = vi.hoisted(() => vi.fn());
vi.mock("./lib/auth/tokens", () => ({ ensureSetupToken }));

import { register } from "./instrumentation";
import { resetPublicUrlCacheForTests } from "./lib/server/public-url";

const saved = { ...process.env };

beforeEach(() => {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  vi.spyOn(console, "error").mockImplementation(() => {});
  seed.mockReset();
  ensureSetupToken.mockReset();
  resetPublicUrlCacheForTests();
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("register", () => {
  it("exits 1 with the variable named when PUBLIC_URL is missing", async () => {
    delete process.env.PUBLIC_URL;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("BLACKVAULT_PUBLIC_URL");
  });

  it("exits 1 when PUBLIC_URL has a path", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com/vault";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not exit during next build", async () => {
    delete process.env.PUBLIC_URL;
    process.env.NEXT_PHASE = "phase-production-build";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("seeds direct access and survives a seed failure", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com";
    seed.mockRejectedValue(new Error("db down"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await expect(register()).resolves.toBeUndefined();
    expect(seed).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });

  it("prints the setup token line exactly when no user exists", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com";
    ensureSetupToken.mockResolvedValue("ABCD-EFGH-JKMN-PQRS");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await register();
    expect(log).toHaveBeenCalledWith(
      "[auth] Setup token: ABCD-EFGH-JKMN-PQRS — create the first admin at https://vault.example.com/setup",
    );
  });

  it("prints nothing when users already exist", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com";
    ensureSetupToken.mockResolvedValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await register();
    expect(ensureSetupToken).toHaveBeenCalledOnce();
    expect(log).not.toHaveBeenCalled();
  });

  it("survives a setup-token failure", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com";
    ensureSetupToken.mockRejectedValue(new Error("db down"));
    await expect(register()).resolves.toBeUndefined();
    expect(vi.mocked(console.error).mock.calls.some((c) => String(c[0]).startsWith("[auth]"))).toBe(true);
  });

  it("does not mint a setup token during next build", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    await register();
    expect(ensureSetupToken).not.toHaveBeenCalled();
  });
});
