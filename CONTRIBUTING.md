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

## Field encryption

`src/lib/encryption/fields.ts` (`ENCRYPTED_FIELDS`) is the **one** registry of which
columns are encrypted at rest (field-encryption spec, `docs/superpowers/specs/2026-09-30-field-encryption-design.md`,
D1). Making a new field sensitive — or adding a new sensitive field — needs **all** of:

1. A registry entry in `ENCRYPTED_FIELDS`.
2. A `String` column in `prisma/schema.base.prisma` (ciphertext is always text, even for
   a field that is logically a date or a number — see the `kind` discussion in
   `fields.ts`'s own comment).
3. A migration for both providers (see **Changing the schema** above).
4. The **same** entry mirrored into `ENCRYPTED_FIELDS` in `scripts/rotate-encryption-key.mjs`
   (it cannot import from `src/` — it runs as plain ESM, no bundler, inside the
   container). `scripts/rotate-encryption-key.test.ts` asserts byte-for-byte that the two
   lists are identical; forgetting the mirror fails that test, not the rotation itself.

A guard test in `src/lib/encryption/fields.test.ts` also fails if a registered field's
schema column is not `String`.

**Client order.** The app's Prisma client is assembled in exactly one place,
`src/lib/prisma.ts`: `base → encryption → audit`. The encryption extension
(`src/lib/encryption/extension.ts`) must sit **under** the audit extension
(`src/lib/audit/extension.ts`) — the audit layer's write capture sees ciphertext (not
plaintext) going in, because it wraps the already-encrypting client, but the row values
audit *reads back* (before/after a change, for the audit entry) come back decrypted,
because the read path runs back up through the encryption extension on its way out. The
stored audit `changes` are redacted (serial numbers and NFA fields never appear even
decrypted — see **Audit log** below).

**No raw SQL on an encrypted column.** `$queryRaw`/`$executeRaw` (and their `*Unsafe`
variants) bypass both extensions entirely, so a raw query naming an encrypted column
would read ciphertext as if it were plaintext, or write plaintext where the extension
would have encrypted it. A guard test in `fields.test.ts` scans all of `src/` and
`scripts/` for a registered field name within 10 lines of a raw SQL call and fails if it
finds one. The one-time startup migration (`src/lib/encryption/startup.ts`) and the
rotation script are the deliberate, reviewed exceptions — they use a **raw, unextended**
Prisma client (`createRawPrismaClient()` in `src/lib/prisma.ts`) precisely because they
must read and write the stored form itself.

**`core.mjs` is the only crypto code.** `src/lib/encryption/core.mjs` (plain ESM, with
`core.d.mts` beside it) holds every piece of actual cryptography: key parsing/loading,
HKDF subkey derivation, field encrypt/decrypt, the fingerprint, and backup seal/open.
The app (`allowJs` is on) and every CLI script (`scripts/rotate-encryption-key.mjs`,
test files) import this one file. Never add a second implementation of any of this —
not even a "simpler" version for a script.

**Reads are strict.** A non-null value in a registered column that does **not** start
with `bv2:` throws `EncryptedFieldDecryptError` with cause `PLAINTEXT_AT_REST`
(`src/lib/encryption/extension.ts`). The one-time startup migration runs on the raw
client before the app serves any request, so in practice nothing legitimate ever hits
this — a value that does is a bug (a missed write path), and it is meant to surface as
an error page, not silently store or return plaintext.

**The gated `RUN_SERVER_TESTS` test.** `src/app/api/backup/restore/route.c1.proxy-body-size.test.ts`
builds and starts a real server process to prove the request-body size cap actually
works end to end through Next's own proxy layer — too slow and heavy for the default
`npm test` run, so it's `describe.skipIf(!process.env.RUN_SERVER_TESTS)`, not a bare
`it.skip` (skipping the whole `describe` skips its expensive `beforeAll` too, not just
the assertion). CI's `verify` job sets `RUN_SERVER_TESTS=1` and runs it right after its
own `npm run build`, so the build is already current. Run it locally the same way:
```bash
RUN_SERVER_TESTS=1 npx vitest run src/app/api/backup/restore/route.c1.proxy-body-size.test.ts
```

**Prisma error logging is event-only.** Every Prisma client this app constructs
(`src/lib/prisma.ts`) uses `log: [{ emit: "event", level: "error" }]`, never the plain
`["error"]` string form — the string form makes Prisma print the full pretty-printed
failing query straight to stdout/stderr itself, which for a validation error is every
field of every row in the failing write. The `'error'` event handler logs only
`target` (an engine-internal component tag), never `message` (the unsafe string).

**The update scripts' line-ending override.** `update.sh` / `update.bat` can temporarily
mark `install.bat` / `update.bat` `-text` in `.git/info/attributes` so a line-ending-only
difference in the index doesn't block `git pull` (see README, "Upgrading to this
release"). Every line it adds carries the marker ` blackvault-update` at the end — not a
`#` comment, which Git rejects on a line with a trailing `#` token — and the very first
thing every run does is strip any such marked line (and any `.blackvault-update.*`
backup file) left behind by an earlier run that could not restore cleanly (power loss,
`SIGKILL`). The override must never outlive the script that added it.

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

## The connection gate

