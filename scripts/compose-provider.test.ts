/**
 * Tests for scripts/compose-provider.sh (sourced by install.sh and
 * update.sh): the .env reader, and the Docker Compose version floor
 * (docker-compose.yml needs Compose 2.20+ for depends_on.required: false).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "compose-provider.sh");

function bash(script: string, env: NodeJS.ProcessEnv = process.env, args: string[] = []) {
  const r = spawnSync("bash", ["-c", `. "${LIB}"; ${script}`, "bash", ...args], { encoding: "utf8", env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function versionOk(v: string): boolean {
  return bash('compose_version_ok "$1"', process.env, [v]).code === 0;
}

describe("env_value reads .env the way Docker Compose does", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-envvalue-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `script` in a folder whose .env holds `content` (null: no .env). */
  function inDir(content: string | null, script: string) {
    if (content !== null) fs.writeFileSync(path.join(dir, ".env"), content);
    const r = spawnSync("bash", ["-c", `set -eu; . "${LIB}"; ${script}`], { encoding: "utf8", cwd: dir });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  // Prints [value], followed by UNREADABLE when env_unreadable says so.
  const value = (content: string | null) =>
    inDir(content, 'printf "[%s]" "$(env_value K)"; if env_unreadable K; then printf UNREADABLE; fi');

  /**
   * The expected column is what Docker Compose's own parser returns for the
   * line: every row was run through github.com/compose-spec/compose-go/v2
   * `dotenv.ParseWithLookup` (v2.16.1). Where Compose changes the value in a
   * way this reader does not implement (it substitutes $VAR, unescapes \x
   * inside double quotes, reads KEY: value and multi-line quotes), the row
   * expects UNREADABLE: the reader must never hand back a non-empty value
   * that is not the one Compose will use.
   */
  const UNREADABLE = Symbol("unreadable");

  it.each([
    ["plain", "K=v\n", "v"],
    ["no final newline", "K=v", "v"],
    ["export", "export K=v\n", "v"],
    ["export, several spaces and a tab", "export  \tK=v\n", "v"],
    ["leading whitespace", "  \tK=v\n", "v"],
    ["spaces around =", "K = v\n", "v"],
    ["tabs around =", "K\t=\tv\n", "v"],
    ["export with spaces around =", "export K = v\n", "v"],
    ["double quotes", 'K="a b"\n', "a b"],
    ["single quotes", "K='a b'\n", "a b"],
    ["only one layer of quotes is removed", `K="'a'"\n`, "'a'"],
    ["comment after a double-quoted value", 'K="a b" # note\n', "a b"],
    ["comment after a single-quoted value", "K='a b'\t# note\n", "a b"],
    ["a # inside quotes is part of the value", "K='a # b'\n", "a # b"],
    ["inline comment after an unquoted value", "K=v # note\n", "v"],
    ["two spaces before the comment", "K=a  # b\n", "a"],
    ["a tab before a # does not start a comment", "K=v\t# note\n", "v\t# note"],
    ["a # with no whitespace before it is part of the value", "K=a#b\n", "a#b"],
    ["a # right after the = and its whitespace is the value", "K= # note\n", "# note"],
    ["a # as the first character", "K=#abc\n", "#abc"],
    ["a trailing tab is trimmed", "K=v\t\n", "v"],
    ["inner spaces are kept", "K=/srv/my vault/data\n", "/srv/my vault/data"],
    ["CRLF", "K=v\r\n", "v"],
    ["CRLF and quotes", 'K="v"\r\nOTHER=x\r\n', "v"],
    ["CRLF and an inline comment", "K=v # note\r\n", "v"],
    ["a commented-out duplicate above the real line", "#K=old\nK=new\n", "new"],
    ["a commented-out duplicate with a space, above", "# K=old\nK=new\n", "new"],
    ["an indented commented-out duplicate, above", "  #K=old\nK=new\n", "new"],
    ["a commented-out duplicate below the real line", "K=new\n#K=old\n", "new"],
    ["the last assignment wins", "K=first\nK=second\n", "second"],
    ["the last assignment wins: plain then export", "K=first\nexport K=second\n", "second"],
    ["the last assignment wins: export then plain", "export K=first\nK=second\n", "second"],
    ["a later empty assignment wins", "K=first\nK=\n", ""],
    ["a value containing =", "K=a=b\n", "a=b"],
    ["a value starting with =", "K==b\n", "=b"],
    ["a URL with a query", "K=postgresql://u:p@db:5432/x?a=b&c=d\n", "postgresql://u:p@db:5432/x?a=b&c=d"],
    ["empty", "K=\n", ""],
    ["empty quotes", 'K=""\n', ""],
    ["text after the closing quote is dropped", `K='a'b\nX="a"b\n`, "a"],
    ["a double quote inside an unquoted value", 'K=a"b"c\n', 'a"b"c'],
    ["an apostrophe inside an unquoted value", "K=O'Brien\n", "O'Brien"],
    ["a double quote inside single quotes", `K='a"b'\n`, 'a"b'],
    ["an unquoted Windows path", "K=C:\\Users\\rob\\new data\n", "C:\\Users\\rob\\new data"],
    ["a single-quoted Windows path", "K='C:\\Users\\rob\\new data'\n", "C:\\Users\\rob\\new data"],
    ["a $ inside single quotes is literal", "K='a$HOME b'\n", "a$HOME b"],
    ["a $ only in the comment", "K=v # costs $5\n", "v"],
    ["a UTF-8 BOM before the first line", "\uFEFFK=v\n", "v"],
    ["KEY: value, then KEY=value", "K: v\nK=w\n", "w"],
    ["an unreadable line, then a readable one", "K=$HOME/x\nK=v\n", "v"],
    // Compose would give another value than the text: unreadable.
    ["$VAR in an unquoted value", "K=$HOME/x\n", UNREADABLE],
    ["${VAR} in an unquoted value", "export K = ${HOME}/x\n", UNREADABLE],
    ["${VAR} in a double-quoted value", 'K="${HOME}/x"\n', UNREADABLE],
    ["$$ in an unquoted value", "K=pa$$w\n", UNREADABLE],
    // Inside double quotes Compose unescapes a backslash before a b f n r t v
    // 0 \ " and $ only (probed letter by letter); any other backslash is text.
    ["a double-quoted Windows path with no escape letter", 'K="C:\\BlackVault\\Data"\n', "C:\\BlackVault\\Data"],
    ["a double-quoted path, upper-case after the backslashes", 'K="C:\\Users\\Rob Smith\\BlackVault"\n', "C:\\Users\\Rob Smith\\BlackVault"],
    ["\\c, \\' and \\( inside double quotes are text", `K="x\\cy\\'z\\(w"\n`, "x\\cy\\'z\\(w"],
    ["a double-quoted Windows path with \\r in it", 'K="C:\\Users\\rob\\x"\n', UNREADABLE],
    ["a double-quoted Windows path with \\t and \\v in it", 'K="D:\\temp\\v"\n', UNREADABLE],
    ["a double-quoted Windows path with \\n in it", 'K="C:\\new"\n', UNREADABLE],
    ["\\a, \\b, \\f, \\0 inside double quotes", 'K="x\\ay"\nK="x\\by"\nK="x\\fy"\nK="x\\0y"\n', UNREADABLE],
    ["a doubled backslash inside double quotes", 'K="a\\\\b"\n', UNREADABLE],
    ["an escaped quote inside double quotes", 'K="a\\"b"\n', UNREADABLE],
    ["a double-quoted path ending in a backslash (it escapes the quote)", 'K="C:\\BV\\"\n', UNREADABLE],
    // Single quotes: Compose turns \' into ' and refuses the file for an
    // apostrophe or a backslash before the closing quote.
    ["an escaped apostrophe inside single quotes", "K='a\\'b'\n", UNREADABLE],
    ["an apostrophe inside single quotes", "K='D:\\Rob's Vault'\n", UNREADABLE],
    ["a single-quoted path ending in a backslash", "K='C:\\BV\\'\n", UNREADABLE],
    ["a doubled apostrophe inside single quotes", "K='it''s'\n", UNREADABLE],
    ["KEY: value", "K: v\n", UNREADABLE],
    ["export KEY: value", "export K: v\n", UNREADABLE],
    ["KEY=value, then KEY: value (the last assignment wins, and it is the unreadable one)", "K=w\nK: v\n", UNREADABLE],
    ["a double quote that is not closed on the line", 'K="abc\nX=1\n', UNREADABLE],
    ["a single quote that is not closed on the line", "K='abc\nX=1\n", UNREADABLE],
    ["a longer key with the same suffix", "XK=v\n", ""],
    ["a longer key with the same prefix", "K2=v\nKK=w\n", ""],
    ["export glued to the key is another key", "exportK=v\n", ""],
    ["export without an assignment", "export K\n", ""],
    ["the key only inside another value", "OTHER=K=v\n", ""],
    ["no .env at all", null, ""],
  ] as [string, string | null, string | typeof UNREADABLE][])("%s", (_name, content, expected) => {
    const r = value(content);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(expected === UNREADABLE ? "[]UNREADABLE" : `[${expected}]`);
  });

  it("never evaluates the file: backticks and $( ) are text, and nothing runs", () => {
    const quoted = value("K='$HOME `touch pwned-1` $(touch pwned-2) ${PATH}'\nexport X=$(touch pwned-3)\n");
    expect(quoted.err).toBe("");
    expect(quoted.out).toBe("[$HOME `touch pwned-1` $(touch pwned-2) ${PATH}]");
    const backticks = value("K=`touch pwned-4`\n");
    expect(backticks.out).toBe("[`touch pwned-4`]");
    const unquoted = value("K=$(touch pwned-5) `touch pwned-6`\n");
    expect(unquoted.err).toBe("");
    expect(unquoted.out).toBe("[]UNREADABLE");
    expect(fs.readdirSync(dir).sort()).toEqual([".env"]);
  });

  it("a glob in the key or the value is not expanded", () => {
    fs.writeFileSync(path.join(dir, "Kfile"), "");
    expect(value("K=*\n").out).toBe("[*]");
    expect(inDir("KX=v\n", 'printf "[%s]" "$(env_value "K*")"').out).toBe("[]");
  });

  it.each([
    ["an empty assignment", "K=\n", 0],
    ["an empty export", "export K=\n", 0],
    ["spaces around =", "  K = \n", 0],
    ["KEY: value", "K: v\n", 0],
    ["an unreadable value", "K=$HOME\n", 0],
    ["only commented out", "#K=v\n", 1],
    ["another key", "KK=v\n", 1],
    ["no .env at all", null, 1],
  ])("env_has_key: %s", (_name, content, code) => {
    const r = inDir(content, "if env_has_key K; then exit 0; else exit 1; fi");
    expect(r.err).toBe("");
    expect(r.code).toBe(code);
  });

  it("provider_from_env and check_postgres_env read the same forms", () => {
    const env = [
      "export COMPOSE_PROFILES='postgres'",
      'export BLACKVAULT_DB_PROVIDER = "PostgreSQL" # the database',
      "export BLACKVAULT_POSTGRES_PASSWORD=abc",
      "export BLACKVAULT_DATABASE_URL=\"postgresql://blackvault:abc@db:5432/blackvault\"",
      "",
    ].join("\r\n");
    const r = inDir(env, 'provider_from_env; check_postgres_env && echo "COMPLETE"');
    expect(r.err).toBe("");
    expect(r.out).toBe("postgres\nCOMPLETE\n");
  });

  it("provider_from_env says unreadable, not sqlite, for a provider line it cannot read", () => {
    expect(inDir("BLACKVAULT_DB_PROVIDER=$DB\n", "provider_from_env").out).toBe("unreadable\n");
    expect(inDir('BLACKVAULT_DB_PROVIDER: "postgres"\n', "provider_from_env").out).toBe("unreadable\n");
  });

  it("check_postgres_env does not call a key missing when its line is only unreadable", () => {
    const env = [
      "COMPOSE_PROFILES=postgres",
      "BLACKVAULT_DB_PROVIDER=postgres",
      "BLACKVAULT_POSTGRES_PASSWORD=pa$$word",
      'BLACKVAULT_DATABASE_URL="postgresql://blackvault:${BLACKVAULT_POSTGRES_PASSWORD}@db:5432/blackvault"',
      "",
    ].join("\n");
    const r = inDir(env, 'check_postgres_env && echo "COMPLETE"');
    expect(r.err).toBe("");
    expect(r.out).toContain("COMPLETE");
    expect(r.out).not.toContain("is missing");
    expect(r.out).toContain("BLACKVAULT_POSTGRES_PASSWORD");
    expect(r.out).toContain("BLACKVAULT_DATABASE_URL");
    expect(r.out).toContain("cannot be checked");
    expect(r.out).not.toContain("pa$");
  });

  it("env_unreadable_text names the key and the two ways to write a line that is read", () => {
    const r = inDir("K=$X\n", "env_unreadable_text K");
    expect(r.out).toContain("K in .env could not be read");
    expect(r.out).toContain("Write it as K=value");
    expect(r.out).toContain("single quotes");
    expect(r.out).toContain("double quotes");
    expect(r.out.endsWith("\n")).toBe(false);
  });
});

