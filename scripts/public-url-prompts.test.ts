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

function bash(script: string, stdin = "", args: string[] = []) {
  const r = spawnSync("bash", ["-c", `. "${LIB}"; ${script}`, "bash", ...args], { encoding: "utf8", input: stdin });
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
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\nif [ "$1" = compose ]; then\n  if [ "$2" = version ]; then echo "2.29.7"; exit 0; fi\n  exit 0\nfi\nexit 99\n`,
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
});
