# BlackVault — project guide

BlackVault is a self-hosted inventory app (firearms, accessories, ammunition, gear, supplies,
kits, range sessions). People install it with Docker Compose through `install.sh` / `install.bat`
and update it with `update.sh` / `update.bat`. `README.md` is the user manual; `CONTRIBUTING.md`
is the developer manual and goes deeper than this file on every topic below.

## Stack

- Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, Vitest.
- Prisma 5 with **two providers**, PostgreSQL and SQLite. Every image ships both clients and
  both migration histories. The provider is `DB_PROVIDER` when set (anything but `sqlite` means
  postgres); when unset, a `file:` `DATABASE_URL` means SQLite and anything else PostgreSQL
  (`src/lib/db/provider.ts`, mirrored by `scripts/schema-path.js`).
- One compose file, `docker-compose.yml`. In `.env`, `COMPOSE_PROFILES=postgres` turns the `db`
  service on; with no profile only the app runs, on SQLite.
- Accounts, sessions and roles (`src/lib/auth`, `src/lib/server`, `src/proxy.ts`); an
  append-only audit log (`src/lib/audit`); field encryption at rest (`src/lib/encryption`);
  encrypted uploaded files (`src/lib/files`); JSON, sealed and full backups (`src/lib/backup`,
  `backup.sh`, `restore.sh` and their `.bat` twins).

## Commands

| Command | What it does |
|---|---|
| `./dev.sh` | Local setup without Docker: installs, writes a local `.env`, generates the clients, applies migrations, starts the dev server on http://localhost:3000. `--fresh`, `--studio`, `--help`. |
| `npm run dev` | The dev server alone (`next dev -H 0.0.0.0`). |
| `npm test` | `vitest run`. The timezone is pinned to America/Denver in `vitest.config.ts`; `TZ_OVERRIDE` is the only way to change it. |
| `npx vitest run <file>` | One test file. |
| `npm run typecheck` | `tsc --noEmit` against a baseline (`scripts/check-types.sh`): errors are allowed only in the files on its list, and a listed file that becomes clean must be taken off it. |
| `npm run lint` | ESLint. |
| `npm run build` | Generates both schemas and clients, applies the SQLite migrations to a build database, then `next build`. |
| `npm run build:scripts` | Bundles every `scripts/entry/<name>.ts` into `dist/scripts/<name>.mjs` (the CLIs that run inside the container). |
| `npm run gen:schemas` | Regenerates `prisma/postgres/schema.prisma` and `prisma/sqlite/schema.prisma` from `prisma/schema.base.prisma`. |
| `npm run db:generate` | Generates **both** Prisma clients. Always use this, never a single `prisma generate`. |
| `npm run db:deploy` | `prisma migrate deploy` for the provider the environment selects. |
| `npm run db:check-drift` | Checks that each provider's migrations produce its schema. PostgreSQL is checked only when `SHADOW_DATABASE_URL` is set (Prisma wipes that database). |
| `npm run test:pg-real-db` | Runs the real-database PostgreSQL test files, each in a database it creates and drops. Needs `PG_REAL_DB_ADMIN_URL`, a URL for a throwaway PostgreSQL server. |

`RUN_SERVER_TESTS=1 npx vitest run src/app/api/backup/restore/route.c1.proxy-body-size.test.ts`
runs the one test that needs a built app; `npm test` skips it.

## Where things live

- `src/app` — pages and API routes (`route.ts`). `src/components` — UI. `src/lib` — everything
  else. `@/` is `src/`. The app's Prisma client comes from `@/lib/prisma`.
- `prisma/schema.base.prisma` — the only schema file edited by hand. `prisma/sqlite/` and
  `prisma/postgres/` hold the generated schema and the migrations of each provider.
- `scripts/` — shell and batch helpers the installers source or call, the container
  entrypoint, the key-rotation CLI, and their tests. `scripts/entry/` — sources of the bundled
  CLIs. `scripts/ci/` — CI helpers and the Windows harness. `scripts/fixtures/` — frozen copies
  of old releases' scripts.
