/**
 * Tests for scripts/public-url-prompts.sh — sourced by install.sh and
 * update.sh to prompt for the public URL, trusted proxies and direct access.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "public-url-prompts.sh");

// `docker compose logs blackvault` output for the setup-token scenarios. The
// app prints a new token at every start while no admin exists: the last one
// is the valid one. scripts/setup-token.test.ts covers the helper itself.
const TOKEN_LOG = [
  "blackvault  | [auth] Setup token: ABCD-EFGH-JKMN-PQRS — create the first admin at https://vault.example.com/setup",
  "blackvault  | [auth] Setup token: WXYZ-2345-6789-ABCD — create the first admin at https://vault.example.com/setup",
  "blackvault  | ✓ Ready in 812ms",
  "",
].join("\n");
const NO_TOKEN_LOG = "blackvault  | ✓ Ready in 812ms\n";

// timeoutMs bounds every call: a prompt that spins forever on EOF must not
// hang the suite. spawnSync kills the child and returns (status: null) once
// the timeout elapses, so a hang shows up as a fast, clear test failure
// instead of blocking the run.
function bash(script: string, stdin = "", args: string[] = [], timeoutMs = 5000) {
  const r = spawnSync("bash", ["-c", `. "${LIB}"; ${script}`, "bash", ...args], {
    encoding: "utf8",
    input: stdin,
    timeout: timeoutMs,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("valid_public_url", () => {
  it.each([
    ["https://vault.example.com", 0],
    ["https://vault.example.com/", 0],
    ["http://localhost:3000", 0],
    ["https://vault.example.com:8443", 0],
    ["vault.example.com", 1],
    ["https://vault.example.com/vault", 1],
    ["https://vault.example.com/?x", 1],
    ["https://vault example.com", 1],
    ["ftp://vault.example.com", 1],
    ["", 1],
  ])("%s -> %i", (url, code) => {
    expect(bash('valid_public_url "$1"', "", [url]).code).toBe(code);
  });
});

describe("set_env_value", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-env-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("replaces one key, keeps every other line byte-identical (CRLF too), writes .bak", () => {
    const file = path.join(dir, ".env");
    const original = "DATA_DIR=/srv/bv\r\nBLACKVAULT_PUBLIC_URL=https://old.example.com\r\nPORT=3000\n";
    fs.writeFileSync(file, original);
    expect(bash('set_env_value "$1" BLACKVAULT_PUBLIC_URL "https://new.example.com:8443"', "", [file]).code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("DATA_DIR=/srv/bv\r\nPORT=3000\nBLACKVAULT_PUBLIC_URL=https://new.example.com:8443\n");
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(original);
  });

  it("appends when the key is absent and does not interpret & or |", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PORT=3000\n");
    bash('set_env_value "$1" BLACKVAULT_TRUSTED_PROXIES "a&b|c"', "", [file]);
    expect(fs.readFileSync(file, "utf8")).toBe("PORT=3000\nBLACKVAULT_TRUSTED_PROXIES=a&b|c\n");
  });

  it("does not touch a key that merely starts with the same text", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "BLACKVAULT_PUBLIC_URL_OLD=x\n");
    bash('set_env_value "$1" BLACKVAULT_PUBLIC_URL "https://v.example.com"', "", [file]);
    expect(fs.readFileSync(file, "utf8")).toBe("BLACKVAULT_PUBLIC_URL_OLD=x\nBLACKVAULT_PUBLIC_URL=https://v.example.com\n");
  });
});

describe("prompt_public_url", () => {
  it("re-prompts until valid", () => {
    const r = bash("prompt_public_url", "nope\nhttps://vault.example.com/\n");
    expect(r.out.trim()).toBe("https://vault.example.com/");
    expect(r.err).toContain("must start with http:// or https://");
  });

  it("keeps the current value on Enter / y", () => {
    expect(bash('prompt_public_url "$1"', "\n", ["https://cur.example.com"]).out.trim()).toBe("https://cur.example.com");
  });

  it("asks for a new value on n", () => {
    expect(bash('prompt_public_url "$1"', "n\nhttps://new.example.com\n", ["https://cur.example.com"]).out.trim()).toBe(
      "https://new.example.com",
    );
  });

  // Regression: read -rp ... || url="" conflated EOF (stdin closed, no more
  // input) with "the user typed an empty/invalid answer", so the loop kept
  // re-prompting forever. EOF must abort with a clear message instead.
  it("aborts with a clear message on immediate EOF (no input at all)", () => {
    const r = bash("prompt_public_url", "", [], 3000);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull(); // null/undefined would mean spawnSync had to kill it (still hanging)
    expect(r.err).toContain("No input received");
    expect(r.err).toContain("BLACKVAULT_PUBLIC_URL");
  });

  it("aborts with a clear message when input ends right after an invalid answer", () => {
    const r = bash("prompt_public_url", "nope\n", [], 3000);
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.err).toContain("No input received");
  });

  it("keeps the current value when EOF hits the confirm prompt (prompt_yes_no's default)", () => {
    const r = bash('prompt_public_url "$1"', "", ["https://cur.example.com"], 3000);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("https://cur.example.com");
  });
});

describe("prompt_yes_no", () => {
  it.each([
    ["\n", "y", "y"],
    ["\n", "n", "n"],
    ["N\n", "y", "n"],
    ["yes\n", "n", "y"],
    ["maybe\nn\n", "y", "n"],
  ])("input %j default %s -> %s", (stdin, def, expected) => {
    expect(bash('prompt_yes_no "Q?" "$1"', stdin, [def]).out.trim()).toBe(expected);
  });

  // EOF-safety check (not a fix here): read's `|| answer=""` on EOF falls
  // through to `${answer:-$default}`, which always matches y/yes or n/no on
  // the first iteration, so this returns immediately and never loops.
  it("returns the default on EOF without hanging", () => {
    expect(bash('prompt_yes_no "Q?" "$1"', "", ["y"], 3000).out.trim()).toBe("y");
    expect(bash('prompt_yes_no "Q?" "$1"', "", ["n"], 3000).out.trim()).toBe("n");
  });
});

describe("install.sh end-to-end", () => {
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-install-"));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "bv-install-bin-"));
    fs.cpSync(path.join(__dirname, ".."), dir, {
      recursive: true,
      filter: (src) => {
        if (src.includes(`${path.sep}node_modules`)) return false;
        if (src.includes(`${path.sep}.git`)) return false;
        if (src.includes(`${path.sep}.next`)) return false;
        const base = path.basename(src);
        if (base.startsWith(".env") && base !== ".env.example") return false;
        return true;
      },
    });
    // Stub `docker` so require_compose passes and $COMPOSE build/up are no-ops.
    // `ps` prints "healthy" so the health wait ends; `logs` prints the file
    // named by $BV_STUB_LOGS_FILE, if any. Every call is recorded.
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\necho "$*" >> "${bin}/docker.log"\nif [ "$1" = compose ]; then\n  if [ "$2" = version ]; then echo "2.29.7"; exit 0; fi\n  if [ "$2" = ps ]; then echo "Up (healthy)"; exit 0; fi\n  if [ "$2" = logs ] && [ -n "$BV_STUB_LOGS_FILE" ]; then cat "$BV_STUB_LOGS_FILE"; fi\n  exit 0\nfi\nexit 99\n`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  it("writes BLACKVAULT_PUBLIC_URL/TRUSTED_PROXIES/DIRECT_ACCESS_INITIAL to .env", () => {
    // data dir (Enter=default) -> port (Enter=default) -> public URL ->
    // trusted proxies (blank) -> allow direct access (y) -> database (2=sqlite)
    const stdin = "\n\nhttps://vault.example.com\n\ny\n2\n";
    const r = spawnSync("bash", ["./install.sh"], {
      cwd: dir,
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      timeout: 30000,
    });
    const env = fs.readFileSync(path.join(dir, ".env"), "utf8");
    expect(env).toContain("BLACKVAULT_PUBLIC_URL=https://vault.example.com");
    expect(env).toContain("BLACKVAULT_TRUSTED_PROXIES=");
    expect(env).toContain("BLACKVAULT_DIRECT_ACCESS_INITIAL=on");
    expect(r.status).toBe(0);
  });

  it("aborts and writes no .env when input ends at the public URL prompt", () => {
    // data dir (Enter=default) -> port (Enter=default) -> EOF (no public URL,
    // no more input at all).
    const stdin = "\n\n";
    const r = spawnSync("bash", ["./install.sh"], {
      cwd: dir,
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      timeout: 10000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("No input received");
    // The script must abort before it ever writes .env — the URL prompt runs
    // before the database prompt and the .env heredoc, so nothing partial
    // (e.g. an empty BLACKVAULT_PUBLIC_URL=) should exist on disk.
    expect(fs.existsSync(path.join(dir, ".env"))).toBe(false);
  });

  function runInstall(log: string) {
    const logs = path.join(bin, "logs.txt");
    fs.writeFileSync(logs, log);
    const r = spawnSync("bash", ["./install.sh"], {
      cwd: dir,
      input: "\n\nhttps://vault.example.com/\n\ny\n2\n",
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, BV_STUB_LOGS_FILE: logs },
      timeout: 30000,
    });
    const calls = fs.readFileSync(path.join(bin, "docker.log"), "utf8");
    return { code: r.status, out: r.stdout + r.stderr, calls };
  }

  it("after the start, prints the last setup token from the log in a boxed block", () => {
    const r = runInstall(TOKEN_LOG);
    expect(r.code).toBe(0);
    const up = r.calls.indexOf("compose up -d");
    expect(up).toBeGreaterThanOrEqual(0);
    expect(r.calls.indexOf("compose logs blackvault")).toBeGreaterThan(up);
    expect(r.out).toContain("First-time setup: open https://vault.example.com/setup");
    expect(r.out).toContain("and enter the setup token: WXYZ-2345-6789-ABCD");
    expect(r.out).not.toContain("ABCD-EFGH-JKMN-PQRS");
  });

  it("prints no setup block when the log has no token line", () => {
    const r = runInstall(NO_TOKEN_LOG);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("compose logs blackvault");
    expect(r.out).not.toContain("First-time setup");
    expect(r.out).not.toContain("setup token");
  });
});

describe("update.sh end-to-end", () => {
  let dir: string;
  let bin: string;
  let log: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-update-"));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "bv-update-bin-"));
    log = path.join(bin, "docker.log");
    // No .git in the copy, so update.sh skips its `git pull`.
    fs.cpSync(path.join(__dirname, ".."), dir, {
      recursive: true,
      filter: (src) => {
        if (src.includes(`${path.sep}node_modules`)) return false;
        if (src.includes(`${path.sep}.git`)) return false;
        if (src.includes(`${path.sep}.next`)) return false;
        const base = path.basename(src);
        if (base.startsWith(".env") && base !== ".env.example") return false;
        if (base.startsWith(".blackvault.env")) return false;
        return true;
      },
    });
    // Stub `docker`: records every call, so a test can tell whether the
    // rebuild and restart ran. `ps` prints "healthy" so the wait loop ends.
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = compose ]; then\n  if [ "$2" = version ]; then echo "2.29.7"; exit 0; fi\n  if [ "$2" = ps ]; then echo "Up (healthy)"; exit 0; fi\n  if [ "$2" = logs ] && [ -n "$BV_STUB_LOGS_FILE" ]; then cat "$BV_STUB_LOGS_FILE"; fi\n  exit 0\nfi\nexit 99\n`,
      { mode: 0o755 },
    );
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  function runUpdate(stdin: string, stubLogs?: string) {
    const logsFile = path.join(bin, "logs.txt");
    if (stubLogs !== undefined) fs.writeFileSync(logsFile, stubLogs);
    const r = spawnSync("bash", ["./update.sh"], {
      cwd: dir,
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, BV_STUB_LOGS_FILE: stubLogs === undefined ? "" : logsFile },
      timeout: 30000,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    return { code: r.status, out: r.stdout + r.stderr, calls };
  }

  it("prompts for a missing public URL, writes it, then rebuilds (premise for the no-.env case)", () => {
    fs.writeFileSync(path.join(dir, ".env"), "BLACKVAULT_DB_PROVIDER=sqlite\n");
    // public URL -> keep direct access (Enter) -> trusted proxies (blank)
    const r = runUpdate("https://vault.example.com\n\n\n");
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, ".env"), "utf8")).toContain("BLACKVAULT_PUBLIC_URL=https://vault.example.com");
    expect(r.calls).toContain("compose build --pull");
    expect(r.calls).toContain("compose up -d");
  });

  // With no .env there can be no BLACKVAULT_PUBLIC_URL, and the container
  // refuses to start without it: rebuilding and restarting would take a
  // running instance down. Stop first, and say how to fix it.
  it("with no .env: stops non-zero before the rebuild and says how to fix it", () => {
    // Valid answers on stdin, so the stop cannot be an accident of a prompt
    // hitting end of input: only the no-.env guard can stop this run.
    const r = runUpdate("https://vault.example.com\n\n\n");
    expect(r.code).not.toBe(0);
    expect(r.code).not.toBeNull();
    expect(r.out).toContain("BLACKVAULT_PUBLIC_URL");
    expect(r.out).toContain("./install.sh");
    expect(r.calls).not.toContain("compose build");
    expect(r.calls).not.toContain("compose up");
    // Stopped by the guard itself, not by a later prompt or .env write
    // failing on the missing file: nothing was asked, nothing left behind.
    expect(r.out).not.toContain("Public URL: the address people open");
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(".env") && f !== ".env.example")).toEqual([]);
  });

  it("after the restart, prints the last setup token from the log in a boxed block", () => {
    fs.writeFileSync(path.join(dir, ".env"), "BLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://vault.example.com\n");
    // keep the URL (Enter) -> keep direct access (Enter) -> trusted proxies (blank)
    const r = runUpdate("\n\n\n", TOKEN_LOG);
    expect(r.code).toBe(0);
    const up = r.calls.indexOf("compose up -d");
    expect(up).toBeGreaterThanOrEqual(0);
    expect(r.calls.indexOf("compose logs blackvault")).toBeGreaterThan(up);
    expect(r.out).toContain("First-time setup: open https://vault.example.com/setup");
    expect(r.out).toContain("and enter the setup token: WXYZ-2345-6789-ABCD");
    expect(r.out).not.toContain("ABCD-EFGH-JKMN-PQRS");
  });

  it("prints no setup block when the log has no token line (an admin exists)", () => {
    fs.writeFileSync(path.join(dir, ".env"), "BLACKVAULT_DB_PROVIDER=sqlite\nBLACKVAULT_PUBLIC_URL=https://vault.example.com\n");
    const r = runUpdate("\n\n\n", NO_TOKEN_LOG);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("compose logs blackvault");
    expect(r.out).not.toContain("First-time setup");
    expect(r.out).not.toContain("setup token");
  });
});
