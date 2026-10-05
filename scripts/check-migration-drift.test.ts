/**
 * The shadow-database guard in scripts/check-migration-drift.sh. Prisma wipes
 * the shadow database, so only a name with shadow, scratch or test as a whole
 * token (split by _ or -) is accepted.
 */
import { spawnSync } from "child_process";
import path from "path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "check-migration-drift.sh");

function guard(url: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `. "${SCRIPT}"; guard_shadow "$1" && echo ACCEPTED`, "bash", url], {
    encoding: "utf8",
    // Next's types make NODE_ENV a required key of ProcessEnv; the guard runs
    // with only PATH and the variables a test passes, so the cast is deliberate.
    env: { PATH: process.env.PATH, ...env } as unknown as NodeJS.ProcessEnv,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const url = (name: string) => `postgresql://u:p@127.0.0.1:5432/${name}?schema=public`;

describe("guard_shadow", () => {
  it.each(["blackvault_shadow", "test_db", "scratch", "BlackVault-Test", "shadow-1"])("accepts %s", (name) => {
    const r = guard(url(name));
    expect(r.code).toBe(0);
    expect(r.out).toContain("ACCEPTED");
  });

  it.each(["latest", "contest", "blackvault", "shadowy", "testing", "myscratchpad"])("refuses %s", (name) => {
    const r = guard(url(name));
    expect(r.code).toBe(1);
    expect(r.out).toContain("REFUSED");
    expect(r.out).not.toContain("ACCEPTED");
  });

  it("refuses a URL with no database name", () => {
    expect(guard("postgresql://u:p@127.0.0.1:5432").code).toBe(1);
  });

  it("refuses the app's DATABASE_URL even when the name looks disposable", () => {
    const r = guard(url("blackvault_test"), { DATABASE_URL: url("blackvault_test") });
    expect(r.code).toBe(1);
    expect(r.out).toContain("same as DATABASE_URL");
  });
});
