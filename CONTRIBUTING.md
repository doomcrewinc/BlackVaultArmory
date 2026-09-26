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

We do **not** use `release/` branches, and there are no release tags. Publishing is continuous:
a `--no-ff` merge of `develop` into `master` publishes `:latest` by itself. See **Publishing**.
Cut a `release/<calver>` branch only if `develop` must keep moving during a long stabilization
window.

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
3. Add an **incremental** SQLite migration. That history is append-only: SQLite installs
   shipped long before PostgreSQL was an option here.
   ```bash
   NAME=20260922120000_add_widget   # <UTC timestamp>_<snake_case_name>

   mkdir -p prisma/sqlite/migrations/$NAME
   npx prisma migrate diff \
     --from-migrations prisma/sqlite/migrations \
     --to-schema-datamodel prisma/sqlite/schema.prisma \
     --shadow-database-url "file:$(mktemp -d)/shadow.db" \
     --script > prisma/sqlite/migrations/$NAME/migration.sql
   ```
   Read the file. Hand-edit it where the diff cannot know your intent (renames, backfills).
4. Regenerate the **squashed** PostgreSQL baseline in place. PostgreSQL has exactly one
   migration, `prisma/postgres/migrations/0_init`, rewritten from empty on every schema
   change. Do **not** add an incremental folder beside it — an incremental migration against
   a squashed baseline makes the two histories disagree silently.
   ```bash
   npx prisma migrate diff \
     --from-empty \
     --to-schema-datamodel prisma/postgres/schema.prisma \
     --script > prisma/postgres/migrations/0_init/migration.sql
   ```
   No shadow database is needed here: `--from-empty` replays no history.

   > ⚠️ **Rewriting `0_init` in place is only safe while no user has applied it.**
   > `prisma migrate deploy` stores a checksum per applied migration, so once someone has
   > applied `0_init`, changing it fails their next update with a checksum mismatch and leaves
   > their database stuck until they intervene by hand. There is no tag to hang this on any
   > more: `install.sh`/`update.sh` build from the working tree, so the window closes the moment
   > a PostgreSQL-capable `master` is pullable — which continuous publishing makes immediate.
   > Treat `0_init` as frozen, and make every PostgreSQL change its own timestamped migration — `--from-migrations prisma/postgres/migrations`
   > with a scratch `--shadow-database-url` (Prisma wipes it; its name needs `shadow`,
   > `scratch` or `test` as a word) instead of `--from-empty`. Check `git tag` first.
5. Regenerate **both** Prisma clients:
   ```bash
   npm run db:generate
   ```
   Use this, not a single `prisma generate --schema prisma/sqlite/schema.prisma`. The
   date-only guard in `src/lib/date-migration.ts` imports `Prisma` from `@prisma/client`,
   which is the **PostgreSQL** client, and derives the set of `DateTime` columns it audits
   from that DMMF. Generating only the SQLite client leaves `@prisma/client` stale, so the
   guard keeps auditing the previous schema and a newly added date column passes unnoticed —
   the guard reports green while seeing nothing. `db:generate` runs both.

6. Run the drift check. It must pass for **both** providers before you open the PR:
   ```bash
   SHADOW_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/blackvault_shadow npm run db:check-drift
   ```
   Without `SHADOW_DATABASE_URL` it checks SQLite only and says it skipped PostgreSQL. Prisma
   **wipes** the shadow database, so the check refuses a `SHADOW_DATABASE_URL` that equals
   `DATABASE_URL` or `POSTGRES_URL`, or whose database name does not have `shadow`, `scratch` or
   `test` as a whole word split by `_` or `-` (`blackvault_shadow`, `test_db` and `scratch` pass;
   `latest` and `contest` do not).

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
  service whose profile is off, so a required `BLACKVAULT_POSTGRES_PASSWORD` fails the SQLite
  default before anything starts. Use `${VAR:-default}`. An empty `BLACKVAULT_POSTGRES_PASSWORD`
  with the profile on makes the postgres container itself refuse to start, which is loud enough.
- The app's `depends_on: db` must keep `required: false`, or SQLite installs fail to start.
  `required` needs Docker Compose 2.20+, so `require_compose` in `scripts/compose-provider.sh`
  (mirrored as `:require_compose` in both `.bat` files) refuses anything older before touching
  anything. Raise `COMPOSE_MIN_VERSION` there, and in the batch mirror, if the file ever needs a
  newer Compose feature.
- Every app setting that differs by provider comes from `.env` with a SQLite default
  (`DB_PROVIDER=${BLACKVAULT_DB_PROVIDER:-sqlite}`,
  `DATABASE_URL=${BLACKVAULT_DATABASE_URL:-file:...}`).
