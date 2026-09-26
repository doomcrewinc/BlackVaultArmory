/**
 * scripts/ci/promote-summary.sh, executed.
 *
 * Two properties: the report says what actually happened (and a dry run says
 * loudly that nothing happened), and a commit subject — which is attacker-
 * controlled text, anyone can open a pull request — is rendered as DATA.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "promote-summary.sh");
const IMAGE = "ghcr.io/doomcrewinc/blackvaultarmory";

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const r = spawnSync(
    "git",
    [
      "-c",
      "user.name=Promote Test",
      "-c",
      "user.email=promote@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, message: string): string {
  fs.appendFileSync(path.join(cwd, "log.txt"), `${message}\n`);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** A repo with a base commit and `subjects` on top of it. */
function repoWith(subjects: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-summary-"));
  tmpDirs.push(dir);
  git(dir, ["init", "-q", "-b", "develop", "."]);
  const base = commit(dir, "base");
  let head = base;
  for (const s of subjects) head = commit(dir, s);
  return { dir, base, head };
}

function render(env: Record<string, string>, cwd: string) {
  const r = spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const envFor = (base: string, head: string, over: Record<string, string> = {}) => ({
  SOURCE_BRANCH: "develop",
  TARGET_BRANCH: "master",
  BASE_SHA: base,
  HEAD_SHA: head,
  AHEAD: "2",
  VERSION: "2026.9.26-81f8b3a",
  TAGS: `${IMAGE}:2026.9.26-81f8b3a\n${IMAGE}:latest`,
  CI_RUN_URL: "https://github.com/doomcrewinc/BlackVaultArmory/actions/runs/36250584621",
  CI_RUN_NUMBER: "10",
  CI_CONCLUSION: "success",
  PROMOTE_REPO: "doomcrewinc/BlackVaultArmory",
  ...over,
});

describe("the dry run says nothing happened", () => {
  const { dir, base, head } = repoWith(["feat: one", "fix: two"]);
  const r = render(envFor(base, head, { PROMOTE_MODE: "dry-run" }), dir);

  it("exits 0", () => expect(r.code).toBe(0));

  it("headlines the dry run", () => {
    expect(r.out).toContain("## Promote — DRY RUN");
    expect(r.out).toContain("**Nothing was merged and nothing was pushed.**");
  });

  it("still reports the version, the tags and the CI run", () => {
    expect(r.out).toContain("`2026.9.26-81f8b3a`");
    expect(r.out).toContain(`- \`${IMAGE}:latest\``);
    expect(r.out).toContain(`- \`${IMAGE}:2026.9.26-81f8b3a\``);
    expect(r.out).toContain("[run #10 — success](https://github.com/doomcrewinc/BlackVaultArmory/actions/runs/36250584621)");
  });

  it("lists exactly the commits between master and develop", () => {
    expect(r.out).toContain("fix: two");
    expect(r.out).toContain("feat: one");
    expect(r.out).not.toContain("- `base`");
  });

  it("says how to turn it into a real promotion", () => {
    expect(r.out).toContain("dry run** unchecked to promote");
  });
});

describe("a real promotion says what moved", () => {
  const { dir, base, head } = repoWith(["feat: one"]);
  const r = render(envFor(base, head, { PROMOTE_MODE: "promote", AHEAD: "1" }), dir);

  it("names the fast-forward and both shas", () => {
    expect(r.out).toContain("## Promote — develop → master");
    expect(r.out).toContain(`Fast-forwarded \`master\` from \`${base.slice(0, 7)}\` to \`${head.slice(0, 7)}\``);
  });

  it("does not claim a dry run", () => {
    expect(r.out).not.toContain("DRY RUN");
    expect(r.out).not.toContain("Nothing was merged");
  });

  it("links the branch it moved", () => {
    expect(r.out).toContain("https://github.com/doomcrewinc/BlackVaultArmory/commits/master");
  });
});

describe("a commit subject is data, never code", () => {
  it("does not execute a command substitution in a commit message", () => {
    const { dir, base, head } = repoWith(["feat: $(touch /tmp/bv-promote-pwned) and `id`"]);
    const marker = path.join(dir, "pwned");
    const r = render(envFor(base, head, { PROMOTE_MODE: "dry-run" }), dir);

    expect(r.code).toBe(0);
    expect(r.out).toContain("$(touch /tmp/bv-promote-pwned)");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync("/tmp/bv-promote-pwned")).toBe(false);
    // `id` would have printed a uid/gid line if it had been evaluated.
    expect(r.out).not.toMatch(/uid=\d+/);
  });

  it("does not execute a branch name", () => {
    const { dir, base, head } = repoWith(["feat: one"]);
    const r = render(
      envFor(base, head, { PROMOTE_MODE: "promote", TARGET_BRANCH: "master$(id)", AHEAD: "1" }),
      dir,
    );
    expect(r.out).toContain("master$(id)");
    expect(r.out).not.toMatch(/uid=\d+/);
  });
});

describe("missing values degrade instead of crashing", () => {
  it("survives an empty tag list and an unknown commit range", () => {
    const { dir } = repoWith([]);
    const r = render(
      {
        PROMOTE_MODE: "dry-run",
        BASE_SHA: "",
        HEAD_SHA: "",
        TAGS: "",
        VERSION: "",
        CI_RUN_URL: "",
        CI_CONCLUSION: "",
      },
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("_(none derived)_");
    expect(r.out).toContain("_(commit range unavailable)_");
  });
});
