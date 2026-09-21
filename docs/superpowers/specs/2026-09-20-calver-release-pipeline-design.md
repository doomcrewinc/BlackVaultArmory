# CalVer Release Pipeline — Design Spec

**Date:** 2026-09-20
**Status:** Approved
**Epic:** A (independent of Epic B — Postgres default DB)

## Problem

1. The fork versions with semver (`package.json` = `blackvault-temp` / `0.1.0`). We are
   abandoning semver for CalVer + short sha.
2. There is no released version visible anywhere at runtime. Users reporting bugs cannot say
   what they are running.
3. `.github/workflows/docker.yml` triggers on *push to `V1.2`* and pushes to
   `ghcr.io/theaveragedeveloper/projectblackvault` — the **upstream owner's namespace**. From
   this fork that build fails. It must be retargeted before any push lands.
4. All work commits directly to `V1.2`, which is also the default branch. No PR gate, no CI
   boundary, no release tags.
5. `vitest.config.ts` and three `*.test.ts` files exist, but **vitest is not a dependency and
   there is no `test` script** — the suite cannot run. Both epics need a working test harness.

## Decisions

| Decision | Choice |
|---|---|
| Version format | `YYYY.M.D-sha7` |
| `package.json.version` | CalVer only, e.g. `2026.9.20` |
| Git tag | `v2026.9.20` |
| Docker tags | `2026.9.20-e991c37`, `2026.9.20`, `latest` |
| Runtime display | `2026.9.20-e991c37` |
| Branch model | git-flow: `master` + `develop`, `V1.2` retained to track upstream |
| GitHub default branch | `develop` |
| Release trigger | Git tag push `v*`, not branch push |

### Why no leading zeros

`2026.09.20` is **invalid semver** — the spec forbids leading zeros in numeric identifiers, and
npm will reject it for several operations. `2026.9.20` is valid and parses as
major=2026, minor=9, patch=20. The `-e991c37` suffix is a legal semver prerelease tag, but we
keep it **out of `package.json`** so the file changes only on release, not on every commit.

Docker tags disallow `+`, so semver build metadata (`+sha`) is unusable; we use `-sha`.

### Version data flow

```
git tag v2026.9.20 ─┬─> package.json.version = "2026.9.20"   (stamped by release script)
                    └─> CI: APP_VERSION build-arg = "2026.9.20-<sha7>"
                           └─> Dockerfile ENV NEXT_PUBLIC_APP_VERSION
                                  └─> src/lib/version.ts APP_VERSION
                                         ├─> GET /api/health  { version }
                                         └─> Settings page footer
```

Outside Docker (`npm run dev`), `NEXT_PUBLIC_APP_VERSION` is unset and the version resolves to
`dev`. That is intentional and must not crash.

## Scope

**In:**
- `vitest` + `test` script so the existing three test files run.
- `src/lib/version.ts` — pure, testable version formatting.
- `scripts/stamp-version.ts` — writes today's CalVer into `package.json`.
- `/api/health` returns `version`.
- Settings page shows the running version.
- `Dockerfile` accepts `APP_VERSION` build-arg.
- `.github/workflows/docker.yml` retargeted + split into CI (lint/build/test on PR and on push to
  `develop`/`master`) and release (build/push on tag).
- `CONTRIBUTING.md` documenting the branch model.
- `master` and `develop` created; `develop` set as the GitHub default branch.

**Out (explicit non-goals):**
- Changelog generation. Later, if wanted.
- Branch protection rules — requires GitHub settings UI, noted as a manual step.
- Renaming the package from `blackvault-temp` is **in scope** (trivial, same file).
- Any database change — that is Epic B.

## Branch model

git-flow, with branch prefixes deliberately matching the conventional-commit prefixes already in
this repo's history (`feat/` rather than git-flow's canonical `feature/`), so a branch name and
its commit prefix always agree.

```
master           production. Only ever receives merges from develop (or a hotfix). Tagged.
develop          integration trunk. GitHub default branch. All feature PRs land here.
V1.2             retained, tracks upstream theaveragedeveloper/BlackVaultArmory

feat/<slug>      off develop  -> PR into develop
fix/<slug>       off develop  -> PR into develop
chore/<slug>     off develop  -> PR into develop
docs/<slug>      off develop  -> PR into develop
hotfix/<slug>    off master   -> PR into master, then merged back to develop

v<calver>        release tag, created on master; tag push triggers the Docker publish
```

**No `release/` branches.** Releases are a `--no-ff` merge of `develop` into `master` followed by
a tag. A `release/` branch is only worth cutting if `develop` must keep moving during a long
stabilization window, which does not apply to a solo repo. Documented as available, not standard.

`hotfix/` is retained because production fixes genuinely need to branch from `master` rather than
from whatever unreleased work sits on `develop`.

### Why `develop` is the GitHub default

PRs default to the repository's default branch. With `master` as default, nearly every PR would
open against the wrong base and need manual redirection. Setting `develop` as default makes the
common case correct and the rare case (a hotfix) the one requiring an explicit `--base master`.

## Acceptance criteria

- [ ] `npm test` runs and the three pre-existing test files execute.
- [ ] `GET /api/health` returns `{ status, timestamp, version }`.
- [ ] Settings page displays the running version string.
- [ ] `npm run dev` with no `APP_VERSION` shows `dev` and does not crash.
- [ ] `docker build --build-arg APP_VERSION=2026.9.20-abc1234 .` produces an image whose
      `/api/health` reports that exact string.
- [ ] CI workflow references only `ghcr.io/doomcrewinc/blackvaultarmory`.
- [ ] Pushing a PR runs lint + build + test and pushes **no** image.
- [ ] Pushing to `develop` or `master` runs CI and pushes **no** image.
- [ ] Pushing tag `v2026.9.20` publishes three Docker tags.
- [ ] `master` and `develop` both exist on the remote; `develop` is the GitHub default.
