/**
 * Tests for scripts/setup-token.sh — sourced by install.sh and update.sh to
 * print the first-time setup token from the container log after a start.
 * install.bat / update.bat mirror it in :show_setup_token (tested on Windows
 * by scripts/ci/windows/Test-WindowsInstallers.ps1).
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "setup-token.sh");

// What `docker compose logs blackvault` prints: a service prefix, then the
// app's own line. The app prints a NEW token at every start while no admin
// exists, so the last line is the one that works.
const TOKEN_LOG = [
  "blackvault  | Prisma schema loaded from prisma/sqlite/schema.prisma",
  "blackvault  | [auth] Setup token: ABCD-EFGH-JKMN-PQRS — create the first admin at https://vault.example.com/setup",
  "blackvault  | ▲ Next.js 15",
  "blackvault  | [auth] Setup token: WXYZ-2345-6789-ABCD — create the first admin at https://vault.example.com/setup",
  "blackvault  | ✓ Ready in 812ms",
  "",
].join("\n");

const NO_TOKEN_LOG = [
  "blackvault  | Prisma schema loaded from prisma/sqlite/schema.prisma",
  "blackvault  | ✓ Ready in 812ms",
  "",
].join("\n");

describe("show_setup_token", () => {
  let bin: string;
  let calls: string;
  let logs: string;

  beforeEach(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "bv-token-bin-"));
    calls = path.join(bin, "docker.calls");
    logs = path.join(bin, "docker.logs");
    // Stub `docker`: `compose logs` prints $BV_STUB_LOGS_FILE (when set) and
    // exits $BV_STUB_LOGS_EXIT (default 0). Every call is recorded.
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\necho "$*" >> "${calls}"\nif [ "$1 $2" = "compose logs" ]; then\n  [ -n "$BV_STUB_LOGS_FILE" ] && cat "$BV_STUB_LOGS_FILE"\n  exit "\${BV_STUB_LOGS_EXIT:-0}"\nfi\nexit 0\n`,
      { mode: 0o755 },
    );
  });
  afterEach(() => fs.rmSync(bin, { recursive: true, force: true }));

  function run(url: string, log: string | null, extraEnv: Record<string, string> = {}) {
    if (log !== null) fs.writeFileSync(logs, log);
    const r = spawnSync("bash", ["-c", `set -e; . "${LIB}"; COMPOSE="docker compose"; show_setup_token "$1"`, "bash", url], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        BV_STUB_LOGS_FILE: log === null ? "" : logs,
        ...extraEnv,
      },
      timeout: 5000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
  }

  it("prints the LAST token from the blackvault log in a boxed block", () => {
    const r = run("https://vault.example.com", TOKEN_LOG);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("compose logs blackvault");
    expect(r.out).toContain("First-time setup: open https://vault.example.com/setup");
    expect(r.out).toContain("and enter the setup token: WXYZ-2345-6789-ABCD");
    expect(r.out).not.toContain("ABCD-EFGH-JKMN-PQRS");
    // Boxed: a rule above and below the two lines.
    const lines = r.out.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\s*={20,}$/);
    expect(lines[3]).toMatch(/^\s*={20,}$/);
    // Plain ASCII only: cmd.exe's cp437 console would garble anything else,
    // and the .bat twin prints the same text.
    expect(/^[\x20-\x7e\n]*$/.test(r.out)).toBe(true);
  });

  it("prints nothing when the log has no token line (an admin already exists)", () => {
    const r = run("https://vault.example.com", NO_TOKEN_LOG);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("compose logs blackvault");
    expect(r.out).toBe("");
  });

  it("prints nothing and does not fail when docker compose logs fails", () => {
    const r = run("https://vault.example.com", null, { BV_STUB_LOGS_EXIT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("drops a trailing slash from the public URL before adding /setup", () => {
    const r = run("https://vault.example.com:8443/", TOKEN_LOG);
    expect(r.out).toContain("open https://vault.example.com:8443/setup");
    expect(r.out).not.toContain("//setup");
  });

  it("ignores a token line whose code is not XXXX-XXXX-XXXX-XXXX", () => {
    const r = run("https://vault.example.com", "blackvault  | [auth] Setup token: oops — create the first admin at x/setup\n");
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});
