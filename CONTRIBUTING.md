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
