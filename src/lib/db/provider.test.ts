import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider";

describe("resolveProvider", () => {
  it.each([undefined, "", "   ", "garbage", "sqlite3", "mysql"])(
    "defaults %j to postgres",
    (raw) => {
      expect(resolveProvider(raw)).toBe("postgres");
    },
  );

  it.each(["sqlite", "SQLite", " sqlite ", "SQLITE"])("resolves %j to sqlite", (raw) => {
    expect(resolveProvider(raw)).toBe("sqlite");
  });

  it.each(["postgres", "postgresql", "Postgres"])("resolves %j to postgres", (raw) => {
    expect(resolveProvider(raw)).toBe("postgres");
  });

  describe("inference from DATABASE_URL when DB_PROVIDER is unset or empty", () => {
    it.each([undefined, "", "  "])("unset %j + file: URL is sqlite", (raw) => {
      expect(resolveProvider(raw, "file:/app/data/vault.db")).toBe("sqlite");
      expect(resolveProvider(raw, "FILE:./dev.db?connection_limit=1")).toBe("sqlite");
    });

    it.each([undefined, ""])("unset %j + postgresql:// URL is postgres", (raw) => {
      expect(resolveProvider(raw, "postgresql://u:p@db:5432/blackvault")).toBe("postgres");
      expect(resolveProvider(raw, "postgres://u:p@db:5432/blackvault")).toBe("postgres");
    });

    it("unset with no URL is postgres", () => {
      expect(resolveProvider(undefined, undefined)).toBe("postgres");
    });
  });

  describe("explicit DB_PROVIDER wins over DATABASE_URL", () => {
    it("postgres beats a file: URL", () => {
      expect(resolveProvider("postgres", "file:/app/data/vault.db")).toBe("postgres");
    });

    it("sqlite beats a postgresql:// URL", () => {
      expect(resolveProvider("sqlite", "postgresql://u:p@db:5432/blackvault")).toBe("sqlite");
    });

    it("a typo is still postgres, even with a file: URL", () => {
      expect(resolveProvider("sqlit", "file:/app/data/vault.db")).toBe("postgres");
    });
  });
});
