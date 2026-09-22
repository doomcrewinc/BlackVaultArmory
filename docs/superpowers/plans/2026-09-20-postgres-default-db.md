> **SUPERSEDED by `2026-09-22-postgres-default-db.md`.** Do not execute this plan: it generates one Prisma client at build time while users choose a provider at runtime, so one image cannot serve both, and its Docker build would fail. Kept for history.

# Postgres Default Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PostgreSQL the default database with SQLite as a fallback, generated from a single
base schema, plus a one-way zero-loss SQLite→Postgres migrator — and fix the backup/restore
data-loss bug and the Postgres case-sensitivity break in `/api/search` along the way.

**Architecture:** `prisma/schema.base.prisma` is the only hand-edited schema; a codegen script
emits per-provider schemas that differ solely in the `provider` line. `DB_PROVIDER` selects one
provider at build/startup, so the running app still loads exactly one Prisma client and keeps
importing plain `@prisma/client`. A shared `BACKUP_MODELS` registry replaces the hand-maintained
table lists in backup/restore, guarded by a DMMF test that fails when a schema model is missing.

**Tech Stack:** Next.js 16.1.6, Prisma 5.22, PostgreSQL 17-alpine, SQLite, vitest, Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-20-postgres-default-db-design.md`

## Global Constraints

- **Migration is one-way.** SQLite → Postgres only. Never build a reverse path.
- **Zero data loss, verified.** Every migration ends with a per-model row-count assertion; any
  mismatch is a hard failure with a non-zero exit code.
- **Do not introduce `String[]`.** `compatibleCalibers` and `compatibleFirearmTypes` stay
  comma-separated strings so both providers keep an identical logical shape.
- Only `prisma/schema.base.prisma` is hand-edited. `prisma/postgres/schema.prisma` and
  `prisma/sqlite/schema.prisma` are generated and carry a DO-NOT-EDIT banner.
- The app loads exactly **one** Prisma client. Only the migrator ever touches two.
- `DB_PROVIDER` defaults to `postgres` for any unset/unrecognised value.
- Prisma queries against SQLite must stay sequential (`connection_limit=1` deadlocks on
  `Promise.all`). Do not parallelise existing routes in this epic.
- Depends on Epic A for the vitest harness (`npm test`) and for the `develop` branch created in
  its Task 0.
- All work happens on branch `feat/postgres-default`, branched off `develop`, PR'd into `develop`.
- **`gh pr create` must pass `--repo doomcrewinc/BlackVaultArmory`** — this is a fork, so `gh`
  otherwise targets the upstream parent and fails on permissions.
- **Assumes `chore/untrack-dev-db` has merged.** Task 2 Step 8 and Task 9 Step 4 run
  `npm run build`, which invokes `prisma migrate deploy`. Against the previously-committed
  `prisma/prisma/dev.db` that fails with `P3018: duplicate column name: serialNumber`, because
  that file's migration ledger recorded 10 of 18 migrations while its schema sat past migration
  11. If a stale `dev.db` is present on disk, delete it before running any build step.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `prisma/schema.base.prisma` | **Create** (from current `schema.prisma`) | Sole hand-edited schema |
| `src/lib/db/schema-codegen.ts` | **Create** | Pure base→provider schema transform |
| `src/lib/db/schema-codegen.test.ts` | **Create** | Transform unit tests + on-disk drift guard |
| `scripts/gen-prisma-schemas.ts` | **Create** | CLI wrapper writing both schemas |
| `scripts/schema-path.js` | **Create** | Prints the active schema path for npm scripts |
| `src/lib/db/provider.ts` | **Create** | `DB_PROVIDER` resolution |
| `src/lib/db/provider.test.ts` | **Create** | Resolution unit tests |
| `src/lib/db/text-search.ts` | **Create** | `containsInsensitive()` |
| `src/lib/db/text-search.test.ts` | **Create** | Per-provider filter shape tests |
| `src/lib/backup/models.ts` | **Create** | `BACKUP_MODELS` anti-drift registry |
| `src/lib/backup/models.test.ts` | **Create** | DMMF coverage assertion |
| `src/app/api/backup/route.ts` | Modify | Iterate the registry |
| `src/app/api/backup/restore/route.ts` | Modify | Iterate the registry; tolerate v1.0 payloads |
| `src/app/api/search/route.ts` | Modify | Use `containsInsensitive` |
| `scripts/migrate-sqlite-to-postgres.ts` | **Create** | One-way verified migrator |
| `docker-compose.yml` | Modify | Postgres + app |
| `docker-compose.sqlite.yml` | **Create** | SQLite fallback |
| `docker-compose.dev.yml` | Modify | Postgres for dev |
| `.env.example` | Modify | `DB_PROVIDER`, `POSTGRES_PASSWORD` |
| `.github/workflows/ci.yml` | Modify | Generate client before tests |
| `README.md` | Modify | Migration runbook |

---

## Task 1: Single base schema and codegen

**Files:**
- Create: `prisma/schema.base.prisma`
- Create: `src/lib/db/schema-codegen.ts`
- Create: `scripts/gen-prisma-schemas.ts`
- Test: `src/lib/db/schema-codegen.test.ts`
- Delete: `prisma/schema.prisma`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `PROVIDER_PLACEHOLDER: "__PROVIDER__"`
  - `PROVIDERS: { postgres: "postgresql"; sqlite: "sqlite" }`
  - `renderSchema(base: string, provider: string): string`
  - `npm run gen:schemas`

- [ ] **Step 1: Create the branch off develop**

```bash
cd /Users/doomcrew/repos/BlackVaultArmory
git checkout develop
git pull
git checkout -b feat/postgres-default
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/db/schema-codegen.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { PROVIDERS, PROVIDER_PLACEHOLDER, renderSchema } from "./schema-codegen";

const REPO_ROOT = path.join(__dirname, "..", "..", "..");

