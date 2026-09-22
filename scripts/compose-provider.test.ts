/**
 * Tests for the Docker Compose version floor in scripts/compose-provider.sh
 * (sourced by install.sh and update.sh). docker-compose.yml needs Compose
 * 2.20+ for depends_on.required: false.
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
