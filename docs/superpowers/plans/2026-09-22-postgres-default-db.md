# Postgres Default Database Implementation Plan (revised)

> **Supersedes `2026-09-20-postgres-default-db.md`.** That plan generated one Prisma client at build
> time while users pick a provider at runtime, so a single image could not serve both — and its
> Docker build would have failed outright.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PostgreSQL as the default database with SQLite as a fallback, from one base schema and
one Docker image; a verified one-way SQLite→Postgres migrator; and the backup/restore data-loss fix.

**Architecture:** `prisma/schema.base.prisma` is the only hand-edited schema. Codegen emits
`prisma/postgres/schema.prisma` (default client output — so `@prisma/client` *is* the Postgres
client) and `prisma/sqlite/schema.prisma` (client output `node_modules/.prisma/client-sqlite`).
Both clients are generated into every build. `src/lib/prisma.ts` is the only file that chooses,
by `DB_PROVIDER`. Builds always prerender against SQLite.

**Tech Stack:** Next.js 16, Prisma 5.22, PostgreSQL 17-alpine, SQLite, vitest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-20-postgres-default-db-design.md` — **read its
REVISED 2026-09-22 block first**; it overrides the body where they conflict.

## Global Constraints

- **Migration is one-way:** SQLite → Postgres only. **Zero data loss, verified** by per-model
  row-count assertion; any mismatch exits non-zero.
- **Do not introduce `String[]`.** Both providers keep an identical logical shape.
- Only `prisma/schema.base.prisma` is hand-edited; the two generated schemas carry a DO-NOT-EDIT
  banner and are committed.
- The **running process instantiates exactly one** Prisma client. `src/lib/prisma.ts` alone chooses.
- `DB_PROVIDER` defaults to `postgres` for any unset or unrecognised value.
- **Builds prerender against SQLite** — compiling must never require a running Postgres.
- `@prisma/client` is the Postgres client and the canonical type source. Do not change the five
  existing `@prisma/client` imports.
- Scripts importing from `src/` use `npx ts-node --compiler-options '{"module":"CommonJS"}'`.
  **Never** `--project tsconfig.json` — it fails with `ERR_MODULE_NOT_FOUND`.
- Never `prisma db push`. Never `prisma migrate dev` against a database you care about.
- Prisma queries against SQLite stay sequential (`connection_limit=1` deadlocks `Promise.all`).
- **GitHub Actions is disabled.** Do not edit workflows. Verify lint/test/build locally.
- Branch `feat/postgres-default`, stacked on `chore/dev-sh-migrate-deploy` (PR #6). PR into
  `develop` once #6 merges. `gh` needs `--repo doomcrewinc/BlackVaultArmory`.

---

## Task 1: Base schema, codegen, and both migration histories

**Files:** Create `prisma/schema.base.prisma` (from `prisma/schema.prisma`),
`src/lib/db/schema-codegen.ts`, `src/lib/db/schema-codegen.test.ts`, `scripts/gen-prisma-schemas.ts`,
`prisma/postgres/migrations/0_init/migration.sql`, `prisma/postgres/migrations/migration_lock.toml`.
Move `prisma/migrations/` → `prisma/sqlite/migrations/`. Delete `prisma/schema.prisma`.

**Produces:** `PROVIDERS`, `PROVIDER_PLACEHOLDER`, `OUTPUT_PLACEHOLDER`,
`renderSchema(base: string, dir: ProviderDir): string`, `npm run gen:schemas`.

- [ ] **Step 1: Write the failing test** — `src/lib/db/schema-codegen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { OUTPUT_PLACEHOLDER, PROVIDERS, PROVIDER_PLACEHOLDER, renderSchema } from "./schema-codegen";

const ROOT = path.join(__dirname, "..", "..", "..");
const base = `generator client {\n  provider = "prisma-client-js"\n  ${OUTPUT_PLACEHOLDER}\n}\n\ndatasource db {\n  provider = "${PROVIDER_PLACEHOLDER}"\n}\n`;

