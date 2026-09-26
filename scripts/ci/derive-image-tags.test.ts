/**
 * The publishing policy in scripts/ci/derive-image-tags.sh, executed.
 *
 * The property these tests exist for: a build from `develop` must never be
 * able to publish `:latest`. That used to be guarded in release.yml against a
 * pre-release tag; the tag trigger is gone, the property is not.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";
import { calverForDate } from "../../src/lib/version";

const SCRIPT = path.join(__dirname, "derive-image-tags.sh");
const IMAGE = "ghcr.io/doomcrewinc/blackvaultarmory";
const SHA = "81f8b3addeadbeefcafe1234567890abcdef0123";

// The repo augments NodeJS.ProcessEnv with required keys, so overrides are
// typed as a plain record and merged over the real environment.
//
// GITHUB_OUTPUT is blanked by default ON PURPOSE. These tests run inside CI,
// where that variable points at the live step-output file; inheriting it would
// let the script under test append `tags=`/`full=` to the real job's outputs.
type Env = Record<string, string | undefined>;

const baseEnv = (env: Env): NodeJS.ProcessEnv => ({
  ...process.env,
  GITHUB_OUTPUT: "",
  BV_COMMIT_DATE: "2026-09-26",
  ...env,
});

function run(args: string[], env: Env = {}) {
  const r = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: baseEnv(env),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Source the script and evaluate an expression against its functions. */
function sourced(snippet: string, env: Env = {}) {
  const r = spawnSync("bash", ["-c", `. "${SCRIPT}"\n${snippet}`], {
    encoding: "utf8",
    env: baseEnv(env),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The tag lines the script says it will push. */
function tagsFor(branch: string, env: Env = {}) {
  const r = sourced(`derive "${branch}" "${SHA}"`, env);
  return {
    code: r.code,
    err: r.err,
    tags: r.out.split("\n").filter(Boolean),
  };
}

describe("branch -> tag mapping", () => {
  it("master publishes the immutable tag and :latest", () => {
    expect(tagsFor("master").tags).toEqual([`${IMAGE}:2026.9.26-81f8b3a`, `${IMAGE}:latest`]);
  });

  it("develop publishes the immutable tag and :develop", () => {
    expect(tagsFor("develop").tags).toEqual([`${IMAGE}:2026.9.26-81f8b3a`, `${IMAGE}:develop`]);
  });

  it("every publishing branch gets an immutable <calver>-<sha7> tag", () => {
    for (const branch of ["master", "develop"]) {
      expect(tagsFor(branch).tags[0]).toBe(`${IMAGE}:2026.9.26-81f8b3a`);
    }
  });
});

describe("develop can never publish :latest", () => {
  it("emits no :latest tag", () => {
    const { tags } = tagsFor("develop");
    expect(tags).not.toContain(`${IMAGE}:latest`);
    expect(tags.join("\n")).not.toMatch(/:latest$/m);
  });

  it("produces the string 'latest' in exactly one arm of floating_tag_for", () => {
    expect(sourced(`floating_tag_for master`).out.trim()).toBe("latest");
    expect(sourced(`floating_tag_for develop`).out.trim()).toBe("develop");
  });

  // Mutation: break the case statement the way a careless edit would, and
  // prove the redundant assertion in derive() still refuses the push.
  it("refuses even if floating_tag_for is broken to return latest for develop", () => {
    const r = sourced(`floating_tag_for() { printf 'latest\\n'; }\nderive develop "${SHA}"`);
    expect(r.code).toBe(1);
    expect(r.err).toContain("resolved to the :latest tag");
    expect(r.out).not.toContain(":latest");
  });
});

describe("unmapped refs fail closed", () => {
  it.each(["feat/continuous-image-publish", "V1.2", "main", "", "master-hotfix", "release/2026.9.26"])(
    "publishes nothing from %s",
    (branch) => {
      const r = tagsFor(branch);
      expect(r.code).toBe(1);
      expect(r.tags).toEqual([]);
    },
  );

  it("has no default arm that could invent a tag", () => {
    expect(fs.readFileSync(SCRIPT, "utf8")).not.toMatch(/\*\)\s*printf/);
  });
});

describe("calver agrees with the app's own calverForDate", () => {
  it.each(["2026-01-05", "2026-09-26", "2026-12-31", "2026-10-01", "2027-11-09"])(
    "%s matches src/lib/version.ts",
    (iso) => {
      const shell = sourced(`calver_for_commit "${SHA}"`, { BV_COMMIT_DATE: iso }).out.trim();
      expect(shell).toBe(calverForDate(new Date(`${iso}T12:00:00.000Z`)));
    },
  );

  it("strips leading zeros, unlike the old tag-derived calver", () => {
    expect(sourced(`calver_for_commit x`, { BV_COMMIT_DATE: "2026-09-05" }).out.trim()).toBe("2026.9.5");
  });
});

describe("the image tag and the version the app reports are one string", () => {
  it("writes full= equal to the immutable tag's version portion", () => {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bv-tags-")), "out");
    fs.writeFileSync(outFile, "");
    const r = run(["master", SHA], { GITHUB_OUTPUT: outFile });
    expect(r.code).toBe(0);

    const written = fs.readFileSync(outFile, "utf8");
    const full = /^full=(.+)$/m.exec(written)?.[1];
    expect(full).toBe("2026.9.26-81f8b3a");

    // publish.yml passes `full` as the APP_VERSION build-arg AND uses the same
    // derived list as the image tags. Same string, both places.
    expect(written).toContain(`${IMAGE}:${full}`);
    expect(/^floating=latest$/m.test(written)).toBe(true);
    expect(/^calver=2026\.9\.26$/m.test(written)).toBe(true);
  });

  it("prints the tag list so a finished run is auditable from the log", () => {
    const r = run(["develop", SHA]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("branch=develop calver=2026.9.26 version=2026.9.26-81f8b3a");
    expect(r.out).toContain(`${IMAGE}:develop`);
    expect(r.out).not.toContain(":latest");
  });
});