describe("compose_version_ok", () => {
  it.each([
    ["2.20.0", true],
    ["2.29.7", true],
    ["5.1.2", true],
    ["v2.20.0", true],
    ["2.20.0-desktop.1", true],
    ["10.0.0", true],
    ["2.19.1", false],
    ["v2.19.99", false],
    ["1.29.2", false],
    ["docker-compose version 1.29.2, build 5becea4c", false],
    ["", false],
    ["2", false],
    ["garbage", false],
  ])("%s -> %s", (version, ok) => {
    expect(versionOk(version)).toBe(ok);
  });
});

describe("require_compose", () => {
  let bin: string;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "bv-compose-"));
  });
  afterEach(() => {
    fs.rmSync(bin, { recursive: true, force: true });
  });

  /** Fake `docker` (and optionally a v1 `docker-compose`) first on PATH. */
  function stub(opts: { plugin?: string; v1?: string }) {
    const plugin = opts.plugin
      ? `echo "${opts.plugin}"`
      : `echo "docker: 'compose' is not a docker command." >&2; exit 1`;
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = version ]; then ${plugin}; exit 0; fi\nexit 99\n`,
      { mode: 0o755 },
    );
    if (opts.v1) {
      fs.writeFileSync(path.join(bin, "docker-compose"), `#!/bin/sh\necho "${opts.v1}"\n`, { mode: 0o755 });
    }
    return { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
  }

  it("sets COMPOSE for Compose 2.20+", () => {
    const r = bash('require_compose; echo "COMPOSE=$COMPOSE"', stub({ plugin: "2.20.0" }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("COMPOSE=docker compose");
  });

  it("exits 1 before the caller continues on Compose 2.19", () => {
    const r = bash("require_compose; echo CONTINUED", stub({ plugin: "2.19.1" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("Docker Compose 2.19.1 is too old");
    expect(r.out).toContain("v2.20 or newer");
    expect(r.out).not.toContain("CONTINUED");
  });

  it("refuses a machine with only v1 docker-compose, and says so", () => {
    const r = bash("require_compose; echo CONTINUED", stub({ v1: "1.29.2" }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("Only the old 'docker-compose' (1.29.2) was found");
    expect(r.out).not.toContain("CONTINUED");
  });
});
