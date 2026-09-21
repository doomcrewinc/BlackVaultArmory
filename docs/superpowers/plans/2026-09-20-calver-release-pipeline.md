# CalVer Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace semver with CalVer `YYYY.M.D-sha7`, surface the running version at runtime, and
replace the broken upstream-targeted CI with a PR gate plus tag-triggered release.

**Architecture:** A pure, unit-tested version module (`src/lib/version.ts`) is the single source
of formatting truth. The CalVer string lives in `package.json`; the short sha is injected at
Docker build time as `NEXT_PUBLIC_APP_VERSION` and read by `/api/health` and the Settings page.
CI splits into `ci.yml` (lint/build/test on PR, publishes nothing) and `release.yml` (multi-arch
build/push on `v*` tag).

**Tech Stack:** Next.js 16.1.6, React 19, TypeScript 5, vitest, GitHub Actions, Docker Buildx

**Spec:** `docs/superpowers/specs/2026-09-20-calver-release-pipeline-design.md`

## Global Constraints

- Version format is exactly `YYYY.M.D-sha7`. **No leading zeros** — `2026.9.20`, never `2026.09.20`.
- `package.json.version` holds CalVer only (no sha suffix), and must remain semver-parseable.
- Docker tags must not contain `+`. Use `-` to join sha.
- GHCR namespace is `ghcr.io/doomcrewinc/blackvaultarmory` (lowercase, required by GHCR).
- Date arithmetic uses **UTC** so builds are deterministic regardless of runner timezone.
- Never hard-fail when `NEXT_PUBLIC_APP_VERSION` is unset; resolve to the literal string `dev`.
- Existing test style: vitest with `vi.hoisted` + `vi.mock("@/lib/prisma")`. Match it.
- git-flow: `master` (production, tagged) and `develop` (integration trunk, GitHub default).
  Feature branches use the conventional-commit prefixes `feat/` `fix/` `chore/` `docs/`, branch
  off `develop`, and PR back into `develop`. `hotfix/` branches off `master`. No `release/`
  branches — a release is a `--no-ff` merge of `develop` into `master`, then a tag.
- All work happens on branch `feat/calver-release`, PR'd into `develop`.
- **Task 0 must run first.** `develop` does not exist yet, so there is nowhere for the first PR
  to land.
- **`gh pr create` must pass `--repo doomcrewinc/BlackVaultArmory`.** This repo is a fork, so
  `gh` defaults the PR base to the upstream parent and fails with
  `doomcrewinc does not have the correct permissions to execute CreatePullRequest`.
- **PREREQUISITE — `npm run build` is broken on a clean checkout.** `prisma/prisma/dev.db` is
  committed with a `_prisma_migrations` ledger recording only 10 of the 18 migrations on disk,
  while its schema was already pushed past that point. `migrate deploy` re-applies migration 11
  and dies with `P3018: duplicate column name: serialNumber`. Since CI runs `npm run build` on a
  fresh checkout, the pipeline in Task 7 fails on every run until the file is untracked. Tasks 5
  and 7 both depend on the fix. Tracked as `chore/untrack-dev-db`; it must be merged to `develop`
  before Task 5.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add vitest + `test` script; rename package; set CalVer version |
| `src/lib/version.ts` | **Create** | Pure version formatting + `APP_VERSION` constant |
| `src/lib/version.test.ts` | **Create** | Unit tests for the pure functions |
| `scripts/stamp-version.ts` | **Create** | Write today's CalVer into package.json; print tag command |
| `src/app/api/health/route.ts` | Modify | Return `version` |
| `src/app/api/health/route.test.ts` | **Create** | Assert health payload shape |
| `src/app/settings/page.tsx` | Modify | Display running version |
| `Dockerfile` | Modify | `ARG APP_VERSION` → `ENV NEXT_PUBLIC_APP_VERSION` in builder + runner |
| `.github/workflows/ci.yml` | **Create** | Lint/build/test on PR and push to `develop`/`master` |
| `.github/workflows/release.yml` | **Create** | Multi-arch build + push on `v*` tag |
| `.github/workflows/docker.yml` | **Delete** | Replaced by the two above |
| `CONTRIBUTING.md` | **Create** | Branch model, commit convention, release procedure |

