/**
 * scripts/ci/check-ci-green.sh, executed against recorded API responses.
 *
 * The property these tests exist for: a promotion may only proceed when CI
 * passed on the EXACT commit being promoted. A green run for an older commit,
 * a green run from a pull request, a green run on another branch, and a run
 * that has not finished are all the same answer — no.
 *
 * The responses below have the shape of GitHub's "list workflow runs" payload.
 * `realResponse` is a real one, captured from
 * repos/doomcrewinc/BlackVaultArmory/actions/workflows/ci.yml/runs.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "check-ci-green.sh");

const SHA = "81f8b3ad2f6aaa585a53cecf42ddc3514408276c";
const OLDER_SHA = "7cb16e14b1ca70c7310518deb8d5bdf4bab3efc9";

type Run = Record<string, unknown>;
type Env = Record<string, string | undefined>;

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A completed, successful push run on develop for SHA, unless overridden. */
const run_ = (over: Run = {}): Run => ({
  name: "CI",
  head_branch: "develop",
  head_sha: SHA,
  event: "push",
  status: "completed",
  conclusion: "success",
  run_number: 10,
  run_attempt: 1,
  html_url: "https://github.com/doomcrewinc/BlackVaultArmory/actions/runs/36250584621",
  ...over,
});

function fixture(runs: Run[] | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-ci-green-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "runs.json");
  fs.writeFileSync(
    file,
    typeof runs === "string" ? runs : JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
  );
  return file;
}

function check(runs: Run[] | string, args: string[] = ["develop", SHA], env: Env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "", BV_RUNS_JSON: fixture(runs), ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("green CI on the exact commit is accepted", () => {
  it("exits 0 and names the run", () => {
    const r = check([run_()]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("CI is green for 81f8b3a on develop");
    expect(r.out).toContain("run #10 attempt 1");
  });

  it("accepts the real recorded response for develop's head", () => {
    // Captured live on 2026-09-26. total_count 1: the API's head_sha filter
    // already narrows it, and the script narrows it again.
    const realResponse = JSON.stringify({
      total_count: 1,
      workflow_runs: [
        {
          id: 36250584621,
          name: "CI",
          head_branch: "develop",
          head_sha: SHA,
          event: "push",
          status: "completed",
          conclusion: "success",
          run_number: 10,
          run_attempt: 1,
          html_url: "https://github.com/doomcrewinc/BlackVaultArmory/actions/runs/36250584621",
          created_at: "2026-09-26T15:03:06Z",
        },
      ],
    });
    expect(check(realResponse).code).toBe(0);
  });

  it("writes the run to the step outputs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-ci-out-"));
    tmpDirs.push(dir);
    const outFile = path.join(dir, "out");
    fs.writeFileSync(outFile, "");

    expect(check([run_()], ["develop", SHA], { GITHUB_OUTPUT: outFile }).code).toBe(0);
    const written = fs.readFileSync(outFile, "utf8");
    expect(written).toContain("run_number=10");
    expect(written).toContain("conclusion=success");
    expect(written).toContain("run_url=https://github.com/doomcrewinc/BlackVaultArmory/actions/runs/36250584621");
  });
});