describe("renderSchema", () => {
  it("sets the postgres provider and leaves the client at the default location", () => {
    const out = renderSchema(base, "postgres");
    expect(out).toContain('provider = "postgresql"');
    expect(out).not.toMatch(/^\s*output\s*=/m);
  });

  it("sets the sqlite provider and a separate client output", () => {
    const out = renderSchema(base, "sqlite");
    expect(out).toContain('provider = "sqlite"');
    expect(out).toContain('output   = "../../node_modules/.prisma/client-sqlite"');
  });

  it("leaves no placeholder behind", () => {
    for (const dir of Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>) {
      const out = renderSchema(base, dir);
      expect(out).not.toContain(PROVIDER_PLACEHOLDER);
      expect(out).not.toContain(OUTPUT_PLACEHOLDER);
    }
  });

  it("prepends a do-not-edit banner", () => {
    expect(renderSchema(base, "sqlite")).toContain("DO NOT EDIT");
  });

  it("throws when a placeholder is missing", () => {
    expect(() => renderSchema('datasource db { provider = "sqlite" }', "sqlite")).toThrow(/placeholder/i);
  });
});

describe("generated schemas on disk", () => {
  const real = fs.readFileSync(path.join(ROOT, "prisma", "schema.base.prisma"), "utf8");

  for (const dir of Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>) {
    it(`prisma/${dir}/schema.prisma is in sync with the base`, () => {
      const onDisk = fs.readFileSync(path.join(ROOT, "prisma", dir, "schema.prisma"), "utf8");
      expect(onDisk).toBe(renderSchema(real, dir));
    });
  }

  it("the base declares no scalar lists", () => {
    expect(real).not.toMatch(/\s(String|Int|Float|Boolean|DateTime)\[\]/);
  });
});
```

- [ ] **Step 2:** Run `npm test -- src/lib/db/schema-codegen.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/db/schema-codegen.ts`:

```ts
/**
 * Emits per-provider Prisma schemas from prisma/schema.base.prisma.
 *
 * The providers differ only in the datasource line and the client output path.
 * Postgres keeps the default output, so `@prisma/client` IS the Postgres client
 * and the canonical type source. SQLite writes to a separate folder so both
 * clients can ship in one image. This is a text substitution, not a dialect
 * translation — keep it that way.
 */

export const PROVIDER_PLACEHOLDER = "__PROVIDER__";
export const OUTPUT_PLACEHOLDER = "// __OUTPUT__";

export const PROVIDERS = {
  postgres: { provider: "postgresql", output: null },
  sqlite: { provider: "sqlite", output: "../../node_modules/.prisma/client-sqlite" },
} as const;

export type ProviderDir = keyof typeof PROVIDERS;

const BANNER = [
  "// ─────────────────────────────────────────────────────────────",
  "// GENERATED FILE — DO NOT EDIT.",
  "// Source:     prisma/schema.base.prisma",
  "// Regenerate: npm run gen:schemas",
  "// ─────────────────────────────────────────────────────────────",
  "",
  "",
].join("\n");

export function renderSchema(base: string, dir: ProviderDir): string {
  for (const placeholder of [PROVIDER_PLACEHOLDER, OUTPUT_PLACEHOLDER]) {
    if (!base.includes(placeholder)) {
      throw new Error(`schema.base.prisma is missing the ${placeholder} placeholder`);
    }
  }
  const { provider, output } = PROVIDERS[dir];
  const outputLine = output ? `output   = "${output}"` : "";
  return (
    BANNER +
    base
      .split(PROVIDER_PLACEHOLDER).join(provider)
      .split(OUTPUT_PLACEHOLDER).join(outputLine)
  );
}
```

- [ ] **Step 4: Create the base schema.** `git mv prisma/schema.prisma prisma/schema.base.prisma`.
  In it, change the datasource `provider = "sqlite"` to `provider = "__PROVIDER__"`, and add
  `  // __OUTPUT__` as the last line inside the `generator client { }` block. Change nothing else.

- [ ] **Step 5: CLI** — `scripts/gen-prisma-schemas.ts`:

