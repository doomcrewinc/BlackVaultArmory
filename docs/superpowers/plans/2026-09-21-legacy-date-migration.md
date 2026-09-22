# Legacy Date Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert date-only values the old code stored as true instants into the calendar day their
author meant, automatically and reversibly, so the date-only display fix doesn't shift them.

**Architecture:** A migration module normalizes every non-UTC-midnight value in the ten date-only
fields, recording each original in an audit table first. It runs at server start with the
configured timezone (UTC if none), and again whenever the user saves a timezone in Settings — the
second run re-converts from the recorded originals, skipping any row the user has since edited.

**Tech Stack:** Next.js 16 (`instrumentation.ts`), Prisma 5.22, SQLite, vitest, `Intl`

**Spec:** `docs/superpowers/specs/2026-09-21-legacy-date-migration-design.md`

## Global Constraints

- **App/display time is browser-local. DB and wire time is UTC.**
- A value **not** at exact UTC midnight in a date-only field is legacy by definition — every write
  after the date-only fix goes through `toDateOnlyUTC()`.
- **Never overwrite a user edit.** Re-conversion touches a row only while it still equals the
  audit's `appliedValue`.
- **A migration failure never blocks server start or a settings save.** Log it and continue.
- Detection runs in application code, never in provider-specific SQL — the Postgres epic follows.
- Anything computed from the browser (the timezone prefill) runs in a `useEffect`, never during
  render. Computing it during SSR bakes the server's zone into the HTML — a bug this branch has
  already fixed once.
