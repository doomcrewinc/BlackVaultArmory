import { describe, expect, it } from "vitest";
import { containsInsensitive, matchesLiteralInsensitive, needsLiteralCheck } from "./text-search";

describe("containsInsensitive", () => {
  it("adds mode: insensitive on postgres, where LIKE is case-sensitive", () => {
    expect(containsInsensitive("glock", "postgres")).toEqual({ contains: "glock", mode: "insensitive" });
  });

  it("omits mode entirely on sqlite, whose client rejects it", () => {
    const filter = containsInsensitive("glock", "sqlite");
    expect(filter).toEqual({ contains: "glock" });
    expect("mode" in filter).toBe(false);
  });

  it("preserves the query's casing", () => {
    expect(containsInsensitive("GLock", "postgres").contains).toBe("GLock");
    expect(containsInsensitive("GLock", "sqlite").contains).toBe("GLock");
  });

  it("escapes backslash, percent and underscore on postgres", () => {
    expect(containsInsensitive("50%_a\\b", "postgres").contains).toBe("50\\%\\_a\\\\b");
  });

  it("leaves wildcards in place on sqlite, which has no way to escape them", () => {
    expect(containsInsensitive("50%_", "sqlite").contains).toBe("50%_");
  });
});

describe("needsLiteralCheck / matchesLiteralInsensitive", () => {
  it("is needed only on sqlite and only when a wildcard is present", () => {
    expect(needsLiteralCheck("a_b", "sqlite")).toBe(true);
    expect(needsLiteralCheck("100%", "sqlite")).toBe(true);
    expect(needsLiteralCheck("plain", "sqlite")).toBe(false);
    expect(needsLiteralCheck("a_b", "postgres")).toBe(false);
  });

  it("matches a literal substring, ASCII-case-insensitively", () => {
    expect(matchesLiteralInsensitive("Pre_FIX", "e_f")).toBe(true);
    expect(matchesLiteralInsensitive("axb", "a_b")).toBe(false);
    expect(matchesLiteralInsensitive(null, "a")).toBe(false);
  });
});