describe("renderSchema", () => {
  const base = `datasource db {\n  provider = "${PROVIDER_PLACEHOLDER}"\n}\n`;

  it("substitutes the provider placeholder", () => {
    expect(renderSchema(base, "postgresql")).toContain('provider = "postgresql"');
    expect(renderSchema(base, "sqlite")).toContain('provider = "sqlite"');
  });

  it("leaves no placeholder behind", () => {
    expect(renderSchema(base, "postgresql")).not.toContain(PROVIDER_PLACEHOLDER);
  });

  it("prepends a do-not-edit banner", () => {
    expect(renderSchema(base, "sqlite")).toContain("DO NOT EDIT");
  });

  it("is deterministic", () => {
    expect(renderSchema(base, "sqlite")).toBe(renderSchema(base, "sqlite"));
  });

  it("throws when the placeholder is absent", () => {
    expect(() => renderSchema('datasource db {\n  provider = "sqlite"\n}', "sqlite")).toThrow(
      /placeholder/i
    );
  });
});

describe("generated schemas on disk", () => {
  const base = fs.readFileSync(path.join(REPO_ROOT, "prisma", "schema.base.prisma"), "utf8");

  for (const [dir, provider] of Object.entries(PROVIDERS)) {
    it(`prisma/${dir}/schema.prisma is in sync with the base schema`, () => {
      const onDisk = fs.readFileSync(
        path.join(REPO_ROOT, "prisma", dir, "schema.prisma"),
        "utf8"
      );
      expect(onDisk).toBe(renderSchema(base, provider));
    });
  }

  it("the base schema declares no scalar lists (keeps providers shape-identical)", () => {
    expect(base).not.toMatch(/\s(String|Int|Float|Boolean|DateTime)\[\]/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- src/lib/db/schema-codegen.test.ts`
Expected: FAIL — `Failed to resolve import "./schema-codegen"`.

- [ ] **Step 4: Write the transform**

Create `src/lib/db/schema-codegen.ts`:

```ts
/**
 * Emits per-provider Prisma schemas from prisma/schema.base.prisma.
 *
 * The audit in the design spec confirmed the schema uses no provider-specific
 * constructs, so the only difference between providers is the datasource line.
 * This is a text substitution, not a dialect translation — keep it that way.
 */

export const PROVIDER_PLACEHOLDER = "__PROVIDER__";

export const PROVIDERS = {
  postgres: "postgresql",
  sqlite: "sqlite",
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

export function renderSchema(base: string, provider: string): string {
  if (!base.includes(PROVIDER_PLACEHOLDER)) {
    throw new Error(
      `schema.base.prisma is missing the ${PROVIDER_PLACEHOLDER} placeholder in its datasource block`
    );
  }
  return BANNER + base.split(PROVIDER_PLACEHOLDER).join(provider);
}
```

- [ ] **Step 5: Create the base schema**

```bash
git mv prisma/schema.prisma prisma/schema.base.prisma
```

Then edit `prisma/schema.base.prisma` and change only the datasource block, from:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

to:

```prisma
datasource db {
  provider = "__PROVIDER__"
  url      = env("DATABASE_URL")
}
```

Leave the `generator client` block and every model untouched.

- [ ] **Step 6: Write the generator CLI**

Create `scripts/gen-prisma-schemas.ts`:

```ts
import fs from "fs";
import path from "path";
import { PROVIDERS, renderSchema } from "../src/lib/db/schema-codegen";

const root = path.join(__dirname, "..");
const basePath = path.join(root, "prisma", "schema.base.prisma");
const base = fs.readFileSync(basePath, "utf8");

for (const [dir, provider] of Object.entries(PROVIDERS)) {
  const outPath = path.join(root, "prisma", dir, "schema.prisma");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, renderSchema(base, provider), "utf8");
  console.log(`wrote prisma/${dir}/schema.prisma (provider=${provider})`);
}
```

- [ ] **Step 7: Move the existing migration history to the sqlite side**

The 17 existing migrations are SQLite DDL and are **only** valid for the SQLite provider.

```bash
mkdir -p prisma/sqlite
git mv prisma/migrations prisma/sqlite/migrations
```

- [ ] **Step 8: Add the npm script and generate**

In `package.json` `"scripts"`, add:

```json
    "gen:schemas": "npx ts-node --project tsconfig.json scripts/gen-prisma-schemas.ts",
```

Run: `npm run gen:schemas`
Expected: two lines confirming both files written.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test -- src/lib/db/schema-codegen.test.ts`
Expected: PASS, 7 tests — including both on-disk sync checks and the no-scalar-lists guard.

- [ ] **Step 10: Commit**

```bash
git add prisma/ scripts/gen-prisma-schemas.ts src/lib/db/ package.json
git commit -m "feat: generate per-provider prisma schemas from a single base schema"
```

---

## Task 2: Provider resolution and build wiring

**Files:**
- Create: `src/lib/db/provider.ts`
- Create: `scripts/schema-path.js`
- Test: `src/lib/db/provider.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type DbProvider = "postgres" | "sqlite"`
  - `resolveProvider(raw: string | undefined): DbProvider`
  - `DB_PROVIDER: DbProvider`
  - `node scripts/schema-path.js` → prints the active schema path

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveProvider } from "./provider";

describe("resolveProvider", () => {
  it("defaults to postgres when unset", () => {
    expect(resolveProvider(undefined)).toBe("postgres");
  });

  it("defaults to postgres when empty or whitespace", () => {
    expect(resolveProvider("")).toBe("postgres");
    expect(resolveProvider("   ")).toBe("postgres");
  });

  it("defaults to postgres for unrecognised values", () => {
    expect(resolveProvider("mysql")).toBe("postgres");
    expect(resolveProvider("mariadb")).toBe("postgres");
  });

  it("selects sqlite when explicitly requested", () => {
    expect(resolveProvider("sqlite")).toBe("sqlite");
  });

  it("is case and whitespace insensitive", () => {
    expect(resolveProvider("SQLite")).toBe("sqlite");
    expect(resolveProvider("  SQLITE  ")).toBe("sqlite");
  });

  it("accepts postgres spellings", () => {
    expect(resolveProvider("postgres")).toBe("postgres");
    expect(resolveProvider("postgresql")).toBe("postgres");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/db/provider.test.ts`
Expected: FAIL — `Failed to resolve import "./provider"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/provider.ts`:

```ts
export type DbProvider = "postgres" | "sqlite";

/**
 * Anything other than an explicit "sqlite" resolves to postgres.
 * Failing open to postgres is deliberate: a typo must not silently
 * drop a production install back onto single-writer SQLite.
 */
export function resolveProvider(raw: string | undefined): DbProvider {
  return raw?.trim().toLowerCase() === "sqlite" ? "sqlite" : "postgres";
}

export const DB_PROVIDER: DbProvider = resolveProvider(process.env.DB_PROVIDER);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/db/provider.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the schema path helper**

`package.json` scripts need the active schema path. This must be plain JS (no ts-node) so it can
run before dependencies are fully wired.

Create `scripts/schema-path.js`:

```js
const provider = (process.env.DB_PROVIDER || "").trim().toLowerCase();
const dir = provider === "sqlite" ? "sqlite" : "postgres";
process.stdout.write(`prisma/${dir}/schema.prisma`);
```

- [ ] **Step 6: Rewire the build scripts**

Replace the `"build"` entry in `package.json` and add three helpers. The old value hardcoded a
SQLite path; the new one resolves by provider:

```json
    "db:schema": "node scripts/schema-path.js",
    "db:generate": "prisma generate --schema $(node scripts/schema-path.js)",
    "db:deploy": "prisma migrate deploy --schema $(node scripts/schema-path.js)",
    "build": "npm run gen:schemas && npm run db:generate && npm run db:deploy && next build",
```

- [ ] **Step 7: Verify provider selection both ways**

```bash
node scripts/schema-path.js && echo ""
DB_PROVIDER=sqlite node scripts/schema-path.js && echo ""
```

Expected: `prisma/postgres/schema.prisma` then `prisma/sqlite/schema.prisma`.

- [ ] **Step 8: Verify a SQLite build still works end to end**

```bash
DB_PROVIDER=sqlite DATABASE_URL="file:$PWD/prisma/prisma/dev.db" npm run build
```

Expected: build succeeds. This proves the fallback path survives the rewiring before Postgres
exists anywhere.

- [ ] **Step 9: Commit**

```bash
git add src/lib/db/provider.ts src/lib/db/provider.test.ts scripts/schema-path.js package.json
git commit -m "feat: resolve database provider from DB_PROVIDER and wire build scripts"
```

---

## Task 3: Anti-drift backup registry

This is the task that prevents the data-loss bug class from recurring.

**Files:**
- Create: `src/lib/backup/models.ts`
- Test: `src/lib/backup/models.test.ts`

**Interfaces:**
- Consumes: `Prisma.dmmf` from `@prisma/client`
- Produces:
  - `interface BackupModel { model: string; delegate: string; key: string }`
  - `BACKUP_MODELS: BackupModel[]` — **parent-first insert order**
  - `BACKUP_EXCLUDED_MODELS: readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `src/lib/backup/models.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { BACKUP_EXCLUDED_MODELS, BACKUP_MODELS } from "./models";

describe("BACKUP_MODELS registry", () => {
  const schemaModels = Prisma.dmmf.datamodel.models.map((m) => m.name).sort();

  it("covers every model in the Prisma schema", () => {
    const covered = [
      ...BACKUP_MODELS.map((m) => m.model),
      ...BACKUP_EXCLUDED_MODELS,
    ].sort();
    // If this fails, a model was added to schema.base.prisma without being
    // registered here — backup would silently omit it. Add it, do not weaken this test.
    expect(covered).toEqual(schemaModels);
  });

  it("explicitly includes the two models the old hardcoded list missed", () => {
    const names = BACKUP_MODELS.map((m) => m.model);
    expect(names).toContain("MaintenanceLog");
    expect(names).toContain("BatteryChangeLog");
  });

  it("has unique keys and delegates", () => {
    expect(new Set(BACKUP_MODELS.map((m) => m.key)).size).toBe(BACKUP_MODELS.length);
    expect(new Set(BACKUP_MODELS.map((m) => m.delegate)).size).toBe(BACKUP_MODELS.length);
  });

  it("names a real Prisma delegate for every entry", () => {
    for (const m of BACKUP_MODELS) {
      expect(m.delegate).toBe(m.model.charAt(0).toLowerCase() + m.model.slice(1));
    }
  });

  it("orders parents before children", () => {
    const index = (name: string) => BACKUP_MODELS.findIndex((m) => m.model === name);
    expect(index("Firearm")).toBeLessThan(index("Build"));
    expect(index("Build")).toBeLessThan(index("BuildSlot"));
    expect(index("Accessory")).toBeLessThan(index("BuildSlot"));
    expect(index("Firearm")).toBeLessThan(index("MaintenanceLog"));
    expect(index("Accessory")).toBeLessThan(index("BatteryChangeLog"));
    expect(index("RangeSession")).toBeLessThan(index("SessionDrill"));
    expect(index("AmmoStock")).toBeLessThan(index("AmmoTransaction"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/backup/models.test.ts`
Expected: FAIL — `Failed to resolve import "./models"`.

- [ ] **Step 3: Write the registry**

Create `src/lib/backup/models.ts`:

```ts
/**
 * The single source of truth for which models participate in backup, restore,
 * and SQLite→Postgres migration.
 *
 * Before this existed, backup and restore each carried their own hardcoded table
 * list. MaintenanceLog and BatteryChangeLog were added to the schema but never to
 * those lists, so restore cascade-deleted them and re-inserted nothing.
 *
 * models.test.ts asserts this registry against Prisma's DMMF. Adding a model to
 * the schema without registering it here is a failing test, not silent data loss.
 */

export interface BackupModel {
  /** DMMF model name, e.g. "MaintenanceLog" */
  model: string;
  /** Prisma client delegate, e.g. "maintenanceLog" */
  delegate: string;
  /** Key in the backup JSON payload, e.g. "maintenanceLogs" */
  key: string;
}

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
];

/**
 * AppSettings is deliberately excluded from backup/restore: restore must not
 * clobber local LAN host, backup destination path, or API keys. The migrator
 * copies it separately.
 */
export const BACKUP_EXCLUDED_MODELS: readonly string[] = ["AppSettings"];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run db:generate && npm test -- src/lib/backup/models.test.ts`
Expected: PASS, 5 tests. `db:generate` is required first — the test reads the generated DMMF.

- [ ] **Step 5: Make CI generate the client before testing**

In `.github/workflows/ci.yml` (created in Epic A), insert a step between `Install dependencies`
and `Lint`:

```yaml
      - name: Generate Prisma client
        run: npm run gen:schemas && npm run db:generate
        env:
          DB_PROVIDER: postgres
```

Without this, `models.test.ts` cannot import `Prisma.dmmf` and CI fails.

- [ ] **Step 6: Commit**

```bash
git add src/lib/backup/ .github/workflows/ci.yml
git commit -m "feat: add DMMF-guarded backup model registry"
```

---

## Task 4: Fix the backup route

**Files:**
- Modify: `src/app/api/backup/route.ts:13-45`
- Test: `src/app/api/backup/route.test.ts` (create)

**Interfaces:**
- Consumes: `BACKUP_MODELS` from Task 3
- Produces: backup payload at `meta.version === "1.1"` containing all 14 array keys

- [ ] **Step 1: Write the failing test**

Create `src/app/api/backup/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BACKUP_MODELS } from "@/lib/backup/models";

const mocks = vi.hoisted(() => ({ delegates: {} as Record<string, { findMany: () => Promise<unknown[]> }> }));

vi.mock("@/lib/prisma", () => {
  const client: Record<string, unknown> = {
    appSettings: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  return { prisma: new Proxy(client, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (!mocks.delegates[prop]) {
        mocks.delegates[prop] = { findMany: vi.fn().mockResolvedValue([]) };
      }
      return mocks.delegates[prop];
    },
  }) };
});

vi.mock("@/lib/server/auth", () => ({ requireAuth: vi.fn().mockResolvedValue(null) }));

import { POST } from "./route";

describe("/api/backup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exports every registered model, including the two previously missing ones", async () => {
    const response = await POST();
    expect(response.status).toBe(200);
    const body = await response.json();

    for (const m of BACKUP_MODELS) {
      expect(body, `missing backup key: ${m.key}`).toHaveProperty(m.key);
    }
    expect(body).toHaveProperty("maintenanceLogs");
    expect(body).toHaveProperty("batteryChangeLogs");
  });

  it("stamps the payload as version 1.1", async () => {
    const body = await (await POST()).json();
    expect(body.meta.version).toBe("1.1");
  });

  it("reports a count for every registered model", async () => {
    const body = await (await POST()).json();
    for (const m of BACKUP_MODELS) {
      expect(body.meta.counts).toHaveProperty(m.key);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/api/backup/route.test.ts`
Expected: FAIL — `missing backup key: maintenanceLogs`.

- [ ] **Step 3: Replace the hardcoded query block**

In `src/app/api/backup/route.ts`, add the import at the top:

```ts
import { BACKUP_MODELS } from "@/lib/backup/models";
```

Then delete the entire run of 13 hardcoded `const ... = await prisma.<model>.findMany(...)` lines
(currently lines 13–25) and the `const backupData = { ... }` object literal, replacing both with:

```ts
    // Sequential — connection_limit=1 on SQLite means Promise.all would deadlock.
    // Driven by BACKUP_MODELS so a new schema model cannot be silently omitted.
    const backupData: Record<string, unknown[]> = {};
    for (const entry of BACKUP_MODELS) {
      const delegate = (prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>)[
        entry.delegate
      ];
      backupData[entry.key] = await delegate.findMany();
    }

    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
```

- [ ] **Step 4: Bump the payload version**

In the same file, change:

```ts
      version: "1.0",
```

to:

```ts
      version: "1.1",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- src/app/api/backup/route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/backup/route.ts src/app/api/backup/route.test.ts
git commit -m "fix: backup now exports maintenance and battery change logs"
```

---

## Task 5: Fix the restore route

**Files:**
- Modify: `src/app/api/backup/restore/route.ts`
- Test: `src/app/api/backup/restore/route.test.ts` (create)

**Interfaces:**
- Consumes: `BACKUP_MODELS` from Task 3
- Produces: restore that accepts both v1.0 and v1.1 payloads

Old v1.0 backups lack the two new keys. Rejecting them would strand every existing user, so
missing keys are treated as empty arrays rather than as validation failures.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/backup/restore/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BACKUP_MODELS } from "@/lib/backup/models";

const mocks = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/lib/prisma", () => {
  const makeDelegate = (name: string) => ({
    deleteMany: vi.fn(async () => { mocks.calls.push(`delete:${name}`); return { count: 0 }; }),
    createMany: vi.fn(async () => { mocks.calls.push(`create:${name}`); return { count: 1 }; }),
  });
  const delegates: Record<string, unknown> = {};
  for (const m of BACKUP_MODELS) delegates[m.delegate] = makeDelegate(m.delegate);
  return {
    prisma: {
      ...delegates,
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({ ...delegates })),
    },
  };
});

vi.mock("@/lib/server/auth", () => ({ requireAuth: vi.fn().mockResolvedValue(null) }));

import { POST } from "./route";

function payload(version: string, overrides: Record<string, unknown[]> = {}) {
  const body: Record<string, unknown> = { meta: { version } };
  for (const m of BACKUP_MODELS) body[m.key] = overrides[m.key] ?? [];
  return body;
}

function request(body: unknown) {
  return new NextRequest("http://localhost/api/backup/restore", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

describe("/api/backup/restore", () => {
  beforeEach(() => { mocks.calls.length = 0; vi.clearAllMocks(); });

  it("restores maintenance and battery logs from a v1.1 payload", async () => {
    const body = payload("1.1", {
      maintenanceLogs: [{ id: "m1", firearmId: "f1", date: "2026-01-01T00:00:00.000Z", notes: "x" }],
      batteryChangeLogs: [{ id: "b1", accessoryId: "a1", changedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect(mocks.calls).toContain("create:maintenanceLog");
    expect(mocks.calls).toContain("create:batteryChangeLog");
  });

  it("accepts a legacy v1.0 payload missing the new keys", async () => {
    const body = payload("1.0");
    delete (body as Record<string, unknown>).maintenanceLogs;
    delete (body as Record<string, unknown>).batteryChangeLogs;
    const response = await POST(request(body));
    expect(response.status).toBe(200);
  });

  it("rejects a payload with no meta.version", async () => {
    const response = await POST(request({ firearms: [] }));
    expect(response.status).toBe(400);
  });

  it("deletes children before parents", async () => {
    await POST(request(payload("1.1")));
    const deletes = mocks.calls.filter((c) => c.startsWith("delete:"));
    expect(deletes.indexOf("delete:buildSlot")).toBeLessThan(deletes.indexOf("delete:build"));
    expect(deletes.indexOf("delete:maintenanceLog")).toBeLessThan(deletes.indexOf("delete:firearm"));
    expect(deletes.indexOf("delete:batteryChangeLog")).toBeLessThan(deletes.indexOf("delete:accessory"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/app/api/backup/restore/route.test.ts`
Expected: FAIL — `expected [...] to contain 'create:maintenanceLog'`.

- [ ] **Step 3: Replace the validator and the transaction body**

Replace everything in `src/app/api/backup/restore/route.ts` from the `const REQUIRED_ARRAY_KEYS`
declaration through the end of the `$transaction` call with:

```ts
import { BACKUP_MODELS } from "@/lib/backup/models";

type BackupBody = { meta: { version: string } } & Record<string, unknown[]>;

function isValidBackup(body: unknown): body is BackupBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  const meta = b.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.version !== "string") return false;
  // Keys absent from older payloads are treated as empty, not rejected.
  return BACKUP_MODELS.every((m) => b[m.key] === undefined || Array.isArray(b[m.key]));
}

function rowsFor(body: BackupBody, key: string): unknown[] {
  const value = body[key];
  return Array.isArray(value) ? value : [];
}
```

and inside the `try` block:

```ts
    await prisma.$transaction(
      async (tx) => {
        const delegates = tx as unknown as Record<
          string,
          { deleteMany: () => Promise<unknown>; createMany: (a: { data: unknown[] }) => Promise<unknown> }
        >;

        // Children before parents.
        for (const entry of [...BACKUP_MODELS].reverse()) {
          await delegates[entry.delegate].deleteMany();
        }

        // AppSettings intentionally NOT touched — preserve LAN/path config.

        // Parents before children.
        for (const entry of BACKUP_MODELS) {
          const rows = rowsFor(body, entry.key);
          if (rows.length) await delegates[entry.delegate].createMany({ data: rows });
        }
      },
      { timeout: 30000 }
    );

    return NextResponse.json({
      success: true,
      counts: Object.fromEntries(BACKUP_MODELS.map((m) => [m.key, rowsFor(body, m.key).length])),
    });
```

Delete the now-unused destructuring block (`const { firearms, builds, ... } = body;`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/app/api/backup/restore/route.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/backup/restore/route.ts src/app/api/backup/restore/route.test.ts
git commit -m "fix: restore no longer destroys maintenance and battery logs"
```

---

## Task 6: Provider-aware case-insensitive search

**Files:**
- Create: `src/lib/db/text-search.ts`
- Test: `src/lib/db/text-search.test.ts`
- Modify: `src/app/api/search/route.ts`

**Interfaces:**
- Consumes: `resolveProvider` from Task 2
- Produces: `containsInsensitive(value: string, provider?: DbProvider): InsensitiveFilter`

`InsensitiveFilter` is a **named** type, so TypeScript's excess-property check does not fire when
it is passed where a SQLite `StringFilter` is expected. That is what lets one call site compile
against either generated client.

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/text-search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { containsInsensitive } from "./text-search";

describe("containsInsensitive", () => {
  it("adds mode:insensitive on postgres", () => {
    expect(containsInsensitive("glock", "postgres")).toEqual({
      contains: "glock",
      mode: "insensitive",
    });
  });

  it("omits mode on sqlite, whose LIKE is already ASCII-insensitive", () => {
    expect(containsInsensitive("glock", "sqlite")).toEqual({ contains: "glock" });
  });

  it("never emits an undefined mode key on sqlite", () => {
    expect(Object.keys(containsInsensitive("glock", "sqlite"))).toEqual(["contains"]);
  });

  it("preserves the caller's casing rather than lowercasing", () => {
    expect(containsInsensitive("GLOCK", "postgres").contains).toBe("GLOCK");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- src/lib/db/text-search.test.ts`
Expected: FAIL — `Failed to resolve import "./text-search"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/text-search.ts`:

```ts
import { DB_PROVIDER, type DbProvider } from "./provider";

/**
 * Named (not inline) so that passing it to a SQLite-generated client does not
 * trip TypeScript's excess-property check on `mode`.
 */
export interface InsensitiveFilter {
  contains: string;
  mode?: "insensitive";
}

/**
 * SQLite's LIKE is ASCII-case-insensitive by default; Postgres's is not.
 * Postgres therefore needs an explicit mode, which Prisma rejects on SQLite.
 */
export function containsInsensitive(
  value: string,
  provider: DbProvider = DB_PROVIDER
): InsensitiveFilter {
  return provider === "sqlite" ? { contains: value } : { contains: value, mode: "insensitive" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- src/lib/db/text-search.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Rewrite the search filters**

In `src/app/api/search/route.ts`, add the import:

```ts
import { containsInsensitive } from "@/lib/db/text-search";
```

Change the query normalisation at line 6 from:

```ts
  const q = rawQ.toLowerCase().trim();
```

to:

```ts
  // No lowercasing — containsInsensitive handles case per provider.
  const q = rawQ.trim();
```

Then replace every `{ contains: q }` filter with `containsInsensitive(q)`. There are twelve, across
four queries:

```ts
        { name: containsInsensitive(q) },
        { manufacturer: containsInsensitive(q) },
        { model: containsInsensitive(q) },
        { caliber: containsInsensitive(q) },
```

```ts
        { name: containsInsensitive(q) },
        { manufacturer: containsInsensitive(q) },
        { model: containsInsensitive(q) },
        { type: containsInsensitive(q) },
```

```ts
        { brand: containsInsensitive(q) },
        { caliber: containsInsensitive(q) },
        { bulletType: containsInsensitive(q) },
```

```ts
    where: { name: containsInsensitive(q) },
```

- [ ] **Step 6: Verify no bare `contains` filters remain**

```bash
grep -n "contains:" src/app/api/search/route.ts && echo "BARE CONTAINS REMAINS — FIX" || echo "all filters routed through containsInsensitive"
```

Expected: `all filters routed through containsInsensitive`.

- [ ] **Step 7: Verify lint and build**

Run: `npm run lint && DB_PROVIDER=sqlite DATABASE_URL="file:$PWD/prisma/prisma/dev.db" npm run build`
Expected: both pass — proving the named-type trick compiles against the SQLite client.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/text-search.ts src/lib/db/text-search.test.ts src/app/api/search/route.ts
git commit -m "fix: make global search case-insensitive on postgres"
```

---

## Task 7: One-way verified migrator

**Files:**
- Create: `scripts/migrate-sqlite-to-postgres.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `BACKUP_MODELS` (Task 3), `renderSchema`/`PROVIDER_PLACEHOLDER` (Task 1)
- Produces: `npm run migrate:to-postgres [-- --dry-run] [-- --force]`

The migrator is the only place two Prisma clients coexist. The SQLite client is generated into a
throwaway directory at run time so the app never carries it.

- [ ] **Step 1: Write the migrator**

Create `scripts/migrate-sqlite-to-postgres.ts`:

```ts
/**
 * One-way SQLite -> Postgres migration.
 *
 * There is deliberately no reverse path. Every model is copied and then
 * re-counted on the target; any mismatch exits non-zero.
 *
 * Usage:
 *   npm run migrate:to-postgres -- --dry-run
 *   npm run migrate:to-postgres
 *   npm run migrate:to-postgres -- --force     # allow a non-empty target
 */
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { BACKUP_MODELS } from "../src/lib/backup/models";
import { PROVIDER_PLACEHOLDER, renderSchema } from "../src/lib/db/schema-codegen";

const ROOT = path.join(__dirname, "..");
const BATCH = 500;

// AppSettings is excluded from backup but MUST be migrated.
const MODELS = [
  { model: "AppSettings", delegate: "appSettings", key: "appSettings" },
  ...BACKUP_MODELS,
];

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");

const sqliteUrl = process.env.SQLITE_URL ?? `file:${path.join(ROOT, "data", "db", "vault.db")}`;
const postgresUrl = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;

if (!postgresUrl || !postgresUrl.startsWith("postgres")) {
  console.error("ERROR: set POSTGRES_URL (or DATABASE_URL) to a postgresql:// connection string.");
  process.exit(1);
}

/** Generate a throwaway SQLite client so both providers can be open at once. */
function buildSqliteClient() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-migrate-"));
  const clientOut = path.join(dir, "client");
  const base = fs.readFileSync(path.join(ROOT, "prisma", "schema.base.prisma"), "utf8");
  const schema = renderSchema(base, "sqlite").replace(
    "generator client {",
    `generator client {\n  output = "${clientOut}"`
  );
  const schemaPath = path.join(dir, "schema.prisma");
  fs.writeFileSync(schemaPath, schema, "utf8");
  console.log("Generating temporary SQLite client...");
  execSync(`npx prisma generate --schema "${schemaPath}"`, { stdio: "inherit", cwd: ROOT });
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient } = require(clientOut);
  return { PrismaClient, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function main() {
  if (PROVIDER_PLACEHOLDER.length === 0) throw new Error("unreachable");

  const { PrismaClient: SqliteClient, cleanup } = buildSqliteClient();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaClient: PgClient } = require("@prisma/client");

  const source = new SqliteClient({ datasources: { db: { url: sqliteUrl } } });
  const target = new PgClient({ datasources: { db: { url: postgresUrl } } });

  const d = (client: unknown, key: string) =>
    (client as Record<string, {
      findMany: (a?: unknown) => Promise<unknown[]>;
      count: () => Promise<number>;
      createMany: (a: { data: unknown[] }) => Promise<unknown>;
    }>)[key];

  try {
    console.log(`\nSource (sqlite): ${sqliteUrl}`);
    console.log(`Target (postgres): ${postgresUrl.replace(/:[^:@/]+@/, ":****@")}\n`);

    const sourceCounts: Record<string, number> = {};
    for (const m of MODELS) sourceCounts[m.model] = await d(source, m.delegate).count();

    console.log("Source row counts:");
    for (const m of MODELS) console.log(`  ${m.model.padEnd(24)} ${sourceCounts[m.model]}`);
    const total = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
    console.log(`  ${"TOTAL".padEnd(24)} ${total}\n`);

    if (dryRun) {
      console.log("--dry-run: nothing written.");
      return;
    }

    let targetTotal = 0;
    for (const m of MODELS) targetTotal += await d(target, m.delegate).count();
    if (targetTotal > 0 && !force) {
      console.error(`ERROR: target already holds ${targetTotal} rows. Re-run with --force to proceed.`);
      process.exit(1);
    }

    for (const m of MODELS) {
      const rows = await d(source, m.delegate).findMany();
      if (!rows.length) { console.log(`  ${m.model.padEnd(24)} 0 (skipped)`); continue; }
      for (let i = 0; i < rows.length; i += BATCH) {
        await d(target, m.delegate).createMany({ data: rows.slice(i, i + BATCH) });
      }
      console.log(`  ${m.model.padEnd(24)} ${rows.length} copied`);
    }

    console.log("\nVerifying...");
    const mismatches: string[] = [];
    for (const m of MODELS) {
      const after = await d(target, m.delegate).count();
      const before = sourceCounts[m.model];
      const ok = after === before;
      if (!ok) mismatches.push(`${m.model}: source=${before} target=${after}`);
      console.log(`  ${ok ? "OK  " : "FAIL"} ${m.model.padEnd(24)} ${before} -> ${after}`);
    }

    if (mismatches.length) {
      console.error(`\nMIGRATION FAILED — ${mismatches.length} mismatch(es):`);
      for (const line of mismatches) console.error(`  ${line}`);
      console.error("\nThe source SQLite database was not modified. Investigate before switching DB_PROVIDER.");
      process.exit(1);
    }

    console.log(`\nAll ${MODELS.length} models verified. ${total} rows migrated with zero loss.`);
    console.log("Next: set DB_PROVIDER=postgres in .env and restart.");
  } finally {
    await source.$disconnect().catch(() => {});
    await target.$disconnect().catch(() => {});
    cleanup();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Add the npm script**

```json
    "migrate:to-postgres": "npx ts-node --project tsconfig.json scripts/migrate-sqlite-to-postgres.ts",
```

- [ ] **Step 3: Verify the dry run against the existing dev database**

```bash
POSTGRES_URL="postgresql://blackvault:devpass@127.0.0.1:5432/blackvault" \
SQLITE_URL="file:$PWD/prisma/prisma/dev.db" \
npm run migrate:to-postgres -- --dry-run
```

Expected: a 15-row table of per-model counts and `--dry-run: nothing written.` No Postgres
connection is required for a dry run, since it exits before touching the target.

- [ ] **Step 4: Commit**

```bash
git add scripts/migrate-sqlite-to-postgres.ts package.json
git commit -m "feat: add verified one-way sqlite to postgres migrator"
```

---

## Task 8: Compose, Dockerfile, and environment

**Files:**
- Modify: `docker-compose.yml`
- Create: `docker-compose.sqlite.yml`
- Modify: `docker-compose.dev.yml`
- Modify: `.env.example`
- Modify: `Dockerfile`

**Interfaces:**
- Consumes: `DB_PROVIDER` (Task 2)
- Produces: a Postgres-default deployment with a working SQLite fallback

Two files rather than compose profiles: `depends_on: condition: service_healthy` cannot reference
a service excluded by a profile.

- [ ] **Step 1: Rewrite the production compose file**

Replace the `services:` block of `docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:17-alpine
    container_name: blackvault-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: blackvault
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}
      POSTGRES_DB: blackvault
    volumes:
      - ${DATA_DIR:-./data}/postgres:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U blackvault -d blackvault"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s

  blackvault:
    build: .
    container_name: blackvault
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - DB_PROVIDER=postgres
      - DATABASE_URL=postgresql://blackvault:${POSTGRES_PASSWORD}@db:5432/blackvault
    volumes:
      - ${DATA_DIR:-./data}/uploads:/app/uploads
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

Note `VAULT_ENCRYPTION_KEY` is dropped — `src/lib/crypto.ts` only reads it to unwrap legacy
`enc:` values, and `scripts/decrypt-serials.ts` handles that as a one-off.

- [ ] **Step 2: Create the SQLite fallback**

Create `docker-compose.sqlite.yml`:

```yaml
# BlackVault — SQLite fallback.
#
#   docker compose -f docker-compose.sqlite.yml up -d
#
# SQLite is single-writer; connection_limit=1 is required to avoid 503s under
# concurrent RSC prefetching. Prefer docker-compose.yml (Postgres) where possible.

services:
  blackvault:
    build: .
    container_name: blackvault
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    environment:
      - NODE_ENV=production
      - DB_PROVIDER=sqlite
      - DATABASE_URL=file:/app/data/vault.db?connection_limit=1
    volumes:
      - ${DATA_DIR:-./data}/db:/app/data
      - ${DATA_DIR:-./data}/uploads:/app/uploads
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

- [ ] **Step 3: Point the dev compose at Postgres**

In `docker-compose.dev.yml`, delete the obsolete `version: '3.8'` line, then mirror Step 1's two
services, replacing the `db` volume with a named volume `blackvault-dev-pgdata:/var/lib/postgresql/data`,
setting `POSTGRES_PASSWORD: devpass` literally, and keeping `blackvault-dev-uploads:/app/uploads`.
Declare both named volumes in the trailing `volumes:` block.

- [ ] **Step 4: Update the environment template**

Append to `.env.example`:

```
# Database provider: "postgres" (default, recommended) or "sqlite" (fallback).
DB_PROVIDER=postgres

# Required when DB_PROVIDER=postgres. Generate with:
#   openssl rand -hex 24
POSTGRES_PASSWORD=
```

- [ ] **Step 5: Make the container entrypoint provider-aware**

In `Dockerfile`, the runner stage currently hardcodes a SQLite URL and schema path. Replace:

```dockerfile
ENV DATABASE_URL="file:/app/data/vault.db"
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node server.js"]
```

with:

```dockerfile
ENV DB_PROVIDER=postgres
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema \"prisma/${DB_PROVIDER:-postgres}/schema.prisma\" && node server.js"]
```

The builder stage must also copy both generated schema directories. Change:

```dockerfile
COPY --from=builder /app/prisma ./prisma
```

— it already copies the whole `prisma/` tree, so both `postgres/` and `sqlite/` come along. No
change needed; verify with Step 6.

- [ ] **Step 6: Verify both deployments start**

```bash
docker compose config > /dev/null && echo "postgres compose OK"
docker compose -f docker-compose.sqlite.yml config > /dev/null && echo "sqlite compose OK"

echo "POSTGRES_PASSWORD=devpass" > .env.test
docker compose --env-file .env.test up -d
sleep 45
curl -s http://127.0.0.1:3000/api/health
docker compose --env-file .env.test down -v
rm .env.test
```

Expected: both `config` checks pass, and health returns `{"status":"ok",...}` with Postgres
running. If the app starts before the DB is ready, the `condition: service_healthy` gate is
misconfigured — fix it rather than adding a sleep to the entrypoint.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml docker-compose.sqlite.yml docker-compose.dev.yml .env.example Dockerfile
git commit -m "feat: default docker deployment to postgres with sqlite fallback"
```

---

## Task 9: Installer and documentation

**Files:**
- Modify: `install.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above
- Produces: nothing

`install.bat` is out of scope for this task — call it out in the PR so the Windows path is
updated before release, or the Windows installer will write a `.env` with no `POSTGRES_PASSWORD`
and compose will refuse to start.

- [ ] **Step 1: Add the database prompt to install.sh**

After the existing `PORT` prompt and before the `.env` is written, insert:

```bash
# ── Database choice ──────────────────────────────────────────
echo ""
echo "  Which database should BlackVault use?"
echo "    1) PostgreSQL  (recommended - supports multiple devices at once)"
echo "    2) SQLite      (single file, no extra container, one writer at a time)"
read -rp "  Choice [1]: " DB_CHOICE
DB_CHOICE="${DB_CHOICE:-1}"

if [ "$DB_CHOICE" = "2" ]; then
  DB_PROVIDER="sqlite"
  COMPOSE_FILE="docker-compose.sqlite.yml"
  POSTGRES_PASSWORD=""
else
  DB_PROVIDER="postgres"
  COMPOSE_FILE="docker-compose.yml"
  POSTGRES_PASSWORD="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p)"
  echo "  Generated a Postgres password and saved it to .env"
fi
```

Write `DB_PROVIDER` and `POSTGRES_PASSWORD` into the generated `.env`, and use
`$COMPOSE -f "$COMPOSE_FILE" up -d` wherever the script currently runs `$COMPOSE up -d`.

- [ ] **Step 2: Document the migration runbook in README.md**

Add a section after "Data & Backups":

```markdown
### Moving from SQLite to PostgreSQL

BlackVault defaults to PostgreSQL. If you installed an older version that used SQLite, you can
move your data across without losing anything. The migration is one-way.

1. **Back up first.** Settings → Backup. Keep the downloaded file somewhere safe.
2. Stop BlackVault: `docker compose -f docker-compose.sqlite.yml down`
3. Start the database on its own: `docker compose up -d db`
4. Preview what will move — this writes nothing:
   ```bash
   npm run migrate:to-postgres -- --dry-run
   ```
5. Run it for real:
   ```bash
   npm run migrate:to-postgres
   ```
   Every table is counted before and after. If any count does not match, the migration stops
   and reports which table — your SQLite file is left untouched.
6. Set `DB_PROVIDER=postgres` in `.env`, then `docker compose up -d`.

Your old `vault.db` is never deleted. Keep it until you are satisfied everything moved.
```

- [ ] **Step 3: Correct the stale upstream links**

Every install URL in `README.md` points at `theaveragedeveloper/ProjectBlackVault`, which no
longer matches this fork. Replace all occurrences with `doomcrewinc/BlackVaultArmory`:

```bash
sed -i '' 's|theaveragedeveloper/ProjectBlackVault|doomcrewinc/BlackVaultArmory|g' README.md
sed -i '' 's|ProjectBlackVault|BlackVaultArmory|g' README.md
grep -n "theaveragedeveloper\|ProjectBlackVault" README.md && echo "STALE LINKS REMAIN" || echo "links updated"
```

- [ ] **Step 4: Full verification sweep**

```bash
npm run lint
npm test
npm run gen:schemas && git diff --exit-code prisma/ && echo "schemas in sync"
docker compose config > /dev/null && docker compose -f docker-compose.sqlite.yml config > /dev/null && echo "compose OK"
```

Expected: all pass, and `git diff --exit-code` is clean — proving the committed generated schemas
match the base.

- [ ] **Step 5: Commit and open the PR**

```bash
git add install.sh README.md
git commit -m "docs: document postgres migration runbook and fix stale upstream links"
git push -u origin feat/postgres-default
gh pr create --base develop --title "Postgres as default database" \
  --body "Implements docs/superpowers/plans/2026-09-20-postgres-default-db.md

Includes two fixes folded in per the spec:
- backup/restore silently destroyed MaintenanceLog and BatteryChangeLog
- /api/search would have broken on Postgres due to case-sensitive LIKE

NOT DONE: install.bat still needs the DB prompt before release."
```

---

## Self-Review

**Spec coverage:**

| Spec acceptance criterion | Task |
|---|---|
| `npm run gen:schemas` emits both; differ only in provider line | 1 |
| Test fails when base and generated schemas drift | 1 (Step 2 on-disk sync test) |
| Test fails when a DMMF model is unregistered | 3 |
| Backup contains all 15 models | 4 |
| v1.0 backup restores, treating new keys as empty | 5 |
| v1.1 backup round-trips both new models | 5 |
| Search matches `Glock` for `glock` on both providers | 6 |
| `docker compose up -d` starts Postgres + app behind a healthcheck | 8 |
| SQLite fallback still works | 8 (and 2 Step 8, 6 Step 7) |
| Migrator refuses a non-empty target without `--force` | 7 |
| Migrator aborts on count mismatch | 7 |
| Full migration reports zero mismatches | 7 |

**Type consistency:** `renderSchema(base, provider)` and `PROVIDER_PLACEHOLDER` (Task 1) are used
with those signatures in Task 7. `BackupModel { model, delegate, key }` (Task 3) is consumed
identically in Tasks 4, 5, and 7. `DbProvider` (Task 2) is the parameter type of
`containsInsensitive` (Task 6). `MODELS` in Task 7 extends `BACKUP_MODELS` with an `AppSettings`
entry of the same shape.

**Placeholder scan:** No TBDs. Task 8 Step 3 describes the dev-compose edit prosaically rather
than as a literal block because it is a mechanical mirror of Step 1 with two substitutions — if
the executor finds that ambiguous, copy Step 1 and apply the two named changes.

**Known gaps, accepted and flagged:**
1. **`install.bat` is not updated.** Called out in Task 9 and in the PR body. Windows installs
   will write a `.env` without `POSTGRES_PASSWORD` and compose will refuse to start. This must be
   closed before any release tag.
2. **`prisma/prisma/dev.db` remains committed to git.** Out of scope here; worth its own
   `chore/` PR.
3. **No integration test performs a real SQLite→Postgres migration.** Task 7 Step 3 only exercises
   the dry run. A full round-trip needs a live Postgres, which belongs in a follow-up CI service
   container rather than in this plan's unit-test scope.