- No new dependencies.
- `npm run lint` 0 errors, `npm test` green, `npm run build` clean.
- Branch: `fix/date-only-handling` (this ships with the date-only fix, PR #5).
- `gh` commands need `--repo doomcrewinc/BlackVaultArmory`.

---

## Task 1: Schema and the migration module

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_legacy_date_migration/` (generated)
- Create: `src/lib/date-migration.ts`
- Test: `src/lib/date-migration.test.ts`

**Interfaces — Produces:**
- `DATE_ONLY_FIELDS: ReadonlyArray<{ model: string; delegate: string; field: string }>`
- `isValidTimeZone(zone: string): boolean`
- `normalizeInstant(instant: Date, zone: string): Date`
- `interface MigrationSummary { zone: string; normalized: number; reconverted: number; skippedEdited: number }`
- `runLegacyDateMigration(prisma: PrismaClient, zone: string): Promise<MigrationSummary>`

- [ ] **Step 1: Add the schema**

In `prisma/schema.prisma`, add to `model AppSettings`, after `defaultAmmoAlertThreshold`:

```prisma
  // IANA timezone, e.g. "America/Denver". null = unset.
  // Used to convert legacy date-only instants to the day their author meant.
  timezone                String?
```

Add a new model after `MaintenanceLog`:

```prisma
// ─── DATE NORMALIZATION AUDIT ─────────────────────────────────
// Records every legacy date-only value before the migration changes it, so the
// migration is reversible and can be re-run with a corrected timezone.
// No foreign keys: an audit row must outlive the record it describes.

model DateNormalizationAudit {
  id            String   @id @default(cuid())
  model         String
  field         String
  recordId      String
  originalValue DateTime
  appliedValue  DateTime
  appliedZone   String
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([model, field, recordId])
  @@index([model, field])
}
```

- [ ] **Step 2: Generate the migration**

```bash
./dev.sh --setup-only
npx prisma migrate dev --name legacy_date_migration
```

Confirm the generated SQL adds only the `timezone` column and the `DateNormalizationAudit` table.

- [ ] **Step 3: Write the failing tests**

Create `src/lib/date-migration.test.ts`. The `runLegacyDateMigration` tests use an **in-memory
fake** Prisma client, so they exercise the real branching logic without a database:

```ts
import { describe, expect, it } from "vitest";
import {
  DATE_ONLY_FIELDS,
  isValidTimeZone,
  normalizeInstant,
  runLegacyDateMigration,
} from "./date-migration";

const iso = (d: Date) => d.toISOString();

describe("isValidTimeZone", () => {
  it("accepts IANA zones", () => {
    expect(isValidTimeZone("America/Denver")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("normalizeInstant", () => {
  const instant = new Date("2026-09-21T01:30:00.000Z");

  it("uses the calendar day in the given zone", () => {
    expect(iso(normalizeInstant(instant, "America/Denver"))).toBe("2026-09-20T00:00:00.000Z");
    expect(iso(normalizeInstant(instant, "UTC"))).toBe("2026-09-21T00:00:00.000Z");
    expect(iso(normalizeInstant(instant, "Pacific/Auckland"))).toBe("2026-09-21T00:00:00.000Z");
  });

  it("handles a DST transition day", () => {
    // US DST ended 2026-11-01 at 02:00 local. 07:30Z that day is 00:30 MST / 01:30 MDT.
    expect(iso(normalizeInstant(new Date("2026-11-01T07:30:00.000Z"), "America/Denver"))).toBe(
      "2026-11-01T00:00:00.000Z"
    );
  });

  it("always returns exact UTC midnight", () => {
    expect(normalizeInstant(instant, "America/Denver").getTime() % 86_400_000).toBe(0);
  });
});

describe("DATE_ONLY_FIELDS", () => {
  it("covers all ten date-only fields", () => {
    expect(DATE_ONLY_FIELDS.map((f) => `${f.model}.${f.field}`).sort()).toEqual(
      [
        "Accessory.acquisitionDate",
        "Accessory.lastBatteryChangeDate",
        "AmmoStock.purchaseDate",
        "AmmoTransaction.purchaseDate",
        "BatteryChangeLog.changedAt",
        "Firearm.acquisitionDate",
        "Firearm.lastMaintenanceDate",
        "MaintenanceLog.date",
        "RangeSession.sessionDate",
        "SessionDrill.drillDate",
      ].sort()
    );
  });
});

// ── in-memory fake ───────────────────────────────────────────
type Row = Record<string, unknown> & { id: string };

function fakePrisma(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { dateNormalizationAudit: [], ...seed };
  let nextId = 1;
  const delegate = (name: string) => {
    tables[name] ??= [];
    return {
      findMany: async (args?: { where?: Record<string, unknown> }) =>
        tables[name].filter((r) =>
          Object.entries(args?.where ?? {}).every(([k, v]) => r[k] === v)
        ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tables[name].find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `audit-${nextId++}`, ...data } as Row;
        tables[name].push(row);
        return row;
      },
    };
  };
  const client: Record<string, unknown> = {
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  for (const f of DATE_ONLY_FIELDS) client[f.delegate] = delegate(f.delegate);
  client.dateNormalizationAudit = delegate("dateNormalizationAudit");
  return { client: client as never, tables };
}

const LEGACY = new Date("2026-09-21T01:30:00.000Z"); // written 7:30pm Sep 20 in Denver
const MIDNIGHT = new Date("2026-09-20T00:00:00.000Z"); // written from a date picker

describe("runLegacyDateMigration", () => {
  it("normalizes a legacy row and audits its original", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    const summary = await runLegacyDateMigration(client, "UTC");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-09-21T00:00:00.000Z");
    expect(tables.dateNormalizationAudit).toHaveLength(1);
    expect(iso(tables.dateNormalizationAudit[0].originalValue as Date)).toBe(iso(LEGACY));
    expect(summary.normalized).toBe(1);
  });

  it("never touches or audits a value already at UTC midnight", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: MIDNIGHT }] });
    const summary = await runLegacyDateMigration(client, "UTC");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(MIDNIGHT));
    expect(tables.dateNormalizationAudit).toHaveLength(0);
    expect(summary.normalized).toBe(0);
  });

  it("skips null values", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", lastMaintenanceDate: null }] });
    await runLegacyDateMigration(client, "UTC");
    expect(tables.dateNormalizationAudit).toHaveLength(0);
  });

  it("is idempotent for the same zone", async () => {
    const { client } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const second = await runLegacyDateMigration(client, "UTC");
    expect(second).toMatchObject({ normalized: 0, reconverted: 0, skippedEdited: 0 });
  });

  it("re-converts from the original when the zone changes", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const summary = await runLegacyDateMigration(client, "America/Denver");

    // 01:30Z on the 21st is 7:30pm on the 20th in Denver
    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe("2026-09-20T00:00:00.000Z");
    expect(tables.dateNormalizationAudit[0].appliedZone).toBe("America/Denver");
    expect(summary.reconverted).toBe(1);
  });

  it("never overwrites a date the user edited after migration", async () => {
    const { client, tables } = fakePrisma({ firearm: [{ id: "f1", acquisitionDate: LEGACY }] });
    await runLegacyDateMigration(client, "UTC");
    const edited = new Date("2026-08-01T00:00:00.000Z");
    tables.firearm[0].acquisitionDate = edited; // the user changed it

    const summary = await runLegacyDateMigration(client, "America/Denver");

    expect(iso(tables.firearm[0].acquisitionDate as Date)).toBe(iso(edited));
    expect(summary).toMatchObject({ reconverted: 0, skippedEdited: 1 });
  });
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `npm test -- src/lib/date-migration.test.ts`
Expected: FAIL — `Failed to resolve import "./date-migration"`.

