import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_SQLITE_PATH,
  MIGRATED_MARKER_PATH,
  checkSplitBrain,
  type SplitBrainDeps,
} from "./split-brain-guard";

/** Default: the split-brain state (postgres, non-empty vault.db, no .migrated). */
function deps(overrides: Partial<SplitBrainDeps> = {}): SplitBrainDeps {
  return {
    provider: "postgres",
    sqliteFileSize: vi.fn(() => 4096),
    migratedMarkerExists: vi.fn(() => false),
    warn: vi.fn(),
    ...overrides,
  };
}

describe("checkSplitBrain", () => {
  it("new PostgreSQL install (no vault.db): silent", async () => {
    const d = deps({ sqliteFileSize: vi.fn(() => null) });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("migrated install (.migrated present, vault.db kept as rollback): silent", async () => {
    const d = deps({ migratedMarkerExists: vi.fn(() => true) });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("split-brain (postgres, non-empty vault.db, no .migrated): warns", async () => {
    const d = deps();
    expect(await checkSplitBrain(d)).toBe(true);
    const message = vi.mocked(d.warn).mock.calls[0][0];
    expect(message).toContain(LEGACY_SQLITE_PATH);
    expect(message).toContain(MIGRATED_MARKER_PATH);
    expect(message).toContain("4096 bytes");
    expect(message).not.toContain("-f docker-compose");
  });

  it("stays quiet on sqlite without touching the filesystem", async () => {
    const d = deps({ provider: "sqlite" });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
    expect(d.sqliteFileSize).not.toHaveBeenCalled();
  });

  it("stays quiet when vault.db is empty", async () => {
    const d = deps({ sqliteFileSize: vi.fn(() => 0) });
    expect(await checkSplitBrain(d)).toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
  });

  it("never throws when a filesystem check fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps({
      migratedMarkerExists: vi.fn(() => {
        throw new Error("EACCES");
      }),
    });
    await expect(checkSplitBrain(d)).resolves.toBe(false);
    expect(d.warn).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
