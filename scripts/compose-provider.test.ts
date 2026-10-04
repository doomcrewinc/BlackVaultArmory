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

  const value = (content: string | null) => inDir(content, 'printf "[%s]" "$(env_value K)"');

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
    ["inline comment after a tab", "K=v\t# note\n", "v"],
    ["a # with no whitespace before it is part of the value", "K=a#b\n", "a#b"],
    ["a value that is only a comment", "K= # note\n", ""],
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
    ["an unterminated quote is kept as written", 'K="abc\n', '"abc'],
    ["a longer key with the same suffix", "XK=v\n", ""],
    ["a longer key with the same prefix", "K2=v\nKK=w\n", ""],
    ["export glued to the key is another key", "exportK=v\n", ""],
    ["export without an assignment", "export K\n", ""],
    ["the key only inside another value", "OTHER=K=v\n", ""],
    ["no .env at all", null, ""],
  ])("%s", (_name, content, expected) => {
    const r = value(content);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toBe(`[${expected}]`);
  });

  it("never evaluates the file: $, backticks and $( ) stay literal and nothing runs", () => {
    const r = value("K=$HOME `touch pwned-1` $(touch pwned-2) ${PATH}\nexport X=$(touch pwned-3)\n");
    expect(r.err).toBe("");
    expect(r.out).toBe("[$HOME `touch pwned-1` $(touch pwned-2) ${PATH}]");
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