`gate/` is plain ESM JavaScript (`.mjs`), run directly by `node` — the Dockerfile's `CMD` runs
`node gate/gate.mjs` after `prisma migrate deploy`, not `npm start`. It owns the public port
inside the container, resets connections from untrusted peers before Next ever sees them, and
proxies everything else to Next's standalone server on `127.0.0.1:3001`. Its tests are vitest
`.test.ts` files beside the `.mjs` they cover (`gate/gate-core.test.ts`,
`gate/gate-server.test.ts`); run them with the usual `npm test`. `npm run dev` does not go
through the gate at all — the dev server binds its port directly, so gate behavior (trusted
proxies, direct access, connection resets) is only exercised in a built image. The gate reads
container-side env vars `PUBLIC_URL`,
`TRUSTED_PROXIES`, `ALLOW_DIRECT_ACCESS` and `DIRECT_ACCESS_INITIAL`, which `docker-compose.yml`
maps from the host-side `BLACKVAULT_PUBLIC_URL`, `BLACKVAULT_TRUSTED_PROXIES`,
`BLACKVAULT_ALLOW_DIRECT_ACCESS` and `BLACKVAULT_DIRECT_ACCESS_INITIAL` in `.env` — same
`BLACKVAULT_*`-prefix convention as the database vars above, for the same reason.

## Authentication

`src/lib/auth/*` are pure, DB-touching modules with no Next.js request/response types, so
they're unit-tested directly:

- `password.ts` — scrypt hash/verify (`hashPassword`, `verifyPassword`, and `dummyVerify` for
  a timing-safe "no such user" path). `password-policy.ts` holds the client-safe `PASSWORD_MIN`
  constant on its own, because `password.ts` imports `node:crypto` and must never end up in a
  client bundle.
- `tokens.ts` — INVITE/RESET/SETUP token create, hash and single-use redeem; `TOKEN_TTL_MS`
  (`INVITE` 7 days, `RESET` 24 hours; `SETUP` has no expiry but only one unused token exists at
  a time).
- `sessions.ts` — DB-backed sessions: `SESSION_COOKIE`, `createSession`, `validateSession`,
  `sessionCookie`, `endUserSessions`.
- `admins.ts` — admin user management; the last active admin can never be demoted or disabled.
- `setup-state.ts` — `hasAnyUser()`, cached forever once true (it can only go from false to
  true).
- `throttle.ts` — per-key login throttle (`createThrottle`): free failures, then exponential
  backoff capped at 15 minutes, never a hard lockout.
- `username.ts` — `normaliseUsername` (trim + lowercase) and username/display-name validation.
- `next-path.ts` — `safeNextPath`, the post-login redirect sanitiser (rejects `//`, `/\`,
  schemes, control characters).
- `route-helpers.ts` — shared plumbing for the `/api/auth/*` routes.

`src/lib/server/auth-gate.ts` exports `decideAuth`, the pure per-request policy function
(public paths, setup-required, login-required, admin-only) — no I/O, table-tested against
path kind × auth state. `src/proxy.ts` gathers the request's input and applies spec 1's
host/origin gate (`decideRequest`) first, then `decideAuth`, so a request must pass the
connection-level gate before authentication is even considered.

`src/lib/server/auth.ts` exports `getCurrentUser()` (wrapped in React `cache()`, which dedupes
calls within a single server-component render — but does nothing in a route handler, where every
call re-validates the session; see **Audit log** below for the per-request memo this motivated),
`requireAuth()` and `requireAdmin()`. `getCurrentUser` always re-validates the session cookie
against the database — it never trusts a header set by `proxy.ts`, so a request that somehow
reaches a route handler without going through the proxy still can't claim to be someone.

### Testing routes that require auth

Route tests mock `@/lib/server/auth` the same way other route tests mock Prisma:

```ts
vi.mock("@/lib/server/auth", () => ({
  requireAuth: vi.fn().mockResolvedValue(null),
}));
```

(see `src/app/api/images/upload/route.test.ts`). `requireAuth`/`requireAdmin` return `null`
to mean "authorized, keep going" and a `NextResponse` to mean "reject with this response" —
mock the return value accordingly to simulate a signed-out or non-admin caller.

## Audit log

`src/lib/audit/registry.ts` holds the single list of models the audit log records
(`AUDITED_MODELS`) and the ones it deliberately does not, each with a reason
(`AUDIT_EXCLUDED_MODELS`). A schema model that lands in neither list fails `registry.test.ts` —
the same shape of guard `src/lib/backup/models.ts` uses for the backup registry, so a new model
can never go silently unaudited.

Capture is automatic: `src/lib/audit/extension.ts` wraps the Prisma client and records every
create/update/delete/upsert on an audited model in the same transaction as the change, with the
acting user resolved *before* the transaction opens — resolving it from inside one would need the
database connection the transaction is already holding, which deadlocks on SQLite's
`connection_limit=1`. No route calls the extension directly.

- `withoutRowAudit(fn)` (`src/lib/audit/context.ts`) turns off automatic row auditing for
  everything `fn` does, including any transaction it opens. Restore uses it — it replaces every
  row and logs one `RESTORE` event afterward instead of one entry per row — and so does
  `scripts/reset-db.ts`.
- `recordEvent(client, { action, entityType?, entityId?, entityLabel?, changes? })`
  (`src/lib/audit/events.ts`) is the explicit call for security events the extension can't infer
  from a row write: logins/logouts, invites, role changes, enable/disable, reset links, password
  changes, the direct-access toggle, backups and restores. Pass the open transaction client to
  commit or roll the event back with the change it belongs to; `recordEventBestEffort` is the
  same call but never throws, for call sites whose main work already committed outside a
  transaction (an audit-write failure there must not turn an already-successful action into a
  500).

`src/lib/server/client-ip.ts` trusts only the **last** `X-Forwarded-For` value, and only when
`trustsForwardedHeaders()` is true (i.e. `TRUSTED_PROXIES` is set) — never the first value, which
is client-controlled, and never anything at all when no proxy is trusted.

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
