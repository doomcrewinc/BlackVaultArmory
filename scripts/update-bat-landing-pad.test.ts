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

/**
 * The second resume hazard: the update.bat shipped from e570bd8 (develop
 * before the public-URL release, and what users have today) runs `git pull`
 * as a TOP-LEVEL line, not inside an if ( ) block. The moment the pull
 * replaces update.bat, cmd.exe resumes the NEW file at the byte just past
 * that old `git pull` line: 7123 (LF checkout) or 7269 (CRLF checkout),
 * computed from `git show e570bd8:update.bat`.
 *
 * That is only safe if the new file has its own `git pull` line ending at
 * exactly the same byte, so the resume lands on the start of the line after
 * it: the `if errorlevel 1 (` pull-failure check, which then flows into the
 * public-URL prompts and the rebuild. Every byte added or removed between
 * the pad and `git pull` moves the landing mid-line (the first cut of this
 * release removed two lines, 58 bytes, and landed on "output above." inside
 * the pull-failure block: cmd ran it, then `pause` and `exit /b 1`).
 *
 * If this fails: restore the byte count between the landing pad and the
 * `git pull` line (the two-line byte pad above `git pull` in update.bat).
 * Change both lines' lengths together: two lines are needed so that the LF
 * and CRLF counts both come out right.
 */
const E570BD8_RESUME_OFFSETS = { LF: 7123, CRLF: 7269 } as const;

describe("update.bat resume from the e570bd8 update.bat (top-level git pull)", () => {
  const raw = readFileSync(UPDATE_BAT);
  const lf = Buffer.from(raw.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
  const crlf = Buffer.from(lf.toString("latin1").replace(/\n/g, "\r\n"), "latin1");

  const cases = [
    ["LF", lf, "\n", E570BD8_RESUME_OFFSETS.LF],
    ["CRLF", crlf, "\r\n", E570BD8_RESUME_OFFSETS.CRLF],
  ] as const;

  it.each(cases)("resumes %s at the start of the line right after `git pull`", (_n, buf, eol, resume) => {
    const sep = Buffer.from(eol, "latin1");
    const pullLine = Buffer.from(`git pull${eol}`, "latin1");
    // The bytes just before the resume point are a whole `git pull` line...
    expect(buf.subarray(resume - pullLine.length, resume).toString("latin1")).toBe(pullLine.toString("latin1"));
    expect(buf.subarray(resume - pullLine.length - sep.length, resume - pullLine.length).equals(sep)).toBe(true);
    // ...and what cmd.exe reads next is the pull-failure check, from its start.
    expect(restOfLine(buf, resume, eol).toString("latin1")).toBe("if errorlevel 1 (");
  });

  it("has exactly one top-level `git pull` line", () => {
    const lines = lf.toString("latin1").split("\n");
    expect(lines.filter((l) => l === "git pull")).toHaveLength(1);
  });
});