- `docs/superpowers/specs/` — design documents. `docs/superpowers/plans/` — implementation
  plans. Both are historical records: do not rewrite them.

## Rules

- **Crypto code lives only in `src/lib/encryption/core.mjs`.** One implementation, imported by
  the app and by every script; never a second one.
- **Routes do uploads I/O only through `src/lib/files/storage.ts`.** It is the one place that
  knows where files live and that they are encrypted at rest.
- **Pictures are processed only in `src/lib/images/process.ts`.** It strips the metadata and
  enforces the limits; no route or component calls `sharp` itself.
- **A photo's owner column is chosen only in `src/lib/photos/owner.ts`.** The public capture routes
  take the item from the pass, never from the request.
- **A schema change lands in both providers in the same PR**, following "Changing the schema"
  in `CONTRIBUTING.md`. A one-provider change ships a client that queries missing columns.
- **Env keys in `.env` and compose files use the `BLACKVAULT_` prefix.** Compose lets a shell
  variable override `.env`, and names like `DATABASE_URL` are commonly exported. Never use
  `${VAR:?}` in `docker-compose.yml`: it breaks the SQLite default.
- **`.bat` files are CRLF** (`.gitattributes`). cmd.exe resumes a running batch file by byte
  offset, so a converted file runs the wrong bytes. `git diff --stat` on a `.bat` must show only
  the lines you meant to change.
- **`update.bat`'s landing pad and its `git pull` line must not move.** Older copies of
  `update.bat` resume the new file at fixed byte offsets;
  `scripts/update-bat-landing-pad.test.ts` checks them. Read the comments in `update.bat` before
  editing anything above the `git pull` line.
- **Text shared between scripts is pinned by tests.** `install.bat` and `update.bat` carry
  identical subroutines, and the `.bat` files mirror the `.sh` ones. Change every copy together
  and run the `scripts/*.test.ts` files.
- **`scripts/fixtures/` is frozen.** The files are byte-for-byte copies of what old releases
  shipped; tests run them as the "old" script.
- **Never modify or delete `prisma/prisma/dev.db`.** It is the developer's own local database
  (`dev.sh` creates it). Use a scratch copy or a temporary database.
- **Code and scripts never put a secret (a backup passphrase, the encryption key) on a command
  line, in a log or in an error message, and a script never exports one that did not reach it
  that way.** Secrets travel through files and standard input. An install that keeps its key in
  `BLACKVAULT_ENCRYPTION_KEY` (in `.env` or the shell) is supported: Compose passes it to the
  container, and the scripts leave it where it is.
- **Comments describe the code as it is.** No task numbers, review labels or change history in
  shipped source; that belongs in commits and PRs.
- **Stage explicit paths.** Never `git add -A` or `git add .`.

## Branches and pull requests

- `develop` is the default branch and the integration trunk. `master` is production. Never
  commit to either directly. `V1.2` tracks the upstream repository: do not develop there.
- Branch off `develop` as `feat/<slug>`, `fix/<slug>`, `chore/<slug>` or `docs/<slug>`.
  Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `ci:`, `refactor:`, `test:`.
- This repository is a fork, and without `--repo` `gh` targets the upstream:

  ```bash
  gh pr create --repo doomcrewinc/BlackVaultArmory --base develop
  ```

- Every check must be green before a PR is merged. No branch protection rule enforces this; it
  is the convention. From `ci.yml`: `Lint, types and build`, both `Tests (...)` timezone legs,
  `Migration drift (sqlite + postgres)`, `Windows installer logic (Docker stubbed)`,
  `Encryption key on Linux Docker`, `Docker image builds`. From outside it (their own GitHub
  apps): `SonarCloud Code Analysis`, `code/snyk` and `security/snyk`.
- There are no release tags and no release branches. The version is CalVer plus a short sha
  (`2026.9.26-81f8b3a`), derived from the commit; merging to `develop` or `master` publishes an
  image. See "Versioning" and "Publishing" in `CONTRIBUTING.md`.