describe("a green run for a DIFFERENT commit is not this commit's evidence", () => {
  // The failure mode this is really about: the head_sha query parameter being
  // dropped or misspelled. This API ignores unknown filters rather than
  // rejecting them, so the response would come back full of green runs for
  // other commits. The script re-filters what it got, so that is a refusal.
  it("refuses when the response holds only older commits' runs", () => {
    const r = check([
      run_({ head_sha: OLDER_SHA, run_number: 8 }),
      run_({ head_sha: "deadbeef".repeat(5), run_number: 7 }),
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no completed 'ci.yml' push run exists for 81f8b3a");
  });

  it("picks this commit's run out of a response containing several commits", () => {
    const r = check([
      run_({ head_sha: OLDER_SHA, run_number: 8 }),
      run_({ run_number: 10 }),
      run_({ head_sha: OLDER_SHA, run_number: 9, conclusion: "failure" }),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("run #10");
    expect(r.out).toContain("(1 matching run(s))");
  });

  it("refuses a run on another branch even with the same sha", () => {
    const r = check([run_({ head_branch: "feat/something" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no completed 'ci.yml' push run exists");
  });

  // A pull_request run builds the MERGE of head into base, not head. Its green
  // tick is about a tree that will never exist on master.
  it("refuses a pull_request run for the same sha", () => {
    const r = check([run_({ event: "pull_request" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no completed 'ci.yml' push run exists");
  });

  it("refuses when there are no runs at all", () => {
    const r = check([]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(":latest is what every installed user pulls");
  });
});

describe("a red or unfinished run is refused", () => {
  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "stale"])(
    "refuses conclusion=%s",
    (conclusion) => {
      const r = check([run_({ conclusion })]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`concluded '${conclusion}'`);
    },
  );

  it.each(["in_progress", "queued", "waiting", "requested", "pending"])("refuses status=%s", (status) => {
    const r = check([run_({ status, conclusion: null })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`is '${status}', not finished`);
    expect(r.err).toContain("Wait for run #10 to finish");
  });

  it("refuses a completed run with a null conclusion", () => {
    const r = check([run_({ conclusion: null })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("concluded 'none'");
  });
});

describe("the newest attempt decides", () => {
  it("refuses when a re-run went red after an earlier green attempt", () => {
    const r = check([run_({ run_attempt: 1 }), run_({ run_attempt: 2, conclusion: "failure" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("attempt 2");
    expect(r.err).toContain("concluded 'failure'");
  });

  it("accepts when a re-run turned an earlier failure green", () => {
    const r = check([run_({ run_attempt: 1, conclusion: "failure" }), run_({ run_attempt: 2 })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("attempt 2");
  });

  it("prefers the higher run_number when the same commit was pushed twice", () => {
    const r = check([run_({ run_number: 12 }), run_({ run_number: 11, conclusion: "failure" })]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("run #12");
  });

  it("refuses when the newer of two pushes is the red one", () => {
    const r = check([run_({ run_number: 11 }), run_({ run_number: 12, conclusion: "failure" })]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("Run #12");
  });
});

describe("bad input and bad responses fail closed", () => {
  it("exits 3 on an unreadable response rather than passing", () => {
    const r = check("not json at all");
    expect(r.code).toBe(3);
    expect(r.err).toContain("unreadable response");
  });

  it("exits 3 when the payload has no workflow_runs array", () => {
    const r = check(JSON.stringify({ message: "Not Found" }));
    expect(r.code).toBe(3);
    expect(r.err).toContain("unreadable response");
  });

  it("exits 3 when the runs cannot be fetched at all", () => {
    // The live equivalent: gh gets a 404 because the workflow was renamed, or
    // no network. Unreachable must never read as green.
    const r = spawnSync("bash", [SCRIPT, "develop", SHA], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: "", BV_RUNS_JSON: "/nonexistent/runs.json" },
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("could not list");
  });

  it("exits 3 on a short sha instead of matching nothing", () => {
    const r = check([run_()], ["develop", "81f8b3a"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("needs the full 40-character sha");
  });

  it("exits 3 with no arguments", () => {
    const r = check([run_()], []);
    expect(r.code).toBe(3);
    expect(r.err).toContain("usage:");
  });

  it("has no arm that treats a missing run as success", () => {
    const src = fs.readFileSync(SCRIPT, "utf8");
    const code = src
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && !/^\s*echo\b/.test(line))
      .join("\n");
    // check() returns success in exactly ONE place, and it is the last
    // statement — reached only after the status and the conclusion have both
    // been checked. An early `return 0` added anywhere above would fail this.
    const returns = code.match(/^\s*return 0$/gm) ?? [];
    expect(returns.length).toBe(1);
    expect(code.trimEnd().split("\n").slice(-12).join("\n")).not.toMatch(/^\s*return 0$/m);
  });
});
