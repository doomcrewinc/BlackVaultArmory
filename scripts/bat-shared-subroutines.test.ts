import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * install.bat and update.bat each carry their own copy of the public-URL
 * subroutines, because batch cannot include code from another file. The
 * comments beside them say "change them together". This test makes sure
 * someone actually did.
 *
 * Like update-bat-landing-pad.test.ts, it works on the raw file bytes and
 * needs no Windows. Each subroutine is extracted as a block: the contiguous
 * `::` comment lines directly above its `:label`, then every line through
 * the last one before the next blank line. extract() also requires that
 * last line to be an unconditional exit (`exit /b N`, `goto :eof`, or a goto
 * back into the routine's own retry loop). Without that check, a blank line
 * added inside a subroutine would cut the block short, and the test would
 * go on passing while comparing only a fragment.
 *
 * The URL prompt loop is inline code, not a subroutine. It uses different
 * labels in each file (ask_public_url vs upd_ask_public_url, and a
 * different "valid" target), so those two labels are replaced with
 * placeholders before comparing. All other bytes must match exactly.
 */

const ROOT = path.resolve(__dirname, "..");
const FILES = {
  install: readFileSync(path.join(ROOT, "install.bat")).toString("latin1"),
  update: readFileSync(path.join(ROOT, "update.bat")).toString("latin1"),
} as const;

const SUBROUTINES = [
  "valid_public_url",
  "prompt_yes_no",
  "prompt_trusted_proxies",
  "show_setup_token",
  // Task 7: the field-encryption key (mirrors scripts/encryption-key.sh).
  "ensure_encryption_key",
] as const;

const TERMINATOR = /^(exit \/b \d+|goto :eof|goto :[A-Za-z_]+_again)$/i;

/** Lines of the file, each WITH its own line ending, so the comparison is byte-exact. */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

const bare = (line: string) => line.replace(/\r?\n$/, "");

function extract(fileName: keyof typeof FILES, label: string): string {
  const lines = linesOf(FILES[fileName]);
  const at = lines.findIndex((l) => bare(l) === `:${label}`);
  if (at === -1) throw new Error(`${fileName}.bat has no :${label}`);
  if (lines.findIndex((l, i) => i > at && bare(l) === `:${label}`) !== -1) {
    throw new Error(`${fileName}.bat defines :${label} twice`);
  }
  let start = at;
  while (start > 0 && bare(lines[start - 1]).startsWith("::")) start--;
  let end = at;
  while (end + 1 < lines.length && bare(lines[end + 1]).trim() !== "") end++;
  const last = bare(lines[end]);
  if (!TERMINATOR.test(last)) {
    throw new Error(
      `${fileName}.bat :${label} block ends on "${last}", not an unconditional exit - ` +
        "a blank line inside the subroutine would make this test compare only part of it",
    );
  }
  return lines.slice(start, end + 1).join("");
}

/** The inline URL prompt loop, with its two per-file labels replaced by placeholders. */
function extractUrlLoop(fileName: keyof typeof FILES, loopLabel: string, doneLabel: string): string {
  const lines = linesOf(FILES[fileName]);
  const starts = lines
    .map((l, i) => (bare(l).startsWith("echo Public URL: the address people open") ? i : -1))
    .filter((i) => i !== -1);
  if (starts.length !== 1) throw new Error(`${fileName}.bat: expected one URL prompt intro, found ${starts.length}`);
  const start = starts[0];
  const end = lines.findIndex((l, i) => i > start && bare(l) === `goto :${loopLabel}`);
  if (end === -1) throw new Error(`${fileName}.bat: URL prompt loop never jumps back to :${loopLabel}`);
  const block = lines.slice(start, end + 1).join("");
  // Both labels must be what we think they are, or the substitution below
  // could hide a real difference.
  const bareLines = lines.slice(start, end + 1).map(bare);
  expect(bareLines).toContain(`:${loopLabel}`);
  expect(bareLines).toContain(`if not errorlevel 1 goto :${doneLabel}`);
  return block.split(`:${loopLabel}`).join(":<LOOP>").split(`:${doneLabel}`).join(":<DONE>");
}

describe("install.bat and update.bat share their public-URL subroutines byte for byte", () => {
  it.each(SUBROUTINES)(":%s is identical in both files", (label) => {
    const inInstall = extract("install", label);
    const inUpdate = extract("update", label);
    expect(inInstall.length).toBeGreaterThan(100);
    // A bare expect(a).toBe(b) failure would not say which subroutine drifted.
    expect(inUpdate, `:${label} differs between install.bat and update.bat`).toBe(inInstall);
  });

  it("the public URL prompt loop is identical apart from its two labels", () => {
    const inInstall = extractUrlLoop("install", "ask_public_url", "ask_trusted_proxies");
    const inUpdate = extractUrlLoop("update", "upd_ask_public_url", "upd_public_url_write");
    expect(inInstall).toContain("goto :public_url_missing");
    expect(inUpdate, "the public URL prompt loop differs between install.bat and update.bat").toBe(inInstall);
  });
});