---

## Task 0: Establish the git-flow branches

**REPO ADMINISTRATION — CONFIRM WITH THE OWNER BEFORE RUNNING.** This task changes the remote's
default branch. It creates no code and has no tests. Every later task depends on `develop`
existing, so it cannot be deferred to the end.

**Files:** none

**Interfaces:**
- Consumes: nothing
- Produces: `master` and `develop` on the remote; `develop` as the GitHub default branch

- [ ] **Step 1: Confirm the starting point is clean and matches upstream**

```bash
cd /Users/doomcrew/repos/BlackVaultArmory
git status --porcelain && echo "--- clean if nothing above ---"
git rev-parse HEAD origin/V1.2
```

Expected: no output from `status`, and both SHAs identical. If the tree is dirty, stop and
resolve that first — this task rewrites branch topology.

- [ ] **Step 2: Create master and develop from the current V1.2 tip**

```bash
git checkout V1.2
git branch master
git branch develop
git push -u origin master
git push -u origin develop
```

Expected: both branches created remotely, all three refs pointing at `e991c37`.

- [ ] **Step 3: Make develop the GitHub default**

```bash
gh repo edit doomcrewinc/BlackVaultArmory --default-branch develop
gh repo view doomcrewinc/BlackVaultArmory --json defaultBranchRef --jq .defaultBranchRef.name
```

Expected: prints `develop`. PRs opened without an explicit `--base` will now target `develop`,
which is the common case; hotfixes pass `--base master` explicitly.

- [ ] **Step 4: Record the upstream remote for later syncing**

`V1.2` is kept to track the fork parent. Wire the remote now so the sync procedure in
`CONTRIBUTING.md` (Task 8) works as written:

```bash
git remote add upstream git@github.com:theaveragedeveloper/BlackVaultArmory.git 2>/dev/null || true
git remote -v | grep upstream
```

Expected: two `upstream` lines (fetch and push).

- [ ] **Step 5: Optional — branch protection**

In the GitHub UI, consider requiring the `verify` check from `ci.yml` (Task 7) on both `master`
and `develop`. There is no CLI-stable equivalent worth scripting for a solo repo, and the checks
do not exist until Task 7 lands — so this is best done after this plan completes.

---

## Task 1: Working test harness

Nothing else in this plan can be verified without this. `vitest.config.ts` and three test files
already exist but vitest is absent from `package.json`.

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: `develop` from Task 0
- Produces: `npm test` runs vitest once and exits; `npm run test:watch` for iteration

- [ ] **Step 1: Create the branch off develop**

```bash
cd /Users/doomcrew/repos/BlackVaultArmory
git checkout develop
git pull
git checkout -b feat/calver-release
```

- [ ] **Step 2: Install vitest**

```bash
npm install --save-dev vitest@^2.1.9
```

- [ ] **Step 3: Add test scripts to `package.json`**

In the `"scripts"` block, add these two entries after `"lint": "eslint",`:

```json
    "test": "vitest run",
    "test:watch": "vitest",
```

- [ ] **Step 4: Rename the package and drop the semver placeholder**

Change the first three lines of `package.json` from:

```json
  "name": "blackvault-temp",
  "version": "0.1.0",
  "private": true,
```

to:

```json
  "name": "blackvaultarmory",
  "version": "2026.9.20",
  "private": true,
```

- [ ] **Step 5: Run the pre-existing suite**

Run: `npm test`
Expected: vitest discovers 3 files (`api/settings/route.test.ts`,
`api/exports/full-armory/route.test.ts`, `api/exports/data/route.backup.test.ts`) and they PASS.

If any fail, that is a **pre-existing** failure unrelated to this plan. Record the failure output
in the PR description and continue — do not fix it here.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add vitest harness and adopt calver package version"
```

---

## Task 2: Version module

**Files:**
- Create: `src/lib/version.ts`
- Test: `src/lib/version.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `calverForDate(date: Date): string` — UTC `YYYY.M.D`, no leading zeros
  - `formatVersion(calver: string, sha?: string | null): string` — `calver` or `calver-sha7`
  - `APP_VERSION: string` — resolved runtime version, `"dev"` when env is unset

