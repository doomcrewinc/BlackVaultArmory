import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runStartupDateMigration = vi.hoisted(() => vi.fn());
vi.mock("./lib/date-migration", () => ({ runStartupDateMigration }));
const runEncryptionStartup = vi.hoisted(() => vi.fn());
vi.mock("./lib/encryption/startup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/encryption/startup")>()),
  runEncryptionStartup,
}));
vi.mock("./lib/db/split-brain-guard", () => ({ runSplitBrainGuard: vi.fn() }));
const seed = vi.hoisted(() => vi.fn());
vi.mock("./lib/server/direct-access", () => ({ seedDirectAccessSetting: seed }));
const ensureSetupToken = vi.hoisted(() => vi.fn());
vi.mock("./lib/auth/tokens", () => ({ ensureSetupToken }));

import { register } from "./instrumentation";
import { resetPublicUrlCacheForTests } from "./lib/server/public-url";
import { EncryptionKeyError } from "./lib/encryption/core.mjs";
import { EncryptionMigrationError } from "./lib/encryption/startup";

const saved = { ...process.env };

beforeEach(() => {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  vi.spyOn(console, "error").mockImplementation(() => {});
  seed.mockReset();
  ensureSetupToken.mockReset();
  runStartupDateMigration.mockReset();
  runEncryptionStartup.mockReset();
  runEncryptionStartup.mockResolvedValue({ counts: {} });
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

describe("register — field encryption startup", () => {
  const order: string[] = [];
  beforeEach(() => {
    order.length = 0;
    process.env.PUBLIC_URL = "https://vault.example.com";
    runEncryptionStartup.mockImplementation(async () => {
      order.push("encryption");
      return { counts: {} };
    });
    runStartupDateMigration.mockImplementation(async () => {
      order.push("date-migration");
    });
    seed.mockImplementation(async () => {
      order.push("direct-access");
    });
  });

  it("runs the key check + encryption migration before the date migration and every other hook", async () => {
    await register();
    expect(order).toEqual(["encryption", "date-migration", "direct-access"]);
  });

  it.each(["production", "development", "test"])(
    "NODE_ENV=%s: a key error refuses to start (exit 1, one log line naming the sources) and nothing else runs",
    async (nodeEnv) => {
      (process.env as Record<string, string>).NODE_ENV = nodeEnv;
      const message =
        "No encryption key. Looked for the file /run/secrets/blackvault_encryption_key and the env var BLACKVAULT_ENCRYPTION_KEY. Generate one with: openssl rand -hex 32";
      runEncryptionStartup.mockRejectedValue(new EncryptionKeyError("KEY_MISSING", message));
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      await register();

      expect(exit).toHaveBeenCalledWith(1);
      expect(vi.mocked(console.error).mock.calls).toEqual([[`[encryption] ${message}`]]);
      expect(runStartupDateMigration).not.toHaveBeenCalled();
      expect(seed).not.toHaveBeenCalled();
      expect(ensureSetupToken).not.toHaveBeenCalled();
    },
  );

  it("a migration failure names the row and field and refuses to start", async () => {
    runEncryptionStartup.mockRejectedValue(
      new EncryptionMigrationError("Cannot encrypt Firearm.serialNumber for id f1: VAULT_ENCRYPTION_KEY is not set.", {
        model: "Firearm",
        id: "f1",
        field: "serialNumber",
      }),
    );
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("Firearm.serialNumber for id f1");
  });

  it("any other startup error also refuses to start, on one line", async () => {
    runEncryptionStartup.mockRejectedValue(new Error("database is locked\n  at somewhere"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    const line = String(vi.mocked(console.error).mock.calls[0][0]);
    expect(line).toMatch(/^\[encryption\] Startup failed, refusing to start: database is locked/);
    expect(line).not.toContain("\n");
  });

  it("does not run during next build (no key, no database at build time)", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    await register();
    expect(runEncryptionStartup).not.toHaveBeenCalled();
  });

  it("does not run on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    await register();
    expect(runEncryptionStartup).not.toHaveBeenCalled();
  });
});