- [ ] **Step 5: Implement**

Create `src/lib/date-migration.ts`:

```ts
/**
 * Converts date-only values the old code stored as true instants into the
 * calendar day their author meant.
 *
 * Before the date-only fix, some writers stored `new Date()` into date-only
 * fields. The old browser-local display made those rows look right to their
 * author; pinning display to UTC shifts them. This migration re-expresses each
 * such instant as UTC midnight of its calendar day in the owner's timezone.
 *
 * Every write after the fix goes through toDateOnlyUTC(), so a value NOT at
 * exact UTC midnight can only be legacy — detection is exact and idempotent.
 *
 * Every original is recorded in DateNormalizationAudit before it is changed, so
 * a run with a provisional zone (UTC) can later be corrected from the originals.
 */
import type { PrismaClient } from "@prisma/client";

const DAY_MS = 86_400_000;

export const DATE_ONLY_FIELDS = [
  { model: "Firearm", delegate: "firearm", field: "acquisitionDate" },
  { model: "Firearm", delegate: "firearm", field: "lastMaintenanceDate" },
  { model: "Accessory", delegate: "accessory", field: "acquisitionDate" },
  { model: "Accessory", delegate: "accessory", field: "lastBatteryChangeDate" },
  { model: "AmmoStock", delegate: "ammoStock", field: "purchaseDate" },
  { model: "AmmoTransaction", delegate: "ammoTransaction", field: "purchaseDate" },
  { model: "RangeSession", delegate: "rangeSession", field: "sessionDate" },
  { model: "SessionDrill", delegate: "sessionDrill", field: "drillDate" },
  { model: "MaintenanceLog", delegate: "maintenanceLog", field: "date" },
  { model: "BatteryChangeLog", delegate: "batteryChangeLog", field: "changedAt" },
] as const;

export interface MigrationSummary {
  zone: string;
  normalized: number;
  reconverted: number;
  skippedEdited: number;
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** UTC midnight of `instant`'s calendar day as seen in `zone`. */
export function normalizeInstant(instant: Date, zone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
}

type Delegate = {
  findMany: (args?: unknown) => Promise<Array<Record<string, unknown> & { id: string }>>;
  update: (args: unknown) => Promise<unknown>;
};

export async function runLegacyDateMigration(
  prisma: PrismaClient,
  zone: string
): Promise<MigrationSummary> {
  const summary: MigrationSummary = { zone, normalized: 0, reconverted: 0, skippedEdited: 0 };
  const client = prisma as unknown as Record<string, Delegate> & {
    $transaction: (ops: unknown[]) => Promise<unknown>;
    dateNormalizationAudit: Delegate & { create: (args: unknown) => Promise<unknown> };
  };
  const audit = client.dateNormalizationAudit;

  for (const { model, delegate, field } of DATE_ONLY_FIELDS) {
    const table = client[delegate];
    const rows = await table.findMany({ select: { id: true, [field]: true } });
    const audits = (await audit.findMany({ where: { model, field } })) as Array<{
      id: string;
      recordId: string;
      originalValue: Date;
      appliedValue: Date;
      appliedZone: string;
    }>;
    const auditByRecord = new Map(audits.map((a) => [a.recordId, a]));

    for (const row of rows) {
      const value = row[field] as Date | null;
      if (!value) continue;
      const existing = auditByRecord.get(row.id);

      if (existing) {
        // Re-conversion: only when the zone changed, and only while the row
        // still holds what the migration wrote. A user edit always wins.
        if (existing.appliedZone === zone) continue;
        if (value.getTime() !== new Date(existing.appliedValue).getTime()) {
          summary.skippedEdited++;
          continue;
        }
        const next = normalizeInstant(new Date(existing.originalValue), zone);
        await client.$transaction([
          table.update({ where: { id: row.id }, data: { [field]: next } }),
          audit.update({
            where: { id: existing.id },
            data: { appliedValue: next, appliedZone: zone },
          }),
        ]);
        summary.reconverted++;
        continue;
      }

      if (value.getTime() % DAY_MS === 0) continue; // already date-only

      const next = normalizeInstant(value, zone);
      await client.$transaction([
        audit.create({
          data: {
            model,
            field,
            recordId: row.id,
            originalValue: value,
            appliedValue: next,
            appliedZone: zone,
          },
        }),
        table.update({ where: { id: row.id }, data: { [field]: next } }),
      ]);
      summary.normalized++;
    }
  }

  return summary;
}
```

