import { describe, expect, it } from "vitest";
import { csvCell, csvQuote } from "./csv";

describe("csvQuote", () => {
  it.each([
    ["plain", "plain"],
    ["a,b", '"a,b"'],
    ['a"b', '"a""b"'],
    ["a\nb", '"a\nb"'],
    // A bare carriage return ends a row in a spreadsheet as a line feed does.
    ["a\rb", '"a\rb"'],
    ["-5", "-5"],
    ["=1+1", "=1+1"],
  ])("quotes %j only when RFC 4180 needs it, and adds no guard", (input, expected) => {
    expect(csvQuote(input)).toBe(expected);
  });
});

describe("csvCell", () => {
  it.each([
    ["=1+1", "'=1+1"],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tx", "'\tx"],
    ["\rx", '"\'\rx"'],
    ["a=b", "a=b"],
    ["", ""],
  ])("guards %j when it would open as a formula", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it("writes null and undefined as an empty cell and a number as its digits", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(42)).toBe("42");
  });
});
