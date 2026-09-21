import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { calverForDate } from "../src/lib/version";

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string };

const calver = calverForDate(new Date());

pkg.version = calver;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`package.json version -> ${calver}`);

const existingTags = execSync("git tag --list", { encoding: "utf8" })
  .split("\n")
  .map((t) => t.trim())
  .filter(Boolean);

// A same-day re-release needs a distinct tag. Do NOT use the develop sha here:
// the tag will live on a merge commit on master, whose sha this script cannot know.
const rerunSuffix = new Date().toISOString().slice(11, 16).replace(":", "");
const tag = existingTags.includes(`v${calver}`) ? `v${calver}-${rerunSuffix}` : `v${calver}`;
if (tag !== `v${calver}`) {
  console.log(`NOTE: v${calver} already exists — using disambiguated tag.`);
}

console.log("");
console.log("Next steps (stamp on develop, tag on master):");
console.log(`  git commit -am "chore: release ${calver}"`);
console.log("  git push origin develop");
console.log("");
console.log("  git checkout master && git pull");
console.log(`  git merge --no-ff develop -m "chore: release ${calver}"`);
console.log(`  git tag ${tag}`);
console.log(`  git push origin master ${tag}`);
console.log("");
console.log(`Image will publish as ${calver}-<sha of the tagged merge commit on master>`);
console.log("(the release workflow derives the sha from the tagged commit, not from develop)");