- [ ] **Step 1: Write the failing test**

Create `src/lib/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { calverForDate, formatVersion } from "./version";

describe("calverForDate", () => {
  it("formats a date as YYYY.M.D in UTC", () => {
    expect(calverForDate(new Date("2026-09-20T12:00:00.000Z"))).toBe("2026.9.20");
  });

  it("strips leading zeros from month and day", () => {
    expect(calverForDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026.1.5");
  });

  it("keeps two-digit month and day intact", () => {
    expect(calverForDate(new Date("2026-12-31T00:00:00.000Z"))).toBe("2026.12.31");
  });

  it("uses UTC, not local time", () => {
    // 23:30 UTC on the 20th is still the 20th regardless of runner timezone
    expect(calverForDate(new Date("2026-09-20T23:30:00.000Z"))).toBe("2026.9.20");
  });

  it("always produces a semver-parseable string with no leading zeros", () => {
    const v = calverForDate(new Date("2026-01-05T00:00:00.000Z"));
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    for (const part of v.split(".")) {
      expect(part === "0" || !part.startsWith("0")).toBe(true);
    }
  });
});

describe("formatVersion", () => {
  it("appends a 7-character sha", () => {
    expect(formatVersion("2026.9.20", "e991c3749325b5daf6")).toBe("2026.9.20-e991c37");
  });

  it("leaves an already-short sha alone", () => {
    expect(formatVersion("2026.9.20", "e991c37")).toBe("2026.9.20-e991c37");
  });

  it("returns bare calver when sha is null", () => {
    expect(formatVersion("2026.9.20", null)).toBe("2026.9.20");
  });

  it("returns bare calver when sha is undefined", () => {
    expect(formatVersion("2026.9.20")).toBe("2026.9.20");
  });

  it("returns bare calver when sha is blank or whitespace", () => {
    expect(formatVersion("2026.9.20", "   ")).toBe("2026.9.20");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/version.test.ts`
Expected: FAIL — `Failed to resolve import "./version"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/version.ts`:

```ts
/**
 * version.ts — CalVer (YYYY.M.D) + short sha.
 *
 * The CalVer portion lives in package.json and is stamped at release time.
 * The sha is injected at Docker build time via NEXT_PUBLIC_APP_VERSION.
 * Outside Docker the version resolves to "dev".
 */

/** UTC CalVer with no leading zeros, e.g. 2026.9.20. Semver-parseable by construction. */
export function calverForDate(date: Date): string {
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

/** Join a CalVer with a short sha. Returns bare CalVer when no usable sha is supplied. */
export function formatVersion(calver: string, sha?: string | null): string {
  const trimmed = (sha ?? "").trim();
  if (!trimmed) return calver;
  return `${calver}-${trimmed.slice(0, 7)}`;
}

/** The running version. "dev" when NEXT_PUBLIC_APP_VERSION is not set. */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "dev";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/version.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/version.ts src/lib/version.test.ts
git commit -m "feat: add calver version module"
```

---

## Task 3: Release stamping script

**Files:**
- Create: `scripts/stamp-version.ts`
- Modify: `package.json` (add `release:stamp` script)

**Interfaces:**
- Consumes: `calverForDate` from `src/lib/version.ts`
- Produces: `npm run release:stamp` — rewrites `package.json.version`, prints the git tag to use

Same-day re-releases collide on the bare tag `v2026.9.20`. The script detects an existing tag and
prints the disambiguated `v<calver>-<sha7>` form instead. `release.yml` triggers on `v*`, so both
shapes work.

- [ ] **Step 1: Write the script**

Create `scripts/stamp-version.ts`:

```ts
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { calverForDate, formatVersion } from "../src/lib/version";

const pkgPath = path.join(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string };

const calver = calverForDate(new Date());
const sha = execSync("git rev-parse --short=7 HEAD", { encoding: "utf8" }).trim();
const full = formatVersion(calver, sha);

pkg.version = calver;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
console.log(`package.json version -> ${calver}`);

const existingTags = execSync("git tag --list", { encoding: "utf8" })
  .split("\n")
  .map((t) => t.trim())
  .filter(Boolean);

const tag = existingTags.includes(`v${calver}`) ? `v${full}` : `v${calver}`;
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
console.log(`Image will publish as ${full}`);
```

