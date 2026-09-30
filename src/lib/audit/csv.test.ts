import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";
import type { AuditEventDto } from "./query";

/** A minimal RFC 4180 single-cell parser, for the round-trip test only. */
function parseOneCell(cell: string): string {
  if (cell.startsWith('"') && cell.endsWith('"') && cell.length >= 2) {
    return cell.slice(1, -1).replace(/""/g, '"');
  }
  return cell;
}

describe("csvCell", () => {
  it.each([
    ['=HYPERLINK("x")', '"\'=HYPERLINK(""x"")"'],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@a", "'@a"],
    ["\tx", "'\tx"],
    ["a,b", '"a,b"'],
    ['a"b', '"a""b"'],
    ["a\nb", '"a\nb"'],
  ])("escapes %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("prefixes a leading carriage return too", () => {
    expect(csvCell("\rx")).toBe('"\'\rx"');
  });

  it("returns an empty string for null and undefined", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("stringifies non-string values", () => {
    expect(csvCell(42)).toBe("42");
  });

  it("leaves a plain value untouched", () => {
    expect(csvCell("Glock 19")).toBe("Glock 19");
  });

  it("round-trips through a minimal RFC 4180 parser, after stripping the formula-guard prefix", () => {
    const inputs = ['=HYPERLINK("x")', "+1", "-1", "@a", "\tx", "\rx", "a,b", 'a"b', "a\nb", "plain", ""];
    for (const original of inputs) {
      const cell = csvCell(original);
      const parsed = parseOneCell(cell);
      const stripped = parsed.startsWith("'") ? parsed.slice(1) : parsed;
      expect(stripped).toBe(original);
    }
  });
});

describe("toCsv", () => {
  it("emits the header row and one data row, changes as compact JSON", () => {
    const events: AuditEventDto[] = [
      {
        id: "e1",
        at: "2026-03-05T00:00:00.000Z",
        actorId: "u1",
        actorName: "Alice A (@alice)",
        actorIp: "10.0.0.1",
        action: "UPDATE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: "Glock 19 (9mm)",
        changes: { name: ["a", "b"] },
      },
    ];
    expect(toCsv(events)).toBe(
      [
        "at,actor,ip,action,type,item,changes",
        '2026-03-05T00:00:00.000Z,Alice A (@alice),10.0.0.1,UPDATE,Firearm,Glock 19 (9mm),"{""name"":[""a"",""b""]}"',
      ].join("\n"),
    );
  });

  it("blanks null ip/type/item/changes", () => {
    const events: AuditEventDto[] = [
      {
        id: "e1",
        at: "2026-03-05T00:00:00.000Z",
        actorId: null,
        actorName: "system",
        actorIp: null,
        action: "CREATE",
        entityType: null,
        entityId: null,
        entityLabel: null,
        changes: null,
      },
    ];
    expect(toCsv(events)).toBe(["at,actor,ip,action,type,item,changes", "2026-03-05T00:00:00.000Z,system,,CREATE,,,"].join("\n"));
  });

  it("guards an item label containing =HYPERLINK(...) — Review Focus #4", () => {
    const events: AuditEventDto[] = [
      {
        id: "e1",
        at: "2026-03-05T00:00:00.000Z",
        actorId: null,
        actorName: "system",
        actorIp: null,
        action: "DELETE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: '=HYPERLINK("http://evil")',
        changes: null,
      },
    ];
    expect(toCsv(events)).toContain('"\'=HYPERLINK(""http://evil"")"');
  });

  it("emits only the header row for no events", () => {
    expect(toCsv([])).toBe("at,actor,ip,action,type,item,changes");
  });
});
