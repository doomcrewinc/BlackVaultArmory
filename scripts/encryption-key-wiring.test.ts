/**
 * Static checks of the field-encryption key wiring (Task 7, carry I3) that
 * need no Docker: the compose files mount the host's secrets/ folder
 * read-only and give /run/secrets a tmpfs, the image's entrypoint copies only
 * the two key files and drops to nextjs, and the key never enters the build
 * context or git.
 *
 * What these cannot prove — that uid 1001 can actually read a mode-600 key
 * owned by another host user, that `docker compose config` renders the
 * mount, that rotation works end to end — is proven on a real Linux Docker
 * host by the `encryption-key-linux` job in .github/workflows/ci.yml.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

/** The text of one top-level service block in a compose file (2-space indented YAML). */
function serviceBlock(compose: string, name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) throw new Error(`no service ${name}`);
  let end = start + 1;
  while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

const MOUNT = [
  "      - type: bind",
  "        source: ./secrets",
  "        target: /run/blackvault-secrets",
  "        read_only: true",
  "        bind:",
  "          create_host_path: false",
].join("\n");

describe.each(["docker-compose.yml", "docker-compose.dev.yml"])("%s", (file) => {
  const app = serviceBlock(read(file), "blackvault");

  it("mounts secrets/ read-only at /run/blackvault-secrets, never creating it (a root-owned folder would block the installers)", () => {
    expect(app).toContain(MOUNT);
  });

  it("gives /run/secrets a tmpfs, so the entrypoint's copy of the key never touches disk", () => {
    expect(app).toMatch(/\n {4}tmpfs:\n(?: {6}#[^\n]*\n)* {6}- \/run\/secrets:rw,noexec,nosuid,nodev,size=1m,mode=0700\n/);
  });

  it("passes BLACKVAULT_ENCRYPTION_KEY through, empty by default", () => {
    expect(app).toContain("- BLACKVAULT_ENCRYPTION_KEY=${BLACKVAULT_ENCRYPTION_KEY:-}");
  });

  it("does not use a Compose `secrets:` file entry (a bind mount keeping host owner and mode: unreadable by uid 1001 on Linux)", () => {
    expect(read(file)).not.toMatch(/^secrets:/m);
    expect(app).not.toMatch(/^ {4}secrets:/m);
  });
});

describe("docker-compose.yml", () => {
  it("still passes VAULT_ENCRYPTION_KEY through for the legacy enc: upgrade path", () => {
    expect(serviceBlock(read("docker-compose.yml"), "blackvault")).toContain("- VAULT_ENCRYPTION_KEY=${VAULT_ENCRYPTION_KEY:-}");
  });

  it("tells the app the host folder behind /app/data, for the snapshot log line (M14)", () => {
    const app = serviceBlock(read("docker-compose.yml"), "blackvault");
    expect(app).toContain("- BLACKVAULT_HOST_DB_DIR=${DATA_DIR:-./data}/db");
    expect(app).toContain("- ${DATA_DIR:-./data}/db:/app/data");
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));

  it("starts through the entrypoint, as root (no USER line after it), with su-exec installed", () => {
    expect(runner).toContain('ENTRYPOINT ["/usr/local/bin/blackvault-entrypoint"]');
    expect(runner).toMatch(/apk add --no-cache[^\n]* su-exec/);
    expect(runner).not.toMatch(/^USER /m);
  });

  it("ships the rotation script and the crypto module it imports", () => {
    expect(runner).toContain("COPY --from=builder /app/scripts/rotate-encryption-key.mjs ./scripts/rotate-encryption-key.mjs");
    expect(runner).toContain("COPY --from=builder /app/src/lib/encryption/core.mjs ./src/lib/encryption/core.mjs");
  });
});

describe("scripts/docker-entrypoint.sh", () => {
  const script = read("scripts/docker-entrypoint.sh");

  it("copies ONLY the current and the .new key, never older keys kept in secrets/", () => {
    expect(script).toContain("for name in blackvault_encryption_key blackvault_encryption_key.new; do");
    expect(script).not.toMatch(/\$SRC\/\*/);
  });

  it("makes the copies nextjs-owned, mode 400, in a mode-700 folder, then drops to nextjs", () => {
    expect(script).toContain('chown nextjs:nodejs "$DST/$name"');
    expect(script).toContain('chmod 400 "$DST/$name"');
    expect(script).toContain('chmod 700 "$DST"');
    expect(script.trimEnd().split("\n").pop()).toBe('exec su-exec nextjs:nodejs "$@"');
  });

  it("refuses a key file that is a symbolic link, before copying anything (M9)", () => {
    const loop = script.slice(script.indexOf("for name in"));
    expect(loop.indexOf('[ -L "$SRC/$name" ]')).toBeGreaterThan(-1);
    expect(loop.indexOf('[ -L "$SRC/$name" ]')).toBeLessThan(loop.indexOf("cat "));
    expect(script).toContain("is a symbolic link");
  });

  it("is checked out with LF endings everywhere (it runs in Linux, built from any checkout)", () => {
    expect(read(".gitattributes")).toMatch(/^scripts\/docker-entrypoint\.sh text eol=lf$/m);
    expect(script).not.toContain("\r");
  });

  it("passes shellcheck-level syntax (sh -n) and, run as a non-root user, just runs the command", () => {
    expect(spawnSync("sh", ["-n", path.join(ROOT, "scripts/docker-entrypoint.sh")]).status).toBe(0);
    if (process.getuid?.() === 0) return;
    const r = spawnSync("sh", [path.join(ROOT, "scripts/docker-entrypoint.sh"), "echo", "ran"], { encoding: "utf8", timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ran\n");
  });
});

describe("the key stays out of the image and out of git", () => {
  it(".dockerignore excludes secrets and backups", () => {
    const lines = read(".dockerignore").split("\n").map((l) => l.trim());
    expect(lines).toContain("secrets");
    expect(lines).toContain("backups");
  });

  it("git ignores everything in secrets/ except its .gitignore, and backups/", () => {
    const check = (p: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: ROOT }).status === 0;
    expect(check("secrets/blackvault_encryption_key")).toBe(true);
    expect(check("secrets/blackvault_encryption_key.old-20261001-120000")).toBe(true);
    expect(check("backups/blackvault-20261001-120000.db")).toBe(true);
    expect(check("secrets/.gitignore")).toBe(false);
  });
});