- [ ] **Step 2: Add the npm script**

In `package.json` `"scripts"`, after `"reset-db"`, add:

```json
    "release:stamp": "npx ts-node --project tsconfig.json scripts/stamp-version.ts",
```

- [ ] **Step 3: Verify it runs without mutating state unexpectedly**

```bash
npm run release:stamp
git diff package.json
```

Expected: `version` is today's CalVer; the printed tag command names `v<today>`; no other file
changed. If today is 2026-09-20 the version is unchanged from Task 1 and `git diff` is empty —
that is correct, not a failure.

- [ ] **Step 4: Commit**

```bash
git add scripts/stamp-version.ts package.json
git commit -m "feat: add release version stamping script"
```

---

## Task 4: Expose version on /api/health

**Files:**
- Modify: `src/app/api/health/route.ts`
- Test: `src/app/api/health/route.test.ts`

**Interfaces:**
- Consumes: `APP_VERSION` from `src/lib/version.ts`
- Produces: `GET /api/health` → `{ status: "ok", timestamp: string, version: string }`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/health/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/version", () => ({ APP_VERSION: "2026.9.20-e991c37" }));

import { GET } from "./route";

describe("/api/health", () => {
  it("returns ok with a version and timestamp", async () => {
    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe("2026.9.20-e991c37");
    expect(typeof body.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/api/health/route.test.ts`
Expected: FAIL — `expected undefined to be '2026.9.20-e991c37'`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `src/app/api/health/route.ts`:

```ts
import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/version";

export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString(), version: APP_VERSION },
    { status: 200 }
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/app/api/health/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/health/route.ts src/app/api/health/route.test.ts
git commit -m "feat: report app version from /api/health"
```

---

## Task 5: Show version in Settings

**Files:**
- Modify: `src/app/settings/page.tsx`

**Interfaces:**
- Consumes: `APP_VERSION` from `src/lib/version.ts`; existing local component `StatusRow`
- Produces: nothing consumed by later tasks

`StatusRow` is already defined at the bottom of `settings/page.tsx` with the signature
`{ label: string; value: string; ok: boolean }`. Reuse it rather than writing new markup.

- [ ] **Step 1: Add the import**

At the top of `src/app/settings/page.tsx`, alongside the other `@/` imports, add:

```tsx
import { APP_VERSION } from "@/lib/version";
```

- [ ] **Step 2: Render the version above the Save button**

In the JSX, immediately **before** the `<div>` that wraps the `Save Settings`
`<StandardButton>`, insert:

```tsx
        <div className="pt-2">
          <StatusRow label="Version" value={APP_VERSION} ok={APP_VERSION !== "dev"} />
        </div>
```

- [ ] **Step 3: Verify in the browser**

```bash
npm run dev
```

Open http://localhost:3000/settings and scroll to the bottom.
Expected: a "Version" row reading `dev` in the faint (not green) style, because
`NEXT_PUBLIC_APP_VERSION` is unset locally.

- [ ] **Step 4: Verify lint and build still pass**

Run: `npm run lint && npm run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src/app/settings/page.tsx
git commit -m "feat: display running version on settings page"
```

---

## Task 6: Dockerfile version injection

**Files:**
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: nothing
- Produces: build-arg `APP_VERSION`, consumed by `release.yml` in Task 7

`NEXT_PUBLIC_*` variables are inlined into client bundles at **build** time, so the value must be
present in the builder stage. `/api/health` reads it at **runtime**, so it must also be present in
the runner stage. Both are required — setting only one leaves either the UI or the API showing
`dev`.

- [ ] **Step 1: Set the arg in the builder stage**

In `Dockerfile`, in the `FROM node:20-alpine AS builder` stage, directly above the existing line
`ENV NEXT_TELEMETRY_DISABLED=1`, insert:

```dockerfile
# Version string (YYYY.M.D-sha7). Inlined into client bundles at build time.
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
```

- [ ] **Step 2: Set it again in the runner stage**

In the `FROM node:20-alpine AS runner` stage, directly below the existing line
`ENV NEXT_TELEMETRY_DISABLED=1`, insert:

```dockerfile
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
```

- [ ] **Step 3: Build and verify end to end**

```bash
docker build --build-arg APP_VERSION=2026.9.20-e991c37 -t bv-version-test .
docker run --rm -d --name bv-version-test -p 3999:3000 bv-version-test
sleep 12
curl -s http://127.0.0.1:3999/api/health
docker rm -f bv-version-test
```

Expected: JSON containing `"version":"2026.9.20-e991c37"`.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "feat: inject app version into docker build"
```

---

## Task 7: Replace CI with a PR gate and a tag-triggered release

**Files:**
- Delete: `.github/workflows/docker.yml`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `APP_VERSION` build-arg from Task 6
- Produces: images at `ghcr.io/doomcrewinc/blackvaultarmory`

The existing `docker.yml` pushes to `ghcr.io/theaveragedeveloper/projectblackvault` on every push
to `V1.2`. From this fork that fails on permissions. It is replaced, not patched.

- [ ] **Step 1: Delete the broken workflow**

```bash
git rm .github/workflows/docker.yml
```

- [ ] **Step 2: Create the PR gate**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [develop, master]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test

      - name: Build
        run: npm run build
```

- [ ] **Step 3: Create the release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write

    steps:
      - uses: actions/checkout@v4

      - name: Derive version strings
        id: ver
        run: |
          TAG="${GITHUB_REF_NAME#v}"
          CALVER="${TAG%%-*}"
          SHA="$(git rev-parse --short=7 HEAD)"
          echo "calver=$CALVER" >> "$GITHUB_OUTPUT"
          echo "full=$CALVER-$SHA"  >> "$GITHUB_OUTPUT"

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GitHub Container Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          platforms: linux/amd64,linux/arm64
          build-args: |
            APP_VERSION=${{ steps.ver.outputs.full }}
          tags: |
            ghcr.io/doomcrewinc/blackvaultarmory:${{ steps.ver.outputs.full }}
            ghcr.io/doomcrewinc/blackvaultarmory:${{ steps.ver.outputs.calver }}
            ghcr.io/doomcrewinc/blackvaultarmory:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 4: Verify the workflows parse**

```bash
npx --yes js-yaml .github/workflows/ci.yml > /dev/null && echo "ci.yml OK"
npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo "release.yml OK"
grep -r "theaveragedeveloper" .github/ && echo "STILL REFERENCES UPSTREAM — FIX" || echo "no upstream refs"
```

Expected: both `OK`, and `no upstream refs`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "ci: split into PR gate and tag-triggered release, retarget GHCR to this fork"
```

---

## Task 8: Document the branch model

**Files:**
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: the branches created in Task 0
- Produces: nothing

- [ ] **Step 1: Write the contributing guide**

Create `CONTRIBUTING.md`:

```markdown
# Contributing

## Branches

git-flow, with branch prefixes matching our conventional-commit prefixes so a branch name and its
commits always agree.

| Branch | Off | Into | Purpose |
|---|---|---|---|
| `master` | — | — | Production. Only receives merges from `develop` or a hotfix. Tagged. |
| `develop` | — | — | Integration trunk. GitHub default. All feature PRs land here. |
| `feat/<slug>` | `develop` | `develop` | New functionality. |
| `fix/<slug>` | `develop` | `develop` | Bug fixes. |
| `chore/<slug>` | `develop` | `develop` | Tooling, deps, CI. |
| `docs/<slug>` | `develop` | `develop` | Documentation only. |
| `hotfix/<slug>` | `master` | `master` + `develop` | Urgent production fix that cannot wait for develop. |
| `V1.2` | — | — | Tracks upstream `theaveragedeveloper/BlackVaultArmory`. Do not develop here. |

Never commit directly to `master` or `develop`. Open a PR; CI must pass before merge.

We do **not** use `release/` branches. A release is a `--no-ff` merge of `develop` into `master`
followed by a tag. Cut a `release/<calver>` branch only if `develop` must keep moving during a
long stabilization window.

## Commits

Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`.

## Versioning

CalVer `YYYY.M.D` plus a short sha, e.g. `2026.9.20-e991c37`.

- `package.json` holds the CalVer only.
- Git tags are `v<calver>`, or `v<calver>-<sha7>` for a second release on the same day.
- Docker publishes three tags: `<calver>-<sha7>`, `<calver>`, and `latest`.

**No leading zeros.** `2026.9.20` is valid; `2026.09.20` is not valid semver and npm will reject it.

## Releasing

Releases are cut from `master`, but the version is stamped on `develop` so the two never diverge.

```bash
git checkout develop && git pull
npm run release:stamp                     # writes package.json, prints the tag to use
git commit -am "chore: release <calver>"
git push origin develop

git checkout master && git pull
git merge --no-ff develop -m "chore: release <calver>"
git tag v<calver>
git push origin master v<calver>
```

The tag push triggers `.github/workflows/release.yml`, which builds `linux/amd64,linux/arm64`
and pushes to `ghcr.io/doomcrewinc/blackvaultarmory`. Pushes to `develop` and `master` run CI
but publish nothing.

## Hotfixes

```bash
git checkout master && git pull
git checkout -b hotfix/<slug>
# ...fix, commit...
gh pr create --base master --title "hotfix: <slug>"
# after it merges and is tagged, port it back so develop does not regress:
git checkout develop && git pull && git merge master && git push origin develop
```

## Syncing with upstream

```bash
git fetch upstream
git checkout V1.2 && git merge --ff-only upstream/V1.2 && git push origin V1.2
git checkout develop && git merge V1.2      # resolve conflicts here, never on V1.2
```
```

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: document git-flow branch model, commit convention, and release procedure"
```

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/calver-release
gh pr create --base develop --title "CalVer release pipeline" \
  --body "Implements docs/superpowers/plans/2026-09-20-calver-release-pipeline.md"
```

`--base develop` is explicit here for clarity, though Task 0 Step 3 made it the default.

---

## Self-Review

**Spec coverage:**

| Spec acceptance criterion | Task |
|---|---|
| `npm test` runs the three pre-existing files | 1 |
| `/api/health` returns `version` | 4 |
| Settings displays the version | 5 |
| `npm run dev` shows `dev`, does not crash | 2 (`|| "dev"`), verified in 5 |
| `docker build --build-arg APP_VERSION=...` reports that string | 6 |
| CI references only `ghcr.io/doomcrewinc/blackvaultarmory` | 7 |
| PR runs lint + build + test, publishes nothing | 7 (`ci.yml`) |
| Push to `develop`/`master` runs CI, publishes nothing | 7 (`ci.yml`) |
| Tag `v2026.9.20` publishes three Docker tags | 7 (`release.yml`) |
| Package renamed off `blackvault-temp` | 1 |
| `master` + `develop` exist, `develop` is GitHub default | 0 |
| Branch model documented | 8 |

**Type consistency:** `calverForDate(date: Date): string` and
`formatVersion(calver: string, sha?: string | null): string` are defined in Task 2 and used with
those exact signatures in Tasks 3 and 4. `APP_VERSION: string` is defined in Task 2 and consumed
in Tasks 4 and 5. `StatusRow`'s `{ label, value, ok }` props in Task 5 match the existing
definition at the bottom of `settings/page.tsx`.

**Placeholder scan:** No TBDs. Every code step carries the literal content to write. The only
deferred item is branch protection in Task 0 Step 5, which is explicitly scoped out in the spec as
requiring the GitHub UI — and which cannot be configured until Task 7 creates the `verify` check
it would require.

**Ordering note:** Task 0 is repo administration and must be confirmed with the owner before it
runs, but it cannot be moved to the end — every subsequent task branches off `develop`, and the
Task 8 PR targets it.

**Known gap, accepted:** Task 1 Step 5 may surface pre-existing test failures. The plan instructs
recording rather than fixing them, because diagnosing unrelated failures inside a versioning PR
would violate the task boundary.