- **Never interpolate a generic name** (`${DATABASE_URL}`, `${DB_PROVIDER}`,
  `${POSTGRES_PASSWORD}`) in a compose file. Compose lets a variable exported in the user's shell
  override `.env`, and many machines export `DATABASE_URL` for Prisma. A relative `file:` URL
  there gives the container a healthy, **empty** database in its writable layer, and every write
  is lost on recreate. The `.env` keys are `BLACKVAULT_*` so nothing else sets them; compose maps
  them to the generic names inside the container, so app code keeps reading `DATABASE_URL` and
  `DB_PROVIDER`. This must print nothing:
  ```bash
  grep -rnE '\$\{(DATABASE_URL|DB_PROVIDER|POSTGRES_PASSWORD)' docker-compose*.yml
  ```
  `DATA_DIR`, `PORT` and `COMPOSE_PROFILES` keep their names: every existing install's `.env`
  uses the first two, and the third is Compose's own.
- Check both shapes before merging a compose change:
  ```bash
  docker compose --env-file /dev/null config --services     # as if no .env: blackvault only
  docker compose --env-file postgres.env config --services  # a Postgres .env: db, blackvault
  ```
- `docker-compose.migrate.yml` is only an overlay for the SQLite -> PostgreSQL copy, and
  `docker-compose.dev.yml` is only for development.

## Versioning

CalVer `YYYY.M.D` plus a short sha, e.g. `2026.9.26-81f8b3a`.

- The version is **derived, not stamped**. `scripts/ci/derive-image-tags.sh` builds it from the
  **commit date** (UTC, no leading zeros — the same rule as `calverForDate` in
  `src/lib/version.ts`) and the commit's sha7. There is nothing to bump by hand.
- Deriving it from the commit date, rather than from the wall clock at build time, is what makes
  a re-run of a failed workflow produce the *same* immutable tag instead of minting a second one
  for unchanged code.
- That one string is both the image tag and the `APP_VERSION` build arg, so the version the
  Settings page and `/api/health` report is always an image tag you can pull. Do not introduce a
  second source for it.
- `package.json`'s `version` field is npm metadata only. Nothing reads it at runtime.

**No leading zeros.** `2026.9.20` is valid; `2026.09.20` is not valid semver and npm will reject
it. The derive script strips them.

## Publishing

There is no release ritual and there are no release tags. **Merging is publishing.**

| Push to  | Publishes                                              |
| -------- | ------------------------------------------------------ |
| `master` | `ghcr.io/doomcrewinc/blackvaultarmory:latest` + `:<calver>-<sha7>` |
| `develop`| `ghcr.io/doomcrewinc/blackvaultarmory:develop` + `:<calver>-<sha7>` |

Every build pushes the immutable `:<calver>-<sha7>`, so any deploy can be pinned to an exact
commit and rolled back to one. `.github/workflows/publish.yml` builds `linux/amd64,linux/arm64`.

A push to any other ref publishes **nothing**: the derive script has no default arm and exits 1
on an unmapped ref, and `:latest` is produced in exactly one place — the `master` arm of
`floating_tag_for`. A redundant assertion in `derive()` re-checks the result, so a careless edit
to that case statement fails the build instead of overwriting the tag every installed user pulls.
Both halves are covered by `scripts/ci/derive-image-tags.test.ts`, including a mutation test.

To see what a branch would push, without a runner:

```bash
bash scripts/ci/derive-image-tags.sh master "$(git rev-parse HEAD)"
bash scripts/ci/derive-image-tags.sh develop "$(git rev-parse HEAD)"
```

`publish.yml` does **not** set `cancel-in-progress`. It pushes a multi-arch manifest, and
cancelling between the amd64 push, the arm64 push and the manifest list leaves ghcr.io holding
unreferenced blobs or a `latest` pointing at a half-written list. The concurrency group is
per-ref, so successive merges to the same branch queue rather than race. Note that GitHub still
drops a *pending* run when a newer one queues behind the same group: a commit sandwiched between
two rapid merges may not get an image. Re-run its workflow run from the Actions tab if you need
one.

To promote `develop` to a published `:latest`, merge it:

```bash
git checkout master && git pull
git merge --no-ff develop
git push origin master
```

> **Note on the no-direct-commits rule.** The `develop` -> `master` merge is the documented
> exception to it. If you enable branch protection requiring the `verify` check on those
> branches, the operator needs permission to bypass it — otherwise merge `develop` -> `master`
> via PR as well.

## Hotfixes

```bash
git checkout master && git pull
git checkout -b hotfix/<slug>
# ...fix, commit...
gh pr create --base master --title "hotfix: <slug>"
# merging it publishes :latest; port it back so develop does not regress:
git checkout develop && git pull && git merge master && git push origin develop
```

## Syncing with upstream

```bash
git fetch upstream
git checkout V1.2 && git merge --ff-only upstream/V1.2 && git push origin V1.2
git checkout develop && git merge V1.2      # resolve conflicts here, never on V1.2
```
