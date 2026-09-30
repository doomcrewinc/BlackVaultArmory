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

const BOM = "﻿";

/** A minimal RFC 4180 parser for the round-trip test: BOM-strip, then split rows on CRLF and cells on top-level commas. */
function parseCsv(csv: string): string[][] {
  const body = csv.startsWith(BOM) ? csv.slice(BOM.length) : csv;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inQuotes) {
      if (c === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && body[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else {
      cell += c;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

describe("toCsv", () => {
  it("starts with a UTF-8 BOM", () => {
    expect(toCsv([])).toMatch(/^﻿/);
  });

  it("separates rows with CRLF", () => {
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
        changes: null,
      },
      {
        id: "e2",
        at: "2026-03-06T00:00:00.000Z",
        actorId: "u1",
        actorName: "Alice A (@alice)",
        actorIp: "10.0.0.1",
        action: "UPDATE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: "Glock 19 (9mm)",
        changes: null,
      },
    ];
    const csv = toCsv(events);
    expect(csv).toContain("\r\n");
    // No lone \n: every line break is part of a \r\n pair.
    expect(csv.replace(/\r\n/g, "")).not.toContain("\n");
  });

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
      BOM +
        [
          "at,actor,ip,action,type,item,changes",
          '2026-03-05T00:00:00.000Z,Alice A (@alice),10.0.0.1,UPDATE,Firearm,Glock 19 (9mm),"{""name"":[""a"",""b""]}"',
        ].join("\r\n"),
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
    expect(toCsv(events)).toBe(
      BOM + ["at,actor,ip,action,type,item,changes", "2026-03-05T00:00:00.000Z,system,,CREATE,,,"].join("\r\n"),
    );
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
    expect(toCsv([])).toBe(BOM + "at,actor,ip,action,type,item,changes");
  });

  it("round-trips a row with a comma, a quote and an embedded formula guard through a minimal RFC 4180 + BOM/CRLF parser", () => {
    const events: AuditEventDto[] = [
      {
        id: "e1",
        at: "2026-03-05T00:00:00.000Z",
        actorId: "u1",
        actorName: 'O"Brien, Al',
        actorIp: "10.0.0.1",
        action: "DELETE",
        entityType: "Firearm",
        entityId: "f1",
        entityLabel: '=HYPERLINK("http://evil")',
        changes: { note: "line1\nline2" },
      },
    ];
    const rows = parseCsv(toCsv(events));
    expect(rows[0]).toEqual(["at", "actor", "ip", "action", "type", "item", "changes"]);
    expect(rows[1][1]).toBe('O"Brien, Al');
    // The parser only strips RFC 4180 quoting, not the formula-guard prefix
    // — that assertion belongs to csvCell's own exact-string tests above.
    expect(rows[1][5]).toBe('\'=HYPERLINK("http://evil")');
    expect(JSON.parse(rows[1][6])).toEqual({ note: "line1\nline2" });
  });
});
