import { describe, expect, it } from "vitest";
import { lastServicedAfterDelete, lastServicedAfterEntry } from "./maintenance";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("lastServicedAfterEntry", () => {
  it.each([
    ["a later entry resets the clock", "2026-07-03", "2026-10-01", "2026-10-01"],
    ["an older entry does not move it back", "2026-07-03", "2026-05-01", "2026-07-03"],
    ["the same day stays", "2026-07-03", "2026-07-03", "2026-07-03"],
  ])("%s", (_name, current, entry, expected) => {
    expect(lastServicedAfterEntry(d(current), d(entry))).toEqual(d(expected));
  });

  it("the first entry sets the date when there was none", () => {
    expect(lastServicedAfterEntry(null, d("2026-10-01"))).toEqual(d("2026-10-01"));
  });
});

describe("lastServicedAfterDelete", () => {
  it("falls back to the latest remaining entry when the last service is deleted", () => {
    expect(lastServicedAfterDelete(d("2026-10-01"), d("2026-10-01"), d("2026-07-03"))).toEqual(d("2026-07-03"));
  });

  it("keeps the date when the deleted entry was not the last service", () => {
    expect(lastServicedAfterDelete(d("2026-10-01"), d("2026-07-03"), d("2026-10-01"))).toEqual(d("2026-10-01"));
  });

  it("keeps the date when no entry remains", () => {
    expect(lastServicedAfterDelete(d("2026-10-01"), d("2026-10-01"), null)).toEqual(d("2026-10-01"));
  });

  it("stays null when there was no date", () => {
    expect(lastServicedAfterDelete(null, d("2026-10-01"), null)).toBeNull();
  });
});
