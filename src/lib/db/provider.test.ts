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
});