- [ ] **Step 6: Verify, then commit**

Run: `npm test -- src/lib/date-migration.test.ts` → PASS. Then `npm test && npm run lint`.

```bash
git add prisma/ src/lib/date-migration.ts src/lib/date-migration.test.ts
git commit -m "feat: add reversible migration for legacy date-only instants

Before the date-only fix, some writers stored new Date() into date-only
fields. Browser-local display made those rows look right to their
author; pinning display to UTC shifts them by a day. This converts each
legacy instant to UTC midnight of its calendar day in the owner's zone.

A value not at exact UTC midnight can only be legacy, so detection is
exact and the migration is idempotent. Every original is recorded in
DateNormalizationAudit first, so a provisional UTC run can later be
re-converted with the right zone. A row the user has since edited is
never overwritten.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Run it — at server start and on timezone save

**Files:**
- Modify: `src/lib/date-migration.ts` (add `runStartupDateMigration`)
- Create: `src/instrumentation.ts`
- Modify: `src/app/api/settings/route.ts`
- Test: `src/app/api/settings/route.test.ts` (extend)

**Interfaces — Consumes:** Task 1. **Produces:** `runStartupDateMigration(): Promise<void>`.

- [ ] **Step 1: Add the startup runner** to `src/lib/date-migration.ts`:

```ts
/** Runs at server start. Never throws: a failure must not block the app. */
export async function runStartupDateMigration(): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
    const configured = settings?.timezone;
    const zone = configured && isValidTimeZone(configured) ? configured : "UTC";
    const summary = await runLegacyDateMigration(prisma, zone);
    if (summary.normalized || summary.reconverted || summary.skippedEdited) {
      console.log(
        `[date-migration] zone=${zone} normalized=${summary.normalized} ` +
          `reconverted=${summary.reconverted} skippedEdited=${summary.skippedEdited}`
      );
    }
    if (!configured && summary.normalized) {
      console.log(
        "[date-migration] No timezone set; used UTC provisionally. " +
          "Set your timezone in Settings to correct these dates."
      );
    }
  } catch (error) {
    console.error("[date-migration] failed; the server will continue:", error);
  }
}
```

- [ ] **Step 2: Create `src/instrumentation.ts`**

```ts
export async function register() {
  // Node only: the edge runtime has no Prisma. Dynamic import keeps Prisma out
  // of any edge bundle.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupDateMigration } = await import("./lib/date-migration");
  await runStartupDateMigration();
}
```

- [ ] **Step 3: Accept and validate `timezone` in `PUT /api/settings`**

In `src/app/api/settings/route.ts`, add `timezone` to the destructured body (around line 93). Before
the upsert, validate it — `null` or `""` clears it, anything else must be a real zone:

```ts
    if (timezone !== undefined && timezone !== null && timezone !== "") {
      if (typeof timezone !== "string" || !isValidTimeZone(timezone)) {
        return NextResponse.json({ error: `Unknown timezone: ${String(timezone)}` }, { status: 400 });
      }
    }
```

Add it to `updateData` following the file's existing pattern, normalizing `""` to `null`. Read the
previous value before the upsert. After a successful upsert, if the zone changed to a non-null
value, run the migration — logging and never failing the save:

```ts
    let dateMigration: MigrationSummary | undefined;
    if (settings.timezone && settings.timezone !== previousTimezone) {
      try {
        dateMigration = await runLegacyDateMigration(prisma, settings.timezone);
      } catch (error) {
        console.error("[date-migration] failed after timezone change:", error);
      }
    }
