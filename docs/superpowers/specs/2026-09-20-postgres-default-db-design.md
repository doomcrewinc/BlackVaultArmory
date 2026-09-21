# Postgres as Default Database — Design Spec

**Date:** 2026-09-20
**Status:** Approved
**Epic:** B (depends on Epic A only for the vitest harness)

## Problem

1. SQLite has a single writer. The app works around this with
   `DATABASE_URL=...?connection_limit=1` in both compose files, and routes are written with
   comments like *"Sequential queries — connection_limit=1 means Promise.all would deadlock"*
   (`api/backup/route.ts:13`, `api/search/route.ts:16`). Concurrency is a standing constraint on
   how every route is written.
2. **Backup and restore silently destroy data.** The schema has 15 models; backup exports 12.
   `MaintenanceLog` and `BatteryChangeLog` — added in the two most recent commits (`423485`,
   `e991c37`) — are absent from both routes. Because restore calls
   `tx.firearm.deleteMany()` (`restore/route.ts:78`) and `tx.accessory.deleteMany()`
   (`restore/route.ts:76`), and both orphan models cascade off those parents, **restoring a
   backup deletes every maintenance and battery-change record and re-inserts none of them**,
   while reporting `success: true`.
3. `/api/search` lowercases the query and relies on `contains` (`search/route.ts:6`). SQLite's
   `LIKE` is ASCII-case-insensitive, so this works today. **Postgres's `LIKE` is case-sensitive**
   — the search would silently stop matching on capitalisation.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Engine | **PostgreSQL 17-alpine** | See below |
| Coexistence | One base schema, generated per-provider | User choice; verified cheap (see *Codegen is trivial*) |
| Migration direction | **SQLite → Postgres only, one-way** | User constraint |
| Loss tolerance | **Zero**, verified by per-model row-count assertion | User constraint |
| Backup bug | Fixed inside this epic | User choice |

### Why Postgres over MariaDB/MySQL

- **MariaDB/MySQL default to `_ci` collation**, which makes unique indexes case-insensitive.
  `Firearm.serialNumber @unique` would begin rejecting `abc123` as a duplicate of `ABC123` — a
  silent behaviour change on a serial-number field. SQLite today and Postgres are both
  case-sensitive here. Overriding needs raw-SQL collation clauses Prisma does not manage.
- **Prisma scalar lists (`String[]`) are Postgres-only.** The schema currently fakes two arrays
  as comma-separated strings (`compatibleCalibers`, `compatibleFirearmTypes`) with
  `.split(",")`/`.join(",")` across five call sites. Postgres leaves that door open; MariaDB
  closes it permanently.
- **`pg_trgm` + GIN accelerates the exact `contains '%glo%'` infix pattern** this app's search
  uses. MariaDB's FULLTEXT is word-boundary based and does not help that pattern.
- `mode: "insensitive"` in Prisma is Postgres-only.

arm64 images exist for all three (verified via `docker manifest inspect`), so architecture is
**not** a differentiator. Confidence in this recommendation: ~90%.

### Codegen is trivial — verified

A portability audit of `prisma/schema.prisma` found:

| Non-portable construct | Count |
|---|---|
| `@db.` native attributes | 0 |
| `Json` fields | 0 |
| `Decimal` fields | 0 |
| `Bytes` fields | 0 |
| **Scalar lists** (`String[]` etc.) | **0** |
| `enum` blocks | 0 |
| `autoincrement()` | 0 |

All 14 `[]` occurrences are *relation* lists, which are portable. Every PK is a `cuid()` string,
so **there are no sequences to resynchronise** — the usual sharpest edge of a SQLite→Postgres
migration does not exist here.

**Consequence:** the Postgres and SQLite schemas differ only in the `datasource.provider` line.
The model body is byte-identical. The generator is a ~20-line mechanical text transform, not a
dialect translator.

### Explicit non-goal: do not introduce `String[]` yet

Converting `compatibleCalibers`/`compatibleFirearmTypes` to real Postgres arrays would make the
two providers differ in *logical shape*, not just DDL, forcing every consumer to branch. That
defeats the point of a single base schema. **Keep them as comma-separated strings.** Revisit only
once SQLite support is retired.

### The app never loads two Prisma clients

A dual-client runtime would be the expensive part of multi-provider support. It is avoidable:
`DB_PROVIDER` selects **one** schema at build/startup, and only that client is generated. The app
keeps importing plain `@prisma/client` with no changes. Only `scripts/migrate-sqlite-to-postgres.ts`
needs both, and it generates the second client into a throwaway output directory on demand.

## Architecture

```
prisma/
  schema.base.prisma        <- SINGLE SOURCE OF TRUTH (edit this one)
  postgres/
    schema.prisma           <- GENERATED - do not edit
    migrations/             <- postgres migration history
  sqlite/
    schema.prisma           <- GENERATED - do not edit
    migrations/             <- existing 17 migrations move here
scripts/
  gen-prisma-schemas.ts     <- base -> both schemas
  migrate-sqlite-to-postgres.ts
src/lib/
  db/provider.ts            <- DB_PROVIDER resolution
  db/text-search.ts         <- containsInsensitive()
  backup/models.ts          <- BACKUP_MODELS: the anti-drift registry
```

### Anti-drift mechanism

The root cause of the data-loss bug is a **hand-maintained list of tables** in two route files.
The fix is a single shared registry, `src/lib/backup/models.ts`, that backup, restore, and the
migrator all iterate — plus a test that reads Prisma's DMMF and **fails if any model in the schema
is missing from the registry**. Adding a model to the schema without adding it to backup becomes a
red test rather than silent data loss.

### Deployment shape

`docker-compose.yml` becomes Postgres + app. `docker-compose.sqlite.yml` is the fallback. The
installer asks which, and generates `POSTGRES_PASSWORD` when Postgres is chosen. Two files rather
than compose profiles, because `depends_on: condition: service_healthy` cannot reference a service
that a profile has excluded.

## Migration runbook (user-facing)

1. Stop the app. **Take a backup first** (now that backup is complete).
2. Start Postgres: `docker compose up -d db`
3. `npm run migrate:to-postgres -- --dry-run` — prints per-model source counts
4. `npm run migrate:to-postgres` — copies, then asserts per-model counts match
5. Set `DB_PROVIDER=postgres` in `.env`, `docker compose up -d`
6. The old `vault.db` is left untouched on disk as a rollback artifact

The uploads volume is never touched — documents and images are files on disk referenced by path.

## Acceptance criteria

- [ ] `npm run gen:schemas` produces both schemas; both differ from the base **only** in the
      `provider` line.
- [ ] A test fails if `schema.base.prisma` and the generated schemas are out of sync.
- [ ] A test fails if any DMMF model is missing from `BACKUP_MODELS`.
- [ ] Backup output contains all 15 models' data (14 arrays + settings).
- [ ] Restoring a v1.0 backup (without the two new keys) succeeds, treating them as empty.
- [ ] Restoring a v1.1 backup round-trips `MaintenanceLog` and `BatteryChangeLog` intact.
- [ ] `/api/search` matches `Glock` when queried with `glock` on **both** providers.
- [ ] `docker compose up -d` starts Postgres + app, app waits for the DB healthcheck.
- [ ] `docker compose -f docker-compose.sqlite.yml up -d` still works.
- [ ] The migrator refuses a non-empty target without `--force`.
- [ ] The migrator aborts loudly on any per-model count mismatch.
- [ ] A full migration of a seeded SQLite DB reports zero mismatches across all 15 models.
