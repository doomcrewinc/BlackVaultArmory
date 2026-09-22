import { describe, expect, it, vi } from "vitest";
import { checkSplitBrain, LEGACY_SQLITE_PATH, type SplitBrainDeps } from "./split-brain-guard";

function deps(overrides: Partial<SplitBrainDeps> = {}): SplitBrainDeps {
  return {
    provider: "postgres",
    countFirearms: vi.fn(async () => 0),
    sqliteFileSize: vi.fn(() => 4096),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("checkSplitBrain", () => {
  it("warns on postgres with zero firearms and a non-empty vault.db", async () => {
    const d = deps();
    expect(await checkSplitBrain(d)).toBe(true);
    const message = vi.mocked(d.warn).mock.calls[0][0];
    expect(message).toContain(LEGACY_SQLITE_PATH);
    expect(message).toContain("docker-compose.sqlite.yml");
  });

  it("stays quiet on sqlite", async () => {
    const d = deps({ provider: "sqlite" });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
    expect(d.countFirearms).not.toHaveBeenCalled();
  });

  it("stays quiet when postgres already has firearms", async () => {
    const d = deps({ countFirearms: vi.fn(async () => 3) });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it.each([null, 0])("stays quiet when vault.db size is %j", async (size) => {
    const d = deps({ sqliteFileSize: vi.fn(() => size) });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("never throws when the database query fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({ countFirearms: vi.fn(async () => Promise.reject(new Error("down"))) });
    await expect(checkSplitBrain(d)).resolves.toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