```

Include `timezone` in the GET response and `dateMigration` in the PUT response, matching the
file's existing response shape.

- [ ] **Step 4: Extend the settings tests**

Add to `src/app/api/settings/route.test.ts`, matching its existing `vi.hoisted` mock style: an
invalid zone returns 400 and does not upsert; a valid zone is persisted; and — mocking
`@/lib/date-migration`'s `runLegacyDateMigration` — the migration is called when the zone changes
and **not** called when it is unchanged.

- [ ] **Step 5: Verify, then commit**

`npm test && npm run lint && npm run build`.

```bash
git commit -am "feat: run the legacy date migration at startup and on timezone save

Runs at server start with the configured zone, or UTC provisionally if
none is set, and again whenever the user saves a timezone - which
re-converts audited rows from their originals. Neither path can block
the server or the save; failures are logged.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Settings timezone field, and live verification

**Files:**
- Modify: `src/app/settings/page.tsx`

- [ ] **Step 1: Add the timezone field**

Add a Timezone input to the Settings form, following the page's existing field and save patterns.
Offer suggestions with a `<datalist>` populated from `Intl.supportedValuesOf("timeZone")`.

**Prefill must happen after mount, never during render.** If the loaded settings have no timezone,
set the field to `Intl.DateTimeFormat().resolvedOptions().timeZone` inside a `useEffect`. Do not
overwrite a value that is already present.

Show a one-line hint beneath it: *"Used to correct dates recorded by older versions of BlackVault."*

- [ ] **Step 2: Live verification against the real database**

This is the proof the whole feature works. Do each step for real and paste the output.

```bash
./dev.sh --fresh --setup-only   # clean, seeded DB
node -p 'Date.parse("2026-09-21T01:30:00Z")'   # legacy instant as epoch ms
```

1. **Plant two legacy rows.** With `sqlite3 prisma/prisma/dev.db`, set two firearms'
   `acquisitionDate` to that epoch value (non-midnight). Note both ids.
2. **Start the server with no timezone set.** Confirm the log line shows `normalized=2`, that both
   rows now read `2026-09-21T00:00:00.000Z` (UTC's day), and that two audit rows exist with
   `originalValue` `…01:30:00…` and `appliedZone` `UTC`.
3. **Simulate a user edit** on the second row: set its `acquisitionDate` to
   `2026-08-01T00:00:00.000Z`.
4. **Save a timezone:** `PUT /api/settings` with `{"timezone":"America/Denver"}`. Confirm the
   response's `dateMigration` is `reconverted: 1, skippedEdited: 1`; the first row now reads
   `2026-09-20T00:00:00.000Z`; the second still reads `2026-08-01T00:00:00.000Z`.
5. **Invalid zone:** `PUT` with `{"timezone":"Mars/Olympus_Mons"}` → HTTP 400.
6. **Restart the server.** Confirm no migration log line appears — nothing left to do.
7. **Restore:** `./dev.sh --fresh --setup-only`, stop the server.

Read the settings route for the exact request shape; adapt and say what you used.

- [ ] **Step 3: Verify in a browser.** Load `/settings` with no timezone saved and confirm the field
  is prefilled with the browser's zone, with no hydration warning in the console.

- [ ] **Step 4: Verify, then commit**

`npm run lint && npm test && npm run build`.

```bash
git commit -am "feat: add a timezone setting, prefilled from the browser

Lets the owner tell BlackVault their timezone so legacy dates are
converted to the day they meant. Prefilled after mount from the
browser, never during server rendering.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

| Spec criterion | Task |
|---|---|
| `normalizeInstant` correct for the three examples and a DST day | 1 |
| Legacy row normalized at start, original audited | 1 (unit), 3 (live step 2) |
| UTC-midnight row never touched or audited | 1 |
| Idempotent for the same zone | 1 (unit), 3 (live step 6) |
| Saving a timezone re-converts from originals | 1 (unit), 3 (live step 4) |
| A user-edited row is not overwritten | 1 (unit), 3 (live step 4) |
| Invalid timezone → 400 | 2 (unit), 3 (live step 5) |
| Migration failure doesn't block startup | 2 (`runStartupDateMigration` never throws) |
| Settings field prefilled from the browser | 3 |
| Lint / tests / build | every task |

**Known risks:** the DST test depends on the host's ICU data, which ships with Node. `$transaction`
array form holds one connection, which is safe under SQLite's `connection_limit=1`.
