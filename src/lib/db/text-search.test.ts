import { describe, expect, it } from "vitest";
import { containsInsensitive } from "./text-search";

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
});
