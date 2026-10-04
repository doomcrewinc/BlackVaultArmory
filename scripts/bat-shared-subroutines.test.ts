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
  rotate: readFileSync(path.join(ROOT, "rotate-key.bat")).toString("latin1"),
} as const;

const SUBROUTINES = [
  "valid_public_url",
  "prompt_yes_no",
  "prompt_trusted_proxies",
  "show_setup_token",
  // The field-encryption key (mirrors scripts/encryption-key.sh).
  "ensure_encryption_key",
  "health_status",
  // The .env reader (mirrors scripts/compose-provider.sh) and its callers.
  "env_value",
  "provider_from_env",
  "check_postgres_env",
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

/**
 * update.bat and rotate-key.bat both refuse to go on while a restore marker
 * is in the uploads folder, and print the command that removes it. The
 * lookup is one subroutine pair, copied.
 */
describe("update.bat and rotate-key.bat share the restore-marker lookup byte for byte", () => {
  it.each(["restore_markers", "restore_marker_add"])(":%s is identical in both files", (label) => {
    const inUpdate = extract("update", label);
    expect(inUpdate.length).toBeGreaterThan(100);
    expect(extract("rotate", label), `:${label} differs between update.bat and rotate-key.bat`).toBe(inUpdate);
  });

  it("the stamp reaches :restore_marker_add in a variable, never as a `call` argument, and an empty one is skipped", () => {
    const lines = linesOf(FILES.update).map(bare);
    expect(lines.filter((l) => l.includes("call :restore_marker_add"))).toEqual([
      'for /d %%M in ("!BV_UP!\\.restore-*.db-started") do (set "BV_ONE=%%~nxM"& call :restore_marker_add)',
      'for %%M in ("!BV_UP!\\.restore-*.db-started") do (set "BV_ONE=%%~nxM"& call :restore_marker_add)',
    ]);
    const at = lines.indexOf(":restore_marker_add");
    expect(lines.slice(at + 2, at + 4)).toEqual(['set "BV_ONE=!BV_ONE:~9,-11!"', "if not defined BV_ONE goto :eof"]);
  });

  it("update.bat looks for a marker AFTER the `git pull` line (where an older update.bat resumes) and BEFORE the first prompt and the rebuild", () => {
    const lines = linesOf(FILES.update).map(bare);
    const at = lines.indexOf("call :restore_markers");
    expect(lines[at + 1]).toBe("if defined BV_MARKERS goto :restore_marker_left");
    expect(at).toBeGreaterThan(lines.indexOf("git pull"));
    expect(at).toBeLessThan(lines.indexOf("call :read_env"));
    expect(at).toBeLessThan(lines.indexOf("%COMPOSE% build --pull"));
    const stop = lines.indexOf(":restore_marker_left");
    expect(lines.slice(stop + 8, stop + 11)).toEqual([
      "echo        Then run update.bat again. Nothing was rebuilt or restarted.",
      "pause",
      "exit /b 1",
    ]);
  });

  it("rotate-key.bat looks for a marker before it stops BlackVault", () => {
    const lines = linesOf(FILES.rotate).map(bare);
    const at = lines.indexOf("call :restore_markers");
    expect(lines[at + 1]).toBe("if defined BV_MARKERS goto :restore_marker_left");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(lines.indexOf("%COMPOSE% stop blackvault"));
    const stop = lines.indexOf(":restore_marker_left");
    expect(lines.slice(stop + 8, stop + 11)).toEqual([
      "echo        Then run rotate-key.bat again. Nothing was changed; BlackVault was not stopped.",
      "pause",
      "exit /b 1",
    ]);
  });
});

/**
 * An unhealthy container ends install.bat and update.bat with exit code 1; a
 * container still starting when the wait ran out, like a healthy one, with 0.
 */
describe("exit code 1 only for an unhealthy container", () => {
  it.each([
    ["install", "call :show_setup_token PUBLIC_URL"],
    ["update", "call :show_setup_token ENV_PUBLIC_URL"],
  ] as const)("%s.bat", (fileName, lastStep) => {
    const lines = linesOf(FILES[fileName]).map(bare).filter((l) => !l.startsWith("::"));
    const at = lines.indexOf(lastStep);
    expect(lines.slice(at, at + 4)).toEqual([lastStep, "pause", 'if "!HEALTH!"=="unhealthy" exit /b 1', "exit /b 0"]);
  });
});

/**
 * `for /f "delims=<allowed characters>" %%X in ("!VAR!") do <reject>` is how
 * these scripts check that a value holds only allowed characters. for /f
 * skips a line whose first character (after leading delimiters) is its eol
 * character, ";" unless the options name another, so ";3000" or "30;00"-style
 * values would pass unexamined. Every such check must either name its own eol
 * or come right after a line refusing ";" anywhere in the same variable.
 * Values the script generated itself (hex from the CSPRNG) or read from
 * `docker compose version` are exempt: nobody types them.
 *
 * For the port of the typed public URL this test is the ONLY proof of the
 * guard: the host-and-port check above it in :valid_public_url already
 * refuses a ";", so no run of the script can tell the guard from its absence
 * (the Windows harness scenarios PS1/PS2 pass either way).
 */
describe("static proof: a for /f character check on a typed or .env value comes right after a line refusing ;", () => {
  const GENERATED = new Set(["POSTGRES_PASSWORD", "_KEY", "_CMAJ!!_CMIN"]);
  const CHECK = /(?:^|\s)for \/f "delims=[^"]+" %%X in \("!(.+)!"\) do /;
  // The line that must sit directly above the check, per variable.
  const GUARD: Record<string, string> = {
    VPU_PORT: 'if not "!VPU_PORT:;=!"=="!VPU_PORT!" exit /b 1',
    _EV: 'if defined _EV if not "!_EV:;=!"=="!_EV!" set "_EK_ENV=malformed"',
  };

  it.each(["install", "update"] as const)("%s.bat", (fileName) => {
    const lines = linesOf(FILES[fileName]).map(bare);
    const checks = lines.map((l, i) => ({ m: CHECK.exec(l), i })).filter((c) => c.m !== null);
    const guarded: string[] = [];
    for (const { m, i } of checks) {
      const name = m![1];
      if (GENERATED.has(name)) continue;
      expect(GUARD[name], `${fileName}.bat line ${i + 1}: no guard is known for !${name}!`).toBeDefined();
      expect(lines[i - 1], `${fileName}.bat line ${i + 1}: !${name}! is checked without refusing ";" first`).toBe(GUARD[name]);
      guarded.push(name);
    }
    // The port of the typed public URL, and the encryption key read from .env.
    expect(guarded.sort()).toEqual(["VPU_PORT", "_EV"]);
  });
});