```ts
import fs from "fs";
import path from "path";
import { PROVIDERS, renderSchema, type ProviderDir } from "../src/lib/db/schema-codegen";

const root = path.join(__dirname, "..");
const base = fs.readFileSync(path.join(root, "prisma", "schema.base.prisma"), "utf8");

for (const dir of Object.keys(PROVIDERS) as ProviderDir[]) {
  const out = path.join(root, "prisma", dir, "schema.prisma");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderSchema(base, dir), "utf8");
  console.log(`wrote prisma/${dir}/schema.prisma`);
}
```

  Add to `package.json` scripts:
  `"gen:schemas": "npx ts-node --compiler-options '{\"module\":\"CommonJS\"}' scripts/gen-prisma-schemas.ts",`

- [ ] **Step 6: Migration histories.**

```bash
mkdir -p prisma/sqlite && git mv prisma/migrations prisma/sqlite/migrations
npm run gen:schemas
mkdir -p prisma/postgres/migrations/0_init
npx prisma migrate diff --from-empty \
  --to-schema-datamodel prisma/postgres/schema.prisma --script \
  > prisma/postgres/migrations/0_init/migration.sql
printf '# Please do not edit this file manually\nprovider = "postgresql"\n' \
  > prisma/postgres/migrations/migration_lock.toml
```

  `migrate diff --from-empty` needs no database. Inspect the SQL: it must create all 16 tables.

- [ ] **Step 7:** `npm test -- src/lib/db/schema-codegen.test.ts` → PASS. Confirm
  `./dev.sh --fresh --setup-only` still works (it auto-detects `prisma/sqlite/schema.prisma`).

- [ ] **Step 8: Commit** — `feat: generate per-provider prisma schemas from a single base schema`

---

## Task 2: Provider resolution, both clients, and the one switch

**Files:** Create `src/lib/db/provider.ts`, `src/lib/db/provider.test.ts`, `scripts/schema-path.js`.
Modify `src/lib/prisma.ts`, `package.json`, `.gitignore`.

**Produces:** `DbProvider`, `resolveProvider(raw)`, `DB_PROVIDER`; both clients generated.

- [ ] **Step 1: Provider** — write tests first (unset/empty/garbage → `postgres`; `sqlite`,
  `SQLite`, `" sqlite "` → `sqlite`; `postgres`/`postgresql` → `postgres`), confirm FAIL, then:

```ts
export type DbProvider = "postgres" | "sqlite";

/** Anything but an explicit "sqlite" is postgres: a typo must never silently fall back to SQLite. */
export function resolveProvider(raw: string | undefined): DbProvider {
  return raw?.trim().toLowerCase() === "sqlite" ? "sqlite" : "postgres";
}

export const DB_PROVIDER: DbProvider = resolveProvider(process.env.DB_PROVIDER);
```

- [ ] **Step 2: `scripts/schema-path.js`** (plain JS, runs before deps are wired):

```js
const provider = (process.env.DB_PROVIDER || "").trim().toLowerCase();
process.stdout.write(`prisma/${provider === "sqlite" ? "sqlite" : "postgres"}/schema.prisma`);
```

- [ ] **Step 3: Scripts** — in `package.json`, replace `"build"` and add helpers:

```json
    "db:generate": "prisma generate --schema prisma/postgres/schema.prisma && prisma generate --schema prisma/sqlite/schema.prisma",
    "db:deploy": "prisma migrate deploy --schema $(node scripts/schema-path.js)",
    "build": "npm run gen:schemas && npm run db:generate && DB_PROVIDER=sqlite DATABASE_URL=${BUILD_DATABASE_URL:-file:$PWD/prisma/prisma/build.db} prisma migrate deploy --schema prisma/sqlite/schema.prisma && DB_PROVIDER=sqlite DATABASE_URL=${BUILD_DATABASE_URL:-file:$PWD/prisma/prisma/build.db} next build",
```

  The build prerenders against a throwaway `build.db` so it never touches `dev.db` and never needs
  Postgres. Confirm `prisma/prisma/*.db` in `.gitignore` covers `build.db`.

- [ ] **Step 4: The switch** — replace `src/lib/prisma.ts`:

```ts
import type { PrismaClient } from "@prisma/client";
import { resolveProvider } from "@/lib/db/provider";

/**
 * Both Prisma clients ship in the image; this is the only place that chooses.
 * `@prisma/client` is the Postgres client and the canonical type source — the
 * SQLite client is generated from a schema with identical models, so it is
 * structurally the same type.
 */
function loadPrismaClient(): new (options?: object) => PrismaClient {
  if (resolveProvider(process.env.DB_PROVIDER) === "sqlite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(".prisma/client-sqlite").PrismaClient;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@prisma/client").PrismaClient;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new (loadPrismaClient())({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```

  **Known risk:** Next's bundler may try to bundle `.prisma/client-sqlite` instead of loading it at
  runtime. If `next build` or the running server cannot resolve it, add the path to
  `serverExternalPackages` in `next.config.ts`, or load it through `createRequire` — and **say
  which you needed**. Do not declare this done until Step 5 passes.

- [ ] **Step 4b: `dev.sh` must generate BOTH clients.** It currently runs
  `npx prisma generate --schema "$SCHEMA"`, which generates only the active provider's client. In
  SQLite mode that would never generate `@prisma/client` — the canonical type source — so the app
  would not type-check. Replace that line with `npm run db:generate >/dev/null`, keep the
  `ok "Prisma client generated"` line, and confirm `shellcheck dev.sh` stays clean.

  Note: between Task 1's commit and this one, the app is not runnable (the SQLite client moved but
  `prisma.ts` still imports the default path). Tasks 1 and 2 land together; do not ship Task 1 alone.

- [ ] **Step 5: Prove both clients work from a real build.**

```bash
./dev.sh --setup-only && npm run build
# SQLite:
DB_PROVIDER=sqlite DATABASE_URL="file:$PWD/prisma/prisma/dev.db" npx next start -p 3101 &
sleep 8; curl -s localhost:3101/api/stats | head -c 200; echo; pkill -f "next start -p 3101"
# Postgres:
docker run -d --name bv-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=blackvault \
  -e POSTGRES_DB=blackvault -p 55432:5432 postgres:17-alpine
sleep 6
PGURL="postgresql://blackvault:dev@127.0.0.1:55432/blackvault"
DATABASE_URL="$PGURL" npx prisma migrate deploy --schema prisma/postgres/schema.prisma
DB_PROVIDER=postgres DATABASE_URL="$PGURL" npx next start -p 3102 &
sleep 8; curl -s localhost:3102/api/stats | head -c 200; echo; pkill -f "next start -p 3102"
docker rm -f bv-pg
```

  Both must return a JSON stats body (Postgres will show zero counts). Paste both outputs.

- [ ] **Step 6: Commit** — `feat: ship both prisma clients and choose one at runtime`

---

## Task 3: Anti-drift backup registry

**Files:** Create `src/lib/backup/models.ts`, `src/lib/backup/models.test.ts`.

**Produces:** `BackupModel { model; delegate; key }`, `BACKUP_MODELS` (parent-first),
`BACKUP_EXCLUDED_MODELS`.

The schema has **16 models**. `BACKUP_MODELS` holds **15** — every model except `AppSettings`.
`DateNormalizationAudit` is **included**: it is provenance for normalized dates, and without it a
restored install could never re-convert them.

- [ ] **Step 1: Test first** — `models.test.ts` asserts, against `Prisma.dmmf.datamodel.models`
  from `@prisma/client`: the registry plus exclusions equals every schema model; keys and delegates
  are unique; each delegate is the camelCase model name; and parents precede children for Firearm→Build,
  Build→BuildSlot, Accessory→BuildSlot, Firearm→MaintenanceLog, Accessory→BatteryChangeLog,
  RangeSession→SessionDrill, AmmoStock→AmmoTransaction. Also assert `MaintenanceLog`,
  `BatteryChangeLog`, and `DateNormalizationAudit` are present by name.

- [ ] **Step 2: Implement** the registry, parent-first:

