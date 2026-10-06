import { describe, expect, it } from "vitest";
import { addDaysDateOnly } from "./date";
import { dueInLabel, MAX_DUE_ROWS, partitionByDue } from "./due";

const TODAY = "2026-10-05";
const item = (id: string, due: string) => ({ id, due });
const dueOf = (i: { due: string }) => addDaysDateOnly(i.due, 0);

describe("partitionByDue", () => {
  it("counts calendar days on the viewer's date: due 1 October is 4 days overdue on 5 October", () => {
    const { overdue, dueSoon } = partitionByDue([item("a", "2026-10-01")], dueOf, TODAY);
    expect(overdue.map((i) => [i.id, i.days])).toEqual([["a", 4]]);
    expect(dueSoon).toEqual([]);
  });

  it("last serviced 3 July with a 90-day interval is due 1 October", () => {
    const { overdue } = partitionByDue(
      [{ id: "a", last: "2026-07-03T00:00:00.000Z", interval: 90 }],
      (i) => addDaysDateOnly(i.last, i.interval),
      TODAY,
    );
    expect(overdue[0].dueDate.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(overdue[0].days).toBe(4);
  });

  it.each([
    ["2026-10-04", "overdue", 1],
    ["2026-10-05", "dueSoon", 0],
    ["2026-10-06", "dueSoon", 1],
    ["2026-11-04", "dueSoon", 30],
  ] as const)("due %s is in %s with %i day(s)", (due, list, days) => {
    const result = partitionByDue([item("a", due)], dueOf, TODAY);
    expect(result[list].map((i) => i.days)).toEqual([days]);
    expect(result[list === "overdue" ? "dueSoon" : "overdue"]).toEqual([]);
  });

  it("leaves out anything due more than 30 days ahead", () => {
    const result = partitionByDue([item("a", "2026-11-05")], dueOf, TODAY);
    expect(result).toEqual({ overdue: [], dueSoon: [] });
  });

  it("orders each list most urgent first", () => {
    const result = partitionByDue(
      [item("soon", "2026-10-07"), item("old", "2026-09-01"), item("recent", "2026-10-03"), item("today", "2026-10-05")],
      dueOf,
      TODAY,
    );
    expect(result.overdue.map((i) => i.id)).toEqual(["old", "recent"]);
    expect(result.dueSoon.map((i) => i.id)).toEqual(["today", "soon"]);
  });

  it("shows at most the row limit across both lists, overdue first", () => {
    const many = Array.from({ length: MAX_DUE_ROWS - 1 }, (_, n) => item(`o${n}`, "2026-09-01"));
    const result = partitionByDue([...many, item("s1", "2026-10-06"), item("s2", "2026-10-07")], dueOf, TODAY);
    expect(result.overdue).toHaveLength(MAX_DUE_ROWS - 1);
    expect(result.dueSoon.map((i) => i.id)).toEqual(["s1"]);
  });
});

describe("dueInLabel", () => {
  it.each([
    [0, "Due today"],
    [1, "Due in 1d"],
    [12, "Due in 12d"],
  ])("%i -> %s", (days, label) => {
    expect(dueInLabel(days)).toBe(label);
  });
});
