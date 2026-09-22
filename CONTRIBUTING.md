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

## Changing the schema

Every image ships **both** Prisma clients and **both** migration histories: PostgreSQL (the
default) and SQLite (the fallback). A schema change must land in both, in the same PR.

1. Edit **only** `prisma/schema.base.prisma`. `prisma/postgres/schema.prisma` and
   `prisma/sqlite/schema.prisma` are generated; never edit them by hand.
2. Regenerate them:
   ```bash
   npm run gen:schemas
   ```
3. Create a migration for **each** provider, with the same name and timestamp:
   ```bash
   NAME=20260922120000_add_widget   # <UTC timestamp>_<snake_case_name>

   mkdir -p prisma/sqlite/migrations/$NAME
   npx prisma migrate diff \
     --from-migrations prisma/sqlite/migrations \
     --to-schema-datamodel prisma/sqlite/schema.prisma \
     --shadow-database-url "file:$(mktemp -d)/shadow.db" \
     --script > prisma/sqlite/migrations/$NAME/migration.sql

   # needs a scratch PostgreSQL database; Prisma wipes it (its name must contain shadow, scratch or test)
   mkdir -p prisma/postgres/migrations/$NAME
   npx prisma migrate diff \
     --from-migrations prisma/postgres/migrations \
     --to-schema-datamodel prisma/postgres/schema.prisma \
     --shadow-database-url "$SHADOW_DATABASE_URL" \
     --script > prisma/postgres/migrations/$NAME/migration.sql
   ```
   Read both files. Hand-edit them where the diff cannot know your intent (renames, backfills).
4. Run the drift check. It must pass for **both** providers before you open the PR:
   ```bash
   SHADOW_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/blackvault_shadow npm run db:check-drift
   ```
   Without `SHADOW_DATABASE_URL` it checks SQLite only and says it skipped PostgreSQL. Prisma
   **wipes** the shadow database, so the check refuses a `SHADOW_DATABASE_URL` that equals
   `DATABASE_URL` or `POSTGRES_URL`, or whose database name does not contain `shadow`, `scratch`
   or `test`.

**Why both.** At startup the container runs `prisma migrate deploy` for its own provider only.
A SQLite migration without its PostgreSQL twin passes every SQLite test, then ships a client
that queries columns the PostgreSQL database does not have: runtime errors for every
PostgreSQL user (and the reverse for SQLite users). The drift check fails when a provider's
migration history does not produce its schema.

## Docker Compose

There is **one** production compose file, `docker-compose.yml`, and plain `docker compose` (no
`-f`) is correct for every install. `.env` chooses the database: `COMPOSE_PROFILES=postgres` turns
on the `db` service, and with no profile only the app runs, on SQLite.

That is deliberate. The `update.sh` already on users' machines runs `git pull` and then a bare
`docker compose build --pull` / `up -d`. Bash keeps executing the old copy of the script, so
those calls read whatever `docker-compose.yml` says after the pull. An existing SQLite install has
a `.env` with only `DATA_DIR` and `PORT`, so a bare `docker compose` with no `.env` changes must
keep meaning SQLite, forever. Keep it that way:

- **Never use `${VAR:?message}` in `docker-compose.yml`.** Compose interpolates it even for a
  service whose profile is off, so a required `POSTGRES_PASSWORD` fails the SQLite default before
  anything starts. Use `${VAR:-default}`. An empty `POSTGRES_PASSWORD` with the profile on makes
  the postgres container itself refuse to start, which is loud enough.
- The app's `depends_on: db` must keep `required: false`, or SQLite installs fail to start.
- Every app setting that differs by provider comes from `.env` with a SQLite default
  (`DB_PROVIDER=${DB_PROVIDER:-sqlite}`, `DATABASE_URL=${DATABASE_URL:-file:...}`).
- Check both shapes before merging a compose change:
  ```bash
  docker compose --env-file /dev/null config --services     # as if no .env: blackvault only
  docker compose --env-file postgres.env config --services  # a Postgres .env: db, blackvault
  ```
- `docker-compose.migrate.yml` is only an overlay for the SQLite -> PostgreSQL copy, and
  `docker-compose.dev.yml` is only for development.

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

> **Note on the no-direct-commits rule.** The release stamp commit on `develop` and the
> `develop` → `master` merge are the documented exception to it. If you enable branch
> protection requiring the `verify` check on those branches, the release operator needs
> permission to bypass it — otherwise route the stamp through a `chore/release-<calver>`
> PR and merge `develop` → `master` via PR as well.

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