```ts
export interface BackupModel { model: string; delegate: string; key: string }

/** Parent-first. Restore inserts in this order and deletes in reverse. */
export const BACKUP_MODELS: BackupModel[] = [
  { model: "Firearm", delegate: "firearm", key: "firearms" },
  { model: "Accessory", delegate: "accessory", key: "accessories" },
  { model: "AmmoStock", delegate: "ammoStock", key: "ammoStocks" },
  { model: "Build", delegate: "build", key: "builds" },
  { model: "BuildSlot", delegate: "buildSlot", key: "buildSlots" },
  { model: "Document", delegate: "document", key: "documents" },
  { model: "ImageCache", delegate: "imageCache", key: "imageCache" },
  { model: "RangeSession", delegate: "rangeSession", key: "rangeSessions" },
  { model: "RangeSessionAmmoLink", delegate: "rangeSessionAmmoLink", key: "rangeSessionAmmoLinks" },
  { model: "AmmoTransaction", delegate: "ammoTransaction", key: "ammoTransactions" },
  { model: "RoundCountLog", delegate: "roundCountLog", key: "roundCountLogs" },
  { model: "SessionDrill", delegate: "sessionDrill", key: "sessionDrills" },
  { model: "MaintenanceLog", delegate: "maintenanceLog", key: "maintenanceLogs" },
  { model: "BatteryChangeLog", delegate: "batteryChangeLog", key: "batteryChangeLogs" },
  { model: "DateNormalizationAudit", delegate: "dateNormalizationAudit", key: "dateNormalizationAudits" },
];

/** AppSettings is excluded: restore must not clobber local LAN host, paths, keys, or timezone. */
export const BACKUP_EXCLUDED_MODELS: readonly string[] = ["AppSettings"];
```

  Add a header comment explaining why the registry exists (the hand-maintained lists silently
  dropped two models and restore cascade-deleted them). Run `npm run db:generate` before the test —
  it reads the generated DMMF.

- [ ] **Step 3: Commit** — `feat: add DMMF-guarded backup model registry`

---

## Task 4: Backup exports every model

**Files:** Modify `src/app/api/backup/route.ts`; create `src/app/api/backup/route.test.ts`.

- [ ] Test first: every `BACKUP_MODELS` key is present in the payload (explicitly
  `maintenanceLogs`, `batteryChangeLogs`, `dateNormalizationAudits`), `meta.version === "1.1"`, and
  `meta.counts` has every key. Mock `@/lib/prisma` in the existing `vi.hoisted` style.
- [ ] Replace the hardcoded `findMany` block with a **sequential** loop over `BACKUP_MODELS`
  (SQLite `connection_limit=1` deadlocks on `Promise.all`). Bump `version` to `"1.1"`.
- [ ] **Commit** — `fix: backup now exports every model, including maintenance and battery logs`

---

## Task 5: Restore round-trips every model

**Files:** Modify `src/app/api/backup/restore/route.ts`; create its test.

**Read the current file first.** It has two behaviours added since the original plan that **must
survive** this change:
1. After a successful restore it runs `runConfiguredDateMigration("restore")`, guarded so it can
   never fail the response.
2. The success response sits **outside** the transaction's `try`, so a late error can never report
   "Your data has not been modified" after data was replaced.

- [ ] Tests first: restores `maintenanceLogs`, `batteryChangeLogs`, `dateNormalizationAudits` from a
  v1.1 payload; **accepts a v1.0 payload** missing the new keys (treated as empty); rejects a payload
  with no `meta.version` (400); deletes children before parents; and still calls the post-restore
  date migration.
- [ ] Replace the validator and transaction body with loops over `BACKUP_MODELS` — delete in
  reverse, insert in order. Missing keys → `[]`. `AppSettings` untouched.
- [ ] **Commit** — `fix: restore no longer destroys maintenance and battery logs`

---

## Task 6: Case-insensitive search on Postgres

**Files:** Create `src/lib/db/text-search.ts` + test; modify `src/app/api/search/route.ts`.

SQLite's `LIKE` is ASCII-case-insensitive; Postgres's is not, so search would silently stop matching
on capitalisation.

- [ ] Tests first: `containsInsensitive("glock","postgres")` → `{contains:"glock", mode:"insensitive"}`;
  on `"sqlite"` → exactly `{contains:"glock"}` (no `mode` key); casing preserved.
- [ ] Implement with a **named** `InsensitiveFilter` interface (so passing it where the SQLite client
  expects a `StringFilter` does not trip excess-property checking), defaulting `provider` to
  `DB_PROVIDER`.
- [ ] In the search route, stop lowercasing `q` and route every `{ contains: q }` through
  `containsInsensitive(q)`. Verify with `grep -n "contains:" src/app/api/search/route.ts` → none.
