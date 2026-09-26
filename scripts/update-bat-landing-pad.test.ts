import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * update.bat's landing pad, checked by machine instead of by hand.
 *
 * cmd.exe re-reads a running batch file by BYTE OFFSET after each command.
 * The update.bat shipped before PostgreSQL support runs `git pull` from inside
 * an `if ( )` block, so the moment the pull replaces update.bat on disk,
 * cmd.exe resumes reading the NEW file at the byte position it had reached in
 * the OLD one. Those positions are 2699 (LF checkout) and 2773 (CRLF
 * checkout).
 *
 * Landing mid-line inside a run of colons is harmless: cmd reads the remainder
 * of the line as a label (`::::` is a label named `:::`), which does nothing.
 * Landing anywhere else runs an arbitrary fragment of a line as a command.
 *
 * update.bat's own comment says "Keep both offsets inside the pad when editing
 * anything above it" — which until now was enforced by nobody. Adding a line
 * above the pad shifts every offset below it, so this test is the thing that
 * notices. It runs on every platform, because it is arithmetic on bytes, not
 * anything Windows-specific.
 *
 * EVERYTHING HERE IS IN BYTES, NOT CHARACTERS. update.bat contains box-drawing
 * characters (╔══╗) that are three UTF-8 bytes each but one JS string unit, so
 * a String.slice version of this test is off by ~40 and silently checks the
 * wrong place. cmd.exe seeks in bytes; so do we.
 *
 * If this fails: add or remove colon-only lines in the pad (NOT above it)
 * until both offsets are inside again, then update the numbers in update.bat's
 * comment if the pad itself moved on purpose.
 */

const RESUME_OFFSETS = { LF: 2699, CRLF: 2773 } as const;

const UPDATE_BAT = path.resolve(__dirname, "..", "update.bat");

const COLON = 0x3a;

/** Byte range [start, end) of the contiguous run of colon-only lines. */
function padRange(buf: Buffer, eol: "\n" | "\r\n"): { start: number; end: number } {
  const sep = Buffer.from(eol, "latin1");
  const lines: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const next = buf.indexOf(sep, cursor);
    if (next === -1) {
      lines.push(buf.subarray(cursor));
      break;
    }
    lines.push(buf.subarray(cursor, next));
    cursor = next + sep.length;
  }

  let offset = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const line of lines) {
    const isPad = line.length > 10 && line.every((b) => b === COLON);
    if (isPad && start === null) start = offset;
    if (!isPad && start !== null && end === null) end = offset;
    offset += line.length + sep.length;
  }
  if (start === null) throw new Error("update.bat has no colon-only landing pad at all");
  return { start, end: end ?? offset };
}

/** The bytes from `offset` to the end of the line it falls in. */
function restOfLine(buf: Buffer, offset: number, eol: "\n" | "\r\n"): Buffer {
  const sep = Buffer.from(eol, "latin1");
  const next = buf.indexOf(sep, offset);
  return next === -1 ? buf.subarray(offset) : buf.subarray(offset, next);
}

describe("update.bat landing pad", () => {
  const raw = readFileSync(UPDATE_BAT);
  // Normalise to each line ending, because the file on the USER's disk is
  // whatever their clone produced, not whatever is committed here.
  const lf = Buffer.from(raw.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  const crlf = Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");

  const cases = [
    ["LF", lf, "\n", RESUME_OFFSETS.LF],
    ["CRLF", crlf, "\r\n", RESUME_OFFSETS.CRLF],
  ] as const;

  it("has a pad long enough to absorb a drifting offset", () => {
    const { start, end } = padRange(lf, "\n");
    expect(end - start).toBeGreaterThan(200);
  });

  it.each(cases)("catches the %s resume offset inside the pad", (_n, buf, eol, resume) => {
    const { start, end } = padRange(buf, eol);
    expect(resume).toBeGreaterThanOrEqual(start);
    expect(resume).toBeLessThan(end);
  });

  it.each(cases)("resumes %s mid-line on colons, never on a command", (_n, buf, eol, resume) => {
    // The strongest form: what cmd.exe would actually read from that byte.
    const rest = restOfLine(buf, resume, eol);
    expect(rest.length).toBeGreaterThan(0);
    expect(rest.every((b) => b === COLON)).toBe(true);
  });

  it("keeps a margin, so a small edit above the pad does not immediately break it", () => {
    for (const [, buf, eol, resume] of cases) {
      const { start, end } = padRange(buf, eol);
      expect(resume - start).toBeGreaterThan(64);
      expect(end - resume).toBeGreaterThan(64);
    }
  });
});
