import { describe, expect, it } from "vitest";
import { effectiveLastServiced } from "./maintenance";

const iso = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

describe("effectiveLastServiced", () => {
  it.each([
    ["a log entry after the stored date counts", "2026-07-03T00:00:00.000Z", ["2026-10-01T00:00:00.000Z"], "2026-10-01"],
    ["an older log entry does not move it back", "2026-07-03", ["2026-05-01"], "2026-07-03"],
    ["the newest of several entries wins", "2026-07-03", ["2026-08-01", "2026-10-01", "2026-09-01"], "2026-10-01"],
    ["with no entries the stored date stands", "2026-07-03", [], "2026-07-03"],
    ["with no stored date the newest entry is it", null, ["2026-10-01", "2026-09-01"], "2026-10-01"],
    ["nothing recorded at all", null, [], null],
  ])("%s", (_name, stored, logs, expected) => {
    expect(iso(effectiveLastServiced(stored, logs))).toBe(expected);
  });

  it("deleting the newest entry falls back to the stored date", () => {
    const before = effectiveLastServiced("2026-07-03", ["2026-10-01"]);
    const after = effectiveLastServiced("2026-07-03", []);
    expect([iso(before), iso(after)]).toEqual(["2026-10-01", "2026-07-03"]);
  });

  it("accepts Date objects and ignores the time of day", () => {
    const result = effectiveLastServiced(new Date("2026-07-03T00:00:00.000Z"), [new Date("2026-10-01T18:30:00.000Z")]);
    expect(result?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});