- [ ] **Commit** — `fix: make global search case-insensitive on postgres`

---

## Task 7: One-way verified migrator

**Files:** Create `scripts/migrate-sqlite-to-postgres.ts`; add the npm script.

Both clients now ship in every build, so the migrator loads them directly — **no temporary
client generation**.

- [ ] Implement. Copy **all 16 models**: `AppSettings` first, then `BACKUP_MODELS` in order.
  Source: `require(".prisma/client-sqlite").PrismaClient` with `SQLITE_URL` (default
  `file:<repo>/data/db/vault.db`). Target: `require("@prisma/client").PrismaClient` with
  `POSTGRES_URL` or `DATABASE_URL`, which must start with `postgres`.
  - `--dry-run`: print per-model source counts and exit; never connect to the target.
  - Refuse a non-empty target unless `--force`.
  - Copy with `createMany` in batches of 500.
  - Re-count every model on the target; **any mismatch → print it and exit 1**, stating the source was
    not modified.
  - Mask the password when printing the Postgres URL.
  - `finally`: disconnect both clients.
- [ ] npm script: `"migrate:to-postgres": "npx ts-node --compiler-options '{\"module\":\"CommonJS\"}' scripts/migrate-sqlite-to-postgres.ts",`
- [ ] **Prove it end to end** — this is the epic's core guarantee:

```bash
./dev.sh --fresh --setup-only        # seeded SQLite
docker run -d --name bv-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_USER=blackvault \
  -e POSTGRES_DB=blackvault -p 55432:5432 postgres:17-alpine; sleep 6
PGURL="postgresql://blackvault:dev@127.0.0.1:55432/blackvault"
DATABASE_URL="$PGURL" npx prisma migrate deploy --schema prisma/postgres/schema.prisma
SQLITE_URL="file:$PWD/prisma/prisma/dev.db" POSTGRES_URL="$PGURL" npm run migrate:to-postgres -- --dry-run
SQLITE_URL="file:$PWD/prisma/prisma/dev.db" POSTGRES_URL="$PGURL" npm run migrate:to-postgres
SQLITE_URL="file:$PWD/prisma/prisma/dev.db" POSTGRES_URL="$PGURL" npm run migrate:to-postgres   # must refuse
docker rm -f bv-pg
```

  Paste all three outputs. The real run must report all 16 models `OK` with zero mismatches; the
  second must refuse the non-empty target.
- [ ] **Commit** — `feat: add verified one-way sqlite to postgres migrator`

---

## Task 8: Compose, Dockerfile, environment

**Files:** Modify `docker-compose.yml`, `docker-compose.dev.yml`, `Dockerfile`, `.env.example`;
create `docker-compose.sqlite.yml`.

- [ ] `docker-compose.yml`: a `db` service on `postgres:17-alpine` (user/db `blackvault`,
  `POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}`, data at
  `${DATA_DIR:-./data}/postgres`, `pg_isready` healthcheck, `start_period: 30s`); the app with
  `depends_on: db: condition: service_healthy`, `DB_PROVIDER=postgres`,
  `DATABASE_URL=postgresql://blackvault:${POSTGRES_PASSWORD}@db:5432/blackvault`. Drop
  `VAULT_ENCRYPTION_KEY`.
- [ ] `docker-compose.sqlite.yml`: the current single-service layout with `DB_PROVIDER=sqlite` and
  `DATABASE_URL=file:/app/data/vault.db?connection_limit=1`. Two files rather than profiles, because
  `depends_on: service_healthy` cannot reference a profile-excluded service.
- [ ] `docker-compose.dev.yml`: drop the obsolete `version:` key; mirror the Postgres layout with
  named volumes and `POSTGRES_PASSWORD: devpass`.
- [ ] `Dockerfile` builder: set `ENV DB_PROVIDER=sqlite` before the build so prerender uses SQLite;
  `npm run build` generates both clients. Runner: `ENV DB_PROVIDER=postgres` and
  `CMD ["sh","-c","node node_modules/prisma/build/index.js migrate deploy --schema \"prisma/${DB_PROVIDER}/schema.prisma\" && node server.js"]`.
  The existing `COPY --from=builder /app/node_modules/.prisma` already carries both clients —
  confirm it.