/**
 * The health wait reads the Status column of `docker compose ps`, e.g.
 * "Up 2 minutes (unhealthy)". Matching the bare word healthy takes that for
 * success; the parentheses must be part of the match.
 */
describe("the health wait matches the status word with its parentheses", () => {
  it.each(["install", "update"] as const)("%s.bat", (fileName) => {
    const lines = linesOf(FILES[fileName]).map(bare).filter((l) => !l.startsWith("::"));
    const mentions = lines.filter((l) => /healthy/i.test(l) && !/^\s*(echo|set "STATUS=)/.test(l) && !/^if (not )?"!HEALTH!"==/.test(l));
    expect(mentions).toEqual([
      'if not "!_HS:(healthy)=!"=="!_HS!" set "HEALTH=healthy"',
      'if not "!_HS:(unhealthy)=!"=="!_HS!" set "HEALTH=unhealthy"',
    ]);
    expect(lines.filter((l) => /findstr[^|]*healthy/i.test(l))).toEqual([]);
  });
});

/**
 * One .env reader for every batch script. :env_value reads a line the way
 * Docker Compose does and refuses the forms it cannot (see the comment above
 * it in install.bat). A second, simpler reader elsewhere is how
 * `DATA_DIR=C:\x # note` came to be read with its comment and
 * `DATA_DIR='C:\x'` with its quotes, and the wrong folder then fed the
 * relocation of DATA_DIR in update.bat.
 */
describe("all six batch scripts that read .env do it through the one shared :env_value", () => {
  const BAT = {
    "install.bat": FILES.install,
    "update.bat": FILES.update,
    "backup.bat": readFileSync(path.join(ROOT, "backup.bat")).toString("latin1"),
    "restore.bat": readFileSync(path.join(ROOT, "restore.bat")).toString("latin1"),
    "rotate-key.bat": readFileSync(path.join(ROOT, "rotate-key.bat")).toString("latin1"),
    "scripts/db-snapshot.bat": readFileSync(path.join(ROOT, "scripts", "db-snapshot.bat")).toString("latin1"),
  } as const;
  const BOM = "\u00ef\u00bb\u00bf"; // the three UTF-8 bytes, as latin1

  /** The :env_value block of a file: its comment lines through the line before the next blank line. */
  function envValueBlock(text: string): string[] {
    const lines = linesOf(text);
    const at = lines.findIndex((l) => bare(l) === ":env_value");
    if (at === -1) throw new Error("no :env_value");
    let start = at;
    while (start > 0 && bare(lines[start - 1]).startsWith("::")) start--;
    let end = at;
    while (end + 1 < lines.length && bare(lines[end + 1]).trim() !== "") end++;
    expect(bare(lines[end])).toBe("goto :eof");
    return lines.slice(start, end + 1);
  }

  it.each(Object.keys(BAT) as (keyof typeof BAT)[])("%s: no other line reads .env with for /f or findstr", (name) => {
    const lines = linesOf(BAT[name]).map(bare);
    const block = new Set(envValueBlock(BAT[name]).map(bare));
    const readers = lines.filter((l) => !l.startsWith("::") && (/for \/f [^(]*\("\.env"\)/.test(l) || /findstr .*"\.env"/.test(l)));
    expect(readers.length).toBeGreaterThan(0);
    for (const l of readers) expect(block.has(l), `${name} reads .env outside :env_value: ${l}`).toBe(true);
  });

  it("update.bat reads DATA_DIR with :env_value BEFORE `git pull`, and stops there when the line is refused", () => {
    const lines = linesOf(FILES.update).map(bare);
    const pull = lines.indexOf("git pull");
    const at = lines.indexOf("call :env_value DATA_DIR");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(pull);
    expect(lines.slice(at, at + 3)).toEqual([
      "call :env_value DATA_DIR",
      'set "ACTIVE_DATA_DIR=!_EV!"',
      "if defined _EV_BAD goto :data_dir_unreadable",
    ]);
    // The stop itself: an error, then exit 1, with no way back into the run.
    const stop = lines.indexOf(":data_dir_unreadable");
    expect(stop).toBeGreaterThan(pull);
    expect(lines.slice(stop + 1, stop + 6)).toEqual([
      "echo ERROR: .env holds a DATA_DIR line this script does not read: see the Note",
      "echo        above. Correct it and run update.bat again.",
      "echo        Nothing was rebuilt or restarted.",
      "pause",
      "exit /b 1",
    ]);
    // Nothing between there and the check re-assigns it.
    const check = lines.indexOf("if not defined ACTIVE_DATA_DIR goto :preflight_done");
    expect(check).toBeGreaterThan(at);
    expect(lines.slice(at + 2, check).filter((l) => l.includes('set "ACTIVE_DATA_DIR='))).toEqual([]);
  });

  it("the reader is the same in all six files, byte for byte, byte-order-mark lines included", () => {
    const install = envValueBlock(BAT["install.bat"]);
    // The two lines that find a key behind a UTF-8 byte-order mark on line 1.
    expect(install.filter((l) => l.includes(BOM))).toHaveLength(2);
    expect(Object.keys(BAT)).toHaveLength(6);
    for (const name of Object.keys(BAT) as (keyof typeof BAT)[]) {
      expect(envValueBlock(BAT[name]).join(""), `${name} :env_value differs`).toBe(install.join(""));
    }
  });

  it("rotate-key.bat decides whether .env holds a key with :env_value: a value, or a line it cannot read, both refuse", () => {
    const lines = linesOf(BAT["rotate-key.bat"]).map(bare);
    const at = lines.indexOf("call :env_value BLACKVAULT_ENCRYPTION_KEY");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith("%COMPOSE% stop")));
    const until = lines.indexOf(":no_env_key");
    expect(lines.slice(at + 1, until)).toEqual([
      ":env_key_trim",
      "if not defined _EV goto :env_key_trimmed",
      'if "!_EV:~0,1!"==" " set "_EV=!_EV:~1!" & goto :env_key_trim',
      'if "!_EV:~0,1!"=="\t" set "_EV=!_EV:~1!" & goto :env_key_trim',
      'if "!_EV:~-1!"==" " set "_EV=!_EV:~0,-1!" & goto :env_key_trim',
      'if "!_EV:~-1!"=="\t" set "_EV=!_EV:~0,-1!" & goto :env_key_trim',
      ":env_key_trimmed",
      'if defined _EV set "ENV_KEY_SOURCE=.env"',
      'set "_EV="',
      'if defined _EV_BAD set "ENV_KEY_SOURCE=.env"',
      "if defined ENV_KEY_SOURCE goto :env_key_in_use",
    ]);
  });

  it("refuses a ! on a line assigning the key (searched with delayed expansion off) and a leading ~ in a folder key", () => {
    for (const name of Object.keys(BAT) as (keyof typeof BAT)[]) {
      const block = envValueBlock(BAT[name]).map(bare);
      const at = block.indexOf("setlocal DisableDelayedExpansion");
      expect(at, name).toBeGreaterThan(block.indexOf(":env_value"));
      expect(block.slice(at, at + 4), name).toEqual([
        "setlocal DisableDelayedExpansion",
        'findstr /r /c:"^[ \t]*%~1[ \t]*=.*!" /c:"^[ \t]*export[ \t][ \t]*%~1[ \t]*=.*!" ".env" >nul 2>&1',
        'if not errorlevel 1 (endlocal & set "_EV_SET=1" & goto :env_value_bad)',
        "endlocal",
      ]);
      // Before any line that uses the value the loop stored.
      expect(at, name).toBeLessThan(block.indexOf(":env_value_trim"));
      const done = block.indexOf(":env_value_done");
      expect(block.slice(done + 1, done + 3), name).toEqual([
        'set "_EVK=%~1"',
        'if defined _EV if "!_EVK:~-4!"=="_DIR" if "!_EV:~0,1!"=="~" goto :env_value_bad',
      ]);
    }
  });

  it("refuses a $ in an unquoted or double-quoted value, and inside double quotes only the backslashes Compose unescapes", () => {
    const block = envValueBlock(BAT["install.bat"]).map(bare);
    expect(block.filter((l) => l === 'if not "!_EV:$=!"=="!_EV!" goto :env_value_bad')).toHaveLength(2);
    const dq = block.slice(block.indexOf(":env_value_dquote"), block.indexOf(":env_value_squote"));
    // No blanket refusal of a backslash: a value without one is done, the
    // others are checked pair by pair, with case (IF without /i).
    expect(dq).not.toContain('if not "!_EV:\\=!"=="!_EV!" goto :env_value_bad');
    expect(dq).toContain('if "!_EV:\\=!"=="!_EV!" goto :env_value_done');
    expect(dq).toContain('for %%E in (a b f n r t v 0) do if "!_EVC!"=="\\%%E" goto :env_value_bad');
    expect(dq).toContain('if "!_EVC!"=="\\\\" goto :env_value_bad');
    expect(dq).toContain('if "!_EVC!"=="\\" goto :env_value_bad');
    expect(dq.filter((l) => /^if \/i /.test(l))).toEqual([]);
    // Single quotes: literal, except an apostrophe inside or a backslash before the closing quote.
    const sq = block.slice(block.indexOf(":env_value_squote"), block.indexOf(":env_value_bad"));
    expect(sq).toContain(`if not "!_EV:'=!"=="!_EV!" goto :env_value_bad`);
    expect(sq).toContain('if "!_EV:~-1!"=="\\" goto :env_value_bad');
    expect(sq.filter((l) => l.includes("$"))).toEqual([]);
  });
});
