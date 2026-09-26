/**
 * scripts/ci/check-promote-ancestry.sh, executed against REAL git repositories.
 *
 * The property these tests exist for: a promotion must never move `master`
 * unless `master` is a strict ancestor of `develop`, and when it is not, the
 * refusal has to name the commits that diverged rather than "fix" anything.
 *
 * Every case below builds an actual repository in a temp directory and lets
 * git answer. Nothing is stubbed, because the thing under test IS git's
 * reachability answer.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "check-promote-ancestry.sh");

type Env = Record<string, string | undefined>;

// GITHUB_OUTPUT is blanked by default: these tests run inside CI, where it
// points at the live step-output file, and the script under test appends to it.
const baseEnv = (env: Env): NodeJS.ProcessEnv => ({
  ...process.env,
  GITHUB_OUTPUT: "",
  ...env,
});

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** git, with identity and signing forced so a contributor's ~/.gitconfig cannot break the suite. */
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
      "-c",
      "tag.gpgsign=false",
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

/** A repo with `develop` and `master`, master at the first commit. */
function newRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-promote-"));
  tmpDirs.push(dir);
  git(dir, ["init", "-q", "-b", "develop", "."]);
  commit(dir, "initial");
  git(dir, ["branch", "master"]);
  return dir;
}

function run(cwd: string, args: string[], env: Env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd, encoding: "utf8", env: baseEnv(env) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("a clean fast-forward is accepted", () => {
  it("exits 0 and reports how far master moves", () => {
    const repo = newRepo();
    commit(repo, "feat: one");
    commit(repo, "feat: two");

    const r = run(repo, ["master", "develop"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("fast-forward OK");
    expect(r.out).toContain("(2 commit(s))");
    expect(r.err).not.toContain("::error::");
  });

  it("publishes base_sha, head_sha and ahead as step outputs", () => {
    const repo = newRepo();
    commit(repo, "feat: one");
    const head = commit(repo, "feat: two");
    const base = git(repo, ["rev-parse", "master"]);

    const outFile = path.join(repo, "gh-output");
    fs.writeFileSync(outFile, "");
    expect(run(repo, ["master", "develop"], { GITHUB_OUTPUT: outFile }).code).toBe(0);

    const written = fs.readFileSync(outFile, "utf8");
    expect(written).toContain(`head_sha=${head}`);
    expect(written).toContain(`base_sha=${base}`);
    expect(written).toContain(`head_sha7=${head.slice(0, 7)}`);
    expect(written).toContain("ahead=2");
    expect(written).toContain("status=fast-forward");
  });

  it("accepts a one-commit promotion", () => {
    const repo = newRepo();
    commit(repo, "fix: single");
    expect(run(repo, ["master", "develop"]).code).toBe(0);
  });
});

describe("a diverged master is refused", () => {
  /** master gets a commit of its own; develop gets two. */
  function divergedRepo() {
    const repo = newRepo();
    commit(repo, "feat: one");
    commit(repo, "feat: two");
    git(repo, ["switch", "-q", "master"]);
    commit(repo, "hotfix: straight onto master");
    git(repo, ["switch", "-q", "develop"]);
    return repo;
  }

  it("exits 1 and never says fast-forward", () => {
    const r = run(divergedRepo(), ["master", "develop"]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("fast-forward OK");
    expect(r.err).toContain("is NOT an ancestor of");
  });

  it("names the commits that only exist on master", () => {
    const r = run(divergedRepo(), ["master", "develop"]);
    expect(r.err).toContain("hotfix: straight onto master");
    expect(r.err).toContain("holds 1 commit(s) that");
    // The commits that are only on develop are NOT the problem and must not be
    // presented as one.
    expect(r.err).not.toContain("feat: two");
  });

  it("tells the human what to do and refuses to force anything", () => {
    const r = run(divergedRepo(), ["master", "develop"]);
    expect(r.err).toContain("Nothing was pushed, and nothing was forced.");
    expect(r.err).toContain("git merge origin/master");
    expect(r.err).toContain("Do NOT force-push master");
  });

  it("records status=diverged in the step outputs", () => {
    const repo = divergedRepo();
    const outFile = path.join(repo, "gh-output");
    fs.writeFileSync(outFile, "");
    expect(run(repo, ["master", "develop"], { GITHUB_OUTPUT: outFile }).code).toBe(1);
    expect(fs.readFileSync(outFile, "utf8")).toContain("status=diverged");
  });

  it("refuses when master is simply AHEAD of develop", () => {
    const repo = newRepo();
    git(repo, ["switch", "-q", "master"]);
    commit(repo, "only on master");
    git(repo, ["switch", "-q", "develop"]);

    const r = run(repo, ["master", "develop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is NOT an ancestor of");
  });

  it("refuses after master is force-pushed to an unrelated history", () => {
    const repo = newRepo();
    commit(repo, "feat: one");
    // An orphan branch: no commit in common at all, the worst divergence.
    git(repo, ["checkout", "-q", "--orphan", "rogue"]);
    fs.writeFileSync(path.join(repo, "log.txt"), "rogue\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "rogue root"]);
    git(repo, ["branch", "-f", "master", "rogue"]);
    git(repo, ["switch", "-q", "develop"]);

    const r = run(repo, ["master", "develop"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("rogue root");
  });
});

describe("nothing to promote is its own answer, not a divergence", () => {
  it("exits 2 when the two refs are the same commit", () => {
    const repo = newRepo();
    git(repo, ["branch", "-f", "master", "develop"]);

    const r = run(repo, ["master", "develop"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("nothing to promote");
    expect(r.err).not.toContain("::error::");
  });

  it("reports ahead=0 and status=up-to-date", () => {
    const repo = newRepo();
    git(repo, ["branch", "-f", "master", "develop"]);
    const outFile = path.join(repo, "gh-output");
    fs.writeFileSync(outFile, "");

    expect(run(repo, ["master", "develop"], { GITHUB_OUTPUT: outFile }).code).toBe(2);
    const written = fs.readFileSync(outFile, "utf8");
    expect(written).toContain("ahead=0");
    expect(written).toContain("status=up-to-date");
  });
});

describe("bad input fails closed", () => {
  it("exits 3 on a ref that does not exist", () => {
    const repo = newRepo();
    const r = run(repo, ["master", "origin/nope"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("cannot resolve source ref");
  });

  it("exits 3 on a missing target ref", () => {
    const r = run(newRepo(), ["origin/master", "develop"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("cannot resolve target ref");
  });

  it("exits 3 with no arguments", () => {
    const r = run(newRepo(), []);
    expect(r.code).toBe(3);
    expect(r.err).toContain("usage:");
  });

  it("exits 3 when only one ref is given", () => {
    const r = run(newRepo(), ["master"]);
    expect(r.code).toBe(3);
  });
});

describe("the script cannot itself change a branch", () => {
  it("contains no push, reset, merge or force", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    // Comments and the printed remedy both TALK about merging and force-pushing.
    // Strip anything that is only text, and scan what is left — the commands.
    const code = src
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && !/^\s*echo\b/.test(line))
      .join("\n");
    expect(code).not.toMatch(/git\s+push/);
    expect(code).not.toMatch(/git\s+reset/);
    expect(code).not.toMatch(/git\s+merge\s+[^-]/);
    expect(code).not.toMatch(/--force/);
  });

  it("leaves the repository exactly as it found it", () => {
    const repo = newRepo();
    commit(repo, "feat: one");
    const before = git(repo, ["rev-parse", "develop", "master"]);
    run(repo, ["master", "develop"]);
    expect(git(repo, ["rev-parse", "develop", "master"])).toBe(before);
  });
});