- [ ] `.env.example`: add `DB_PROVIDER=postgres` and an empty `POSTGRES_PASSWORD=` with a
  `openssl rand -hex 24` hint.
- [ ] **Prove the image serves both providers** — the risk this whole revision exists to remove:

```bash
docker compose config >/dev/null && docker compose -f docker-compose.sqlite.yml config >/dev/null && echo OK
docker build -t bv-dual .
printf 'POSTGRES_PASSWORD=devpass\nPORT=3200\nDATA_DIR=/tmp/bv-pg-data\n' > /tmp/bv-pg.env
docker compose --env-file /tmp/bv-pg.env up -d; sleep 45
curl -s localhost:3200/api/health; echo; curl -s localhost:3200/api/stats | head -c 150; echo
docker compose --env-file /tmp/bv-pg.env down -v
printf 'PORT=3201\nDATA_DIR=/tmp/bv-sqlite-data\n' > /tmp/bv-sq.env
docker compose -f docker-compose.sqlite.yml --env-file /tmp/bv-sq.env up -d; sleep 30
curl -s localhost:3201/api/stats | head -c 150; echo
docker compose -f docker-compose.sqlite.yml --env-file /tmp/bv-sq.env down -v
rm -rf /tmp/bv-pg-data /tmp/bv-sqlite-data /tmp/bv-pg.env /tmp/bv-sq.env
```

  Both must return stats JSON. If the app starts before Postgres is ready, fix the healthcheck gate —
  do not add a sleep to the entrypoint.
- [ ] **Commit** — `feat: default docker deployment to postgres with sqlite fallback`

---

## Task 9: Installer and documentation

**Files:** Modify `install.sh`, `README.md`.

- [ ] `install.sh`: after the PORT prompt, ask PostgreSQL (default, recommended) or SQLite; for
  Postgres generate `POSTGRES_PASSWORD` (`openssl rand -hex 24`, falling back to `/dev/urandom`);
  write `DB_PROVIDER` and `POSTGRES_PASSWORD` into `.env`; use `$COMPOSE -f "$COMPOSE_FILE" up -d`.
  `bash -n install.sh` and `shellcheck install.sh` must pass.
- [ ] `README.md`: add a "Moving from SQLite to PostgreSQL" runbook under Data & Backups — back up
  first; stop; `docker compose up -d db`; `--dry-run`; real run; switch `DB_PROVIDER`; the old
  `vault.db` is never deleted.
- [ ] Replace every `theaveragedeveloper/ProjectBlackVault` and `ProjectBlackVault` link with
  `doomcrewinc/BlackVaultArmory`; confirm none remain.
- [ ] **`install.bat` is out of scope** — say so in the PR. Windows installs would write a `.env`
  without `POSTGRES_PASSWORD`, so this must close before any release tag.
- [ ] Final sweep: `npm run lint && npm test && npm run gen:schemas && git diff --exit-code prisma/`.
- [ ] **Commit** — `docs: postgres migration runbook, installer db choice, fix stale links`

---

## Self-Review

| Spec requirement | Task |
|---|---|
| One base schema; generated schemas differ only in provider + output | 1 |
| Drift between base and generated schemas fails a test | 1 |
| Postgres migration history without a Postgres server | 1 (`migrate diff --from-empty`) |
| One image serves both providers; one client per process | 2 (switch), 2 Step 5, 8 (image proof) |
| Build never needs Postgres | 2 Step 3 |
| A schema model missing from backup fails a test | 3 |
| Backup exports all 15 backed-up models | 4 |
| Restore round-trips them, tolerates v1.0, keeps the date-migration hook | 5 |
| Search case-insensitive on both providers | 6 |
| Migrator: dry run, refuses non-empty, count-verified, all 16 models | 7 |
| Compose Postgres default, SQLite fallback, healthcheck-gated | 8 |
| Installer asks; runbook documented; links fixed | 9 |

**Known risks, each with a proof step rather than an assumption:** the bundler resolving
`.prisma/client-sqlite` (2 Step 5, 8); Postgres `DateTime` precision in the date migration's
conditional `updateMany` (exercised by 7's real copy and 8's real run); `install.bat` not updated
(flagged, blocks release).
