# Item Categories Phase 4 — Supplies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track consumable stores — cleaning supplies, medical, food, water, batteries — with a
quantity, a unit, a low-stock threshold and an expiry date, surfaced where they matter: in their
own sections, and on the dashboard beside the ammo low-stock warning that already exists.

**Architecture:** One `Supply` model for every consumable, because they share a shape: an amount,
a unit, a threshold, and usually a date after which the stock is no good. Expiry and low-stock
are pure predicates in one module so the dashboard, the section pages and the export all agree.
The expiry warning window is a setting, not a constant, because 90 days is wrong for both milk
and body armor.

**Tech Stack:** Next.js 16.1.6 App Router, Prisma 5.22 (one base schema, both providers),
Tailwind, vitest (`environment: "node"`).

**Spec:** `docs/superpowers/specs/2026-09-22-item-categories-design.md` — Phase 4 of six.

## Global Constraints

Every one of these was paid for in phases 1-3.

- **Blank means null, and `Number(" ")` is `0`.** A blank-means-null check must **trim first**.
  This family has shipped three times here (accessories form, gear form, NFA tax). Any new
  numeric or text normalizer gets whitespace coverage from the start, and the test covers the
  family, not one field.
- **`null` semantics depend on the column.** Nullable column: explicit `null` clears. `NOT NULL
  DEFAULT` column: `null` is treated like an absent key and the stored value is preserved. A
  body omitting a field never changes that field.
- **Preserve on malformed, never reset.** `normalizeQuantity(value, existing.quantity)` on
  update — an emptied number input posts `""` and must keep the stored value.
- **Enforce rules for values this build understands; pass unknown values through untouched.**
  That is how restore avoids silently destroying data written by a later build.
- **No `Promise.all` over Prisma queries.** SQLite runs `connection_limit=1`; a pool timeout
  raises the app's full-screen outage notice. `src/app/api/backup/route.test.ts` pins
  `maxInFlight === 1`.
- **PUT, not PATCH.**
- **Route tests assert on the arguments handed to the mocked Prisma call**, not on return values.
- **State per test whether it fails against the pre-change code.** "Verified once by hand" and
  "guarded against regression" are different claims; keep them apart.
- **Catch-alls by negation, never allowlists** — a category nobody planned for must land in
  exactly one section, not zero.
- **`whereForX(...) ?? undefined` is forbidden**: it turns "matches nothing here" into "match
  everything". Two live bugs so far.
- **A schema change and its backup registration are ONE task.** Splitting them leaves the
  DMMF guard test red in between, which phase 3 proved is a plan defect, not a workflow.
- **Adding an enum value breaks every `Record<Enum, …>` map**, and only `tsc` catches it.
- **`truncate` plus `flex` on one element hides its siblings**; truncating text gets its own
  `truncate min-w-0` element, siblings `shrink-0` outside it.
- **`react-hooks/set-state-in-effect` is an ESLint ERROR here.**
- **Never hand-edit the generated provider schemas**; `npm run gen:schemas` owns them, and
  `CONTRIBUTING.md` "Changing the schema" documents the Postgres baseline procedure.
- **Dates are date-only** via `toDateOnlyUTC` / `toISODate` / `formatDateOnly`.
- **Print CSS is a renderer**: if you touch the export preview, measure under `media: print`,
  and scope any `body` rule with `body:has(.armory-preview-print)` — an unscoped one made other
  pages print white-on-white in phase 3.
- **`npx prettier --write` only on files already prettier-clean** — check each first.
- Verification, real numbers reported: `npx tsc --noEmit -p .` (ZERO outside `*.test.ts`; ~16
  pre-existing inside are baseline), `npm test` (currently **445 across 41 files**),
  `npm run lint` (**0 errors**, 16 pre-existing warnings), `npm run build` once per task, and
  `bash scripts/check-migration-drift.sh` for anything touching `prisma/`.
- Accent `#00C2FF`, error `#E53935`, success `#00C853`, amber `#F5A623` for warnings; dark tokens
  `text-vault-text`, `bg-vault-surface`, `border-vault-border`, `text-vault-text-muted`; `—` for
  nulls; every page checked at 390px.

**Explicitly NOT in this phase:** the `Kit` / `KitItem` models, armor fields, gear categories
beyond knives and cases, and the remaining four Preparedness sections (Power & Comms, Shelter &
Clothing, Tools & Fire, Other Prep) — phase 5 adds those. Deduct-on-use from maintenance or range
sessions is out by an earlier decision: levels are set by hand.

---

## The timezone decision, stated once

"Expired" compares a date-only value against **today**, and today differs by timezone. This
project's rule is that app time is the browser's local time while stored time is UTC.

The dashboard and the section pages are **server components**, so they cannot read the browser's
timezone. Therefore:

- The predicates in `src/lib/supply.ts` take **today as an argument**. They never call
  `new Date()` themselves.
- Server callers pass today resolved in `AppSettings.timezone` when it is set, falling back to
  UTC. That field already exists and is already used for exactly this kind of conversion.
- Client callers pass today in the browser's timezone.
- Both use the same comparison, so they can differ by at most one day, and only when
  `AppSettings.timezone` is unset or wrong.

Task 1 implements that signature; Task 6 wires the server side. Do not let a predicate read the
clock.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/supply.ts` | **Create:** categories, units, labels, `normalizeSupplyCategory`, `normalizeSupplyUnit`, `normalizeAmount`, `isLowStock`, `expiryStatus`. |
| `src/lib/supply.test.ts` | **Create:** the predicate and normalizer matrix. |
| `prisma/schema.base.prisma` | Modify: `model Supply`; `AppSettings.expiryWarningDays`. |
| `src/lib/backup/models.ts` | Modify: register `Supply`. |
| `src/app/api/supplies/route.ts` + `route.test.ts` | **Create:** GET (`?section=` aware) + POST. |
| `src/app/api/supplies/[id]/route.ts` + `route.test.ts` | **Create:** GET + PUT + DELETE. |
| `src/lib/categories.ts` + test | Modify: the `"supply"` source, the Cleaning / Medical / Food & Water sections, `supplyWhereForSection`. |
| `src/app/api/categories/counts/route.ts` + test | Modify: count the supply source. |
| `src/components/layout/Sidebar.tsx` | Modify: the Preparedness nav group. |
| `src/app/supplies/SupplyClientPage.tsx` | **Create:** the list UI with LOW and expiry badges. |
| `src/app/prep/[slug]/page.tsx` | **Create:** the Preparedness section pages. |
| `src/app/cleaning/page.tsx` | **Create:** the Cleaning section page. |
| `src/app/supplies/new/page.tsx`, `src/app/supplies/item/[id]/page.tsx`, `.../edit/page.tsx` | **Create:** CRUD. |
| `src/app/api/settings/route.ts`, `src/app/settings/page.tsx` | Modify: the expiry window setting. |
| `src/app/page.tsx` | Modify: supplies in the dashboard's low-stock area, plus expiry counts. |
| `src/app/api/search/route.ts`, `src/components/search/GlobalSearch.tsx` | Modify: search supplies. |
| `src/app/api/exports/full-armory/route.ts`, `src/lib/exports/full-armory.ts`, `src/app/exports/full-armory/preview/page.tsx` | Modify: a Supplies export section. |

---

## Task 1: Units, categories and the two predicates

**Files:** Create `src/lib/supply.ts`, `src/lib/supply.test.ts`

**Interfaces produced:**
- `SUPPLY_CATEGORIES = ["CLEANING","MEDICAL","FOOD","WATER","FILTER","BATTERY","FUEL","SANITATION","CBRN_FILTER","SIGNAL","OTHER"]`, `SupplyCategory`, `SUPPLY_CATEGORY_LABELS`, `DEFAULT_SUPPLY_CATEGORY = "OTHER"`
- `SUPPLY_UNITS = ["COUNT","OZ","ML","L","GAL","LB","KIT","CAL"]`, `SupplyUnit`, `SUPPLY_UNIT_LABELS`, `DEFAULT_SUPPLY_UNIT = "COUNT"`
- `normalizeSupplyCategory(value: unknown): SupplyCategory`
- `normalizeSupplyUnit(value: unknown): SupplyUnit`
- `normalizeAmount(value: unknown, fallback?: number | null): number | null` — a **decimal**, non-negative, blank/whitespace/malformed → the fallback (default `null`)
- `isLowStock(row: { quantity: number; lowStockAlert: number | null }): boolean`
- `type ExpiryStatus = "none" | "fine" | "soon" | "expired"`
- `expiryStatus(expirationDate: Date | null, today: Date, warningDays: number): ExpiryStatus`
- `DEFAULT_EXPIRY_WARNING_DAYS = 90`

The rules:
1. Low when `lowStockAlert` is set and `quantity <= lowStockAlert`. A null threshold means
   **never low**. A zero threshold means low **at zero** — it is a real threshold, not "unset".
2. `expiryStatus` returns `"none"` with no date, `"expired"` when the date is strictly before
   today, `"soon"` when it is today or within `warningDays` after, else `"fine"`. **Expiring
   today is `"soon"`, not `"expired"`** — you can still use it today.
3. Comparison is date-only. Both arguments are treated as calendar days; time of day never
   changes the answer.
4. `warningDays` of 0 means "warn only on the day itself"; a negative or malformed window falls
   back to `DEFAULT_EXPIRY_WARNING_DAYS`.
5. Quantities are decimals — solvent comes in fractions of an ounce, water in fractions of a
   gallon — so unlike `AmmoStock.quantity` this is not an integer, and `normalizeAmount` must not
   floor.

- [ ] **Step 1: Write the failing test**

Create `src/lib/supply.test.ts`. The matrix is the deliverable; include at minimum:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPIRY_WARNING_DAYS,
  DEFAULT_SUPPLY_CATEGORY,
  DEFAULT_SUPPLY_UNIT,
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  SUPPLY_UNITS,
  SUPPLY_UNIT_LABELS,
  expiryStatus,
  isLowStock,
  normalizeAmount,
  normalizeSupplyCategory,
  normalizeSupplyUnit,
} from "./supply";

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("enums", () => {
  it("labels every category and unit", () => {
    for (const c of SUPPLY_CATEGORIES) expect(SUPPLY_CATEGORY_LABELS[c]).toBeTruthy();
    for (const u of SUPPLY_UNITS) expect(SUPPLY_UNIT_LABELS[u]).toBeTruthy();
  });

  it("defaults to values that exist", () => {
    expect(SUPPLY_CATEGORIES).toContain(DEFAULT_SUPPLY_CATEGORY);
    expect(SUPPLY_UNITS).toContain(DEFAULT_SUPPLY_UNIT);
  });
});

describe("normalizeSupplyCategory / normalizeSupplyUnit", () => {
  it("accepts, trims and upper-cases", () => {
    expect(normalizeSupplyCategory(" medical ")).toBe("MEDICAL");
    expect(normalizeSupplyUnit(" gal ")).toBe("GAL");
  });

  it("falls back on anything unrecognised, including whitespace", () => {
    for (const bad of ["ZZ", "", "   ", undefined, null, 7, {}]) {
      expect(normalizeSupplyCategory(bad), String(bad)).toBe(DEFAULT_SUPPLY_CATEGORY);
      expect(normalizeSupplyUnit(bad), String(bad)).toBe(DEFAULT_SUPPLY_UNIT);
    }
  });
});

describe("normalizeAmount", () => {
  it("keeps decimals — solvent comes in fractions of an ounce", () => {
    expect(normalizeAmount(12.5)).toBe(12.5);
    expect(normalizeAmount("0.75")).toBe(0.75);
  });

  it("keeps a real zero", () => {
    expect(normalizeAmount(0)).toBe(0);
    expect(normalizeAmount("0")).toBe(0);
  });

  it("treats blank AND whitespace as absent, never as zero", () => {
    expect(normalizeAmount("")).toBeNull();
    expect(normalizeAmount("   ")).toBeNull();
    expect(normalizeAmount(undefined)).toBeNull();
    expect(normalizeAmount(null)).toBeNull();
  });

  it("refuses negatives and nonsense", () => {
    expect(normalizeAmount(-1)).toBeNull();
    expect(normalizeAmount("abc")).toBeNull();
    expect(normalizeAmount(Number.NaN)).toBeNull();
    expect(normalizeAmount(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("honours a fallback, for an update that must preserve the stored value", () => {
    expect(normalizeAmount("", 12.5)).toBe(12.5);
    expect(normalizeAmount("   ", 12.5)).toBe(12.5);
    expect(normalizeAmount("bad", 12.5)).toBe(12.5);
  });
});

describe("isLowStock", () => {
  it("is low at or below the threshold", () => {
    expect(isLowStock({ quantity: 2, lowStockAlert: 4 })).toBe(true);
    expect(isLowStock({ quantity: 4, lowStockAlert: 4 })).toBe(true);
    expect(isLowStock({ quantity: 5, lowStockAlert: 4 })).toBe(false);
  });

  it("never low without a threshold", () => {
    expect(isLowStock({ quantity: 0, lowStockAlert: null })).toBe(false);
  });

  it("treats a zero threshold as a real threshold, low only at zero", () => {
    expect(isLowStock({ quantity: 0, lowStockAlert: 0 })).toBe(true);
    expect(isLowStock({ quantity: 0.5, lowStockAlert: 0 })).toBe(false);
  });
});

describe("expiryStatus", () => {
  const today = day("2026-06-15");

  it("is none without a date", () => {
    expect(expiryStatus(null, today, 90)).toBe("none");
  });

  it("is expired strictly before today", () => {
    expect(expiryStatus(day("2026-06-14"), today, 90)).toBe("expired");
  });

  it("is soon — not expired — on the day itself", () => {
    expect(expiryStatus(day("2026-06-15"), today, 90)).toBe("soon");
  });

  it("is soon inside the window and fine outside it", () => {
    expect(expiryStatus(day("2026-09-13"), today, 90)).toBe("soon");
    expect(expiryStatus(day("2026-09-14"), today, 90)).toBe("fine");
  });

  it("ignores time of day on both sides", () => {
    const lateToday = new Date("2026-06-15T23:59:59.000Z");
    expect(expiryStatus(new Date("2026-06-15T00:00:01.000Z"), lateToday, 90)).toBe("soon");
  });

  it("with a zero window warns only on the day itself", () => {
    expect(expiryStatus(day("2026-06-15"), today, 0)).toBe("soon");
    expect(expiryStatus(day("2026-06-16"), today, 0)).toBe("fine");
  });

  it("falls back on a malformed window rather than warning about everything", () => {
    expect(expiryStatus(day("2026-08-01"), today, -5)).toBe(
      expiryStatus(day("2026-08-01"), today, DEFAULT_EXPIRY_WARNING_DAYS),
    );
    expect(expiryStatus(day("2026-08-01"), today, Number.NaN)).toBe(
      expiryStatus(day("2026-08-01"), today, DEFAULT_EXPIRY_WARNING_DAYS),
    );
  });

  it("never reads the clock itself — same inputs, same answer", () => {
    const a = expiryStatus(day("2026-06-20"), today, 90);
    const b = expiryStatus(day("2026-06-20"), today, 90);
    expect(a).toBe(b);
    expect(a).toBe("soon");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- src/lib/supply.test.ts`
Expected: FAIL — cannot resolve `./supply`.

- [ ] **Step 3: Write the module**

Create `src/lib/supply.ts`. Follow the shape of `src/lib/gear.ts` and `src/lib/nfa.ts` for the
normalizers (trim, upper-case, membership, fall back). For the date comparison, compare calendar
days — derive a day number from each date's UTC year/month/day rather than subtracting
milliseconds, so a DST boundary cannot shift an answer.

`expiryStatus` must not call `new Date()`. That is what makes it testable and what keeps the
server and client answers consistent; a comment saying so belongs in the file.

- [ ] **Step 4: Run to verify it passes, then commit**

```bash
npm test -- src/lib/supply.test.ts
git add src/lib/supply.ts src/lib/supply.test.ts
git commit -m "feat: add supply categories, units and the low-stock and expiry predicates"
```

---

## Task 2: The Supply model, the setting, and backup registration

**Files:** Modify `prisma/schema.base.prisma`, `src/lib/backup/models.ts`, `src/lib/backup/models.test.ts`

These are ONE task on purpose: the DMMF guard in `models.test.ts` fails the moment a model exists
unregistered, so splitting them would leave the suite red between two commits.

- [ ] **Step 1: Add the model and the setting**

In `prisma/schema.base.prisma`, after `model Gear`:

```prisma
// Consumable stores: cleaning, medical, food, water, batteries. One model
// because they share a shape — an amount, a unit, a threshold, and usually a
// date after which the stock is no good. Levels are set by hand; nothing
// deducts automatically (guessing how much CLP a cleaning used would make the
// numbers worse, not better).
model Supply {
  id              String    @id @default(cuid())
  name            String
  brand           String?
  // SupplyCategory: CLEANING | MEDICAL | FOOD | WATER | FILTER | BATTERY |
  //                 FUEL | SANITATION | CBRN_FILTER | SIGNAL | OTHER
  category        String
  // A decimal, unlike AmmoStock.quantity: solvent comes in fractions of an
  // ounce and water in fractions of a gallon.
  quantity        Float     @default(0)
  // SupplyUnit: COUNT | OZ | ML | L | GAL | LB | KIT | CAL
  unit            String
  lowStockAlert   Float?
  expirationDate  DateTime?
  purchasePrice   Float?
  purchaseDate    DateTime?
  storageLocation String?
  notes           String?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([category])
  @@index([expirationDate])
}
```

In `model AppSettings`, beside `defaultAmmoAlertThreshold`:

```prisma
  // Days ahead to warn that a supply is expiring. One fixed window would be
  // wrong for both milk and body armor, so it is a setting. null = use the
  // default in src/lib/supply.ts.
  expiryWarningDays       Int?
```

`expirationDate` is indexed because the dashboard queries by it on every load; `category` because
every section page filters on it.

- [ ] **Step 2: Generate, migrate, check drift**

```bash
npm run gen:schemas
npx prisma migrate dev --name add_supply_model --schema prisma/sqlite/schema.prisma --skip-generate
npm run db:generate
npm run gen:schemas
bash scripts/check-migration-drift.sh
```

Read `CONTRIBUTING.md` "Changing the schema" first. If the Postgres leg reports SKIPPED for want
of a scratch database, regenerate `0_init` with `prisma migrate diff --from-empty` and confirm
byte-identical, and say in your report that you did that rather than running the check.

If the SQLite migration rebuilds `AppSettings` rather than adding a column, read its
`INSERT ... SELECT` and confirm **column by column** that every pre-existing column appears on
both sides — that table holds the user's LAN host, paths, keys and timezone.

- [ ] **Step 3: Watch the backup guard fail, then register**

```bash
npm test -- src/lib/backup/models.test.ts
```

Expected: FAIL — `Supply` is neither registered nor excluded. That guard exists because
MaintenanceLog and BatteryChangeLog were once added to the schema and left out of backups, so
restore cascade-deleted them while reporting success.

Then add to `BACKUP_MODELS` in `src/lib/backup/models.ts`:

```ts
  { model: "Supply", delegate: "supply", key: "supplies" },
```

`Supply` has no foreign keys and nothing references it, so its position is free — put it after
`Gear`. Do **not** touch the v1.0 required-keys list: required-ness is derived by NAME, not
position, and `supplies` must stay optional so every existing backup still restores. Add a test
asserting `supplies` is absent from `REQUIRED_BACKUP_KEYS`.

- [ ] **Step 4: Verify and commit**

```bash
npx tsc --noEmit -p . && npm test && npm run lint
git add prisma/ src/lib/backup/
git commit -m "feat: add the Supply model, the expiry window setting, and backup registration"
```

---

## Task 3: The supplies API

**Files:** Create `src/app/api/supplies/route.ts` + `route.test.ts`, `src/app/api/supplies/[id]/route.ts` + `route.test.ts`

**Read `src/app/api/gear/route.ts` and `src/app/api/gear/[id]/route.ts` first and mirror them** —
same `normalizeString`, same error shapes, PUT not PATCH, `export const dynamic = "force-dynamic"`,
sequential queries.

Behaviours the tests must pin, asserting on the `data` or `where` handed to Prisma:

- POST requires a name; category and unit are normalized; a missing quantity is `0`.
- POST with `quantity: "12.5"` stores `12.5` — not floored.
- PUT changing only `notes` leaves quantity, unit, category and the dates untouched.
- PUT with `quantity: ""` **keeps the stored quantity** (an emptied input must not zero it).
- PUT with an explicit `lowStockAlert: null` clears the threshold; an absent key leaves it.
- PUT with `quantity: 0` stores `0` — a real zero, not "absent".
- `?section=<a supply-backed slug>` filters by that section's categories; a section with no
  supply source returns `[]` **without querying**; an unknown slug applies no filter.
- DELETE 404s a missing row rather than quietly succeeding.

The section resolution needs `supplyWhereForSection`, which Task 4 adds. Resolve the categories
inline for now in a way Task 4 can replace with one call, and say in your report exactly what to
replace — that hand-off worked cleanly in phase 2.

- [ ] Write the failing tests → run → implement → run → verify (`tsc`, `test`, `lint`, `build`) → commit as `feat: add the supplies API`.

---

## Task 4: Registry sections, counts, and the Preparedness nav group

**Files:** Modify `src/lib/categories.ts` + test, `src/app/api/categories/counts/route.ts` + test, `src/components/layout/Sidebar.tsx`, `src/app/api/supplies/route.ts`

**Interfaces produced:** the `"supply"` source arm, `SupplyRow = { category: string }`,
`supplyWhereForSection`, `supplySectionForItem`, and three sections:

| Group | Slug | Label | Matches |
| --- | --- | --- | --- |
| gear | `cleaning` | Cleaning | supply `CLEANING` |
| prep | `medical` | Medical | supply `MEDICAL` |
| prep | `food-water` | Food & Water | supply `FOOD, WATER, FILTER` |

**A spec conflict I am resolving here:** the spec lists the Cleaning / Medical / Food & Water
sections in phase 4 but the Preparedness nav group in phase 5. Sections without a nav home would
be unreachable, so **this phase creates the `prep` group containing just Medical and Food & Water**,
and phase 5 expands it to seven. Cleaning sits in the `gear` group — it is gun maintenance, not a
bugout store — even though its rows are supplies.

The catch-all: every `SupplyCategory` must resolve to exactly one section, and phase 4 has
sections for only some of them. Hang the negation on `food-water` the way phase 2 hung the gear
catch-all on `cases` — so `BATTERY`, `FUEL`, `SANITATION`, `CBRN_FILTER`, `SIGNAL` and `OTHER`
land there until phase 5 gives them homes. State that reasoning in a comment; it is deliberate,
and phase 5 will restructure it.

Extend the exhaustiveness tests: every `SUPPLY_CATEGORIES` value plus junk, empty string and
wrong case resolves to exactly one section, and the `where` fragment agrees with the `holds`
predicate through the existing harness (which must handle the `OR` shape the catch-all produces).

Counts: add a supply branch to the loop, **sequentially**. Sidebar: a third `NavGroup` for
Preparedness, following the existing Vault and Gear groups exactly.

- [ ] Write the failing tests → run → implement → replace Task 3's inline filter → run → verify → commit as `feat: add cleaning, medical and food & water sections with a preparedness nav group`.

---

## Task 5: The supplies list and section pages

**Files:** Create `src/app/supplies/SupplyClientPage.tsx`, `src/app/prep/[slug]/page.tsx`, `src/app/cleaning/page.tsx`

Read `src/app/gear/GearClientPage.tsx` and `src/app/gear/[slug]/page.tsx` and follow them — the
same card/table split, the same retry UI, the same empty state.

Each row shows: name, brand, `quantity unit` (e.g. `12.5 oz`), storage location, and badges:
- **LOW** in amber when `isLowStock`
- **EXPIRED** in red, **SOON** in amber, from `expiryStatus`

The badges are siblings of a `truncate min-w-0` name element, `shrink-0` — the phase-1 bug where
a badge vanished for long names must not reappear.

`expiryStatus` needs today and the window. These are server components: resolve today in
`AppSettings.timezone` (falling back to UTC) and read `expiryWarningDays` (falling back to the
default), then pass both in. Do not call `new Date()` inside a predicate.

Routes: `/cleaning` for the one gear-group supply section; `/prep/[slug]` for the Preparedness
ones. A slug with no supply source 404s — never queries unfiltered.

- [ ] Implement → verify in a browser at desktop and 390px with a long-named supply, an expired
  one, an expiring one and a low one → delete the test records → verify → commit as
  `feat: add the supplies list and section pages`.

---

## Task 6: Supplies CRUD, the dashboard, and the setting

**Files:** Create `src/app/supplies/new/page.tsx`, `src/app/supplies/item/[id]/page.tsx`, `.../edit/page.tsx`; modify `src/app/page.tsx`, `src/app/api/settings/route.ts`, `src/app/settings/page.tsx`

**CRUD:** follow the gear forms. Fields: name, brand, category, quantity, unit, low-stock
threshold, expiration date, purchase price, purchase date, storage location, notes.

**The edit form is the risk.** Phases 1, 2 and 3 each hit a field that was not initialised from
the loaded record and was silently overwritten on save. Initialise every field, and verify
through `GET /api/supplies/[id]` — **not the rendered page** — that editing only the notes leaves
quantity, unit, category, both dates and the threshold unchanged.

**The dashboard** (`src/app/page.tsx`) already computes `lowStockItems` from ammo stocks. Add
supplies: low-stock supplies alongside the ammo ones (label them so a user can tell a supply from
a caliber), plus **expired** and **expiring soon** counts. Read `AppSettings` once for the
timezone and the window; do not query it per row, and keep every query sequential.

**The setting:** `expiryWarningDays` in the API and on the Settings page, beside
`defaultAmmoAlertThreshold` — read that field's handling end to end and mirror it, including how
a blank input becomes null. Blank means "use the default", and the helper text should say the
default in days.

- [ ] Implement → verify: create a supply expiring in 30 days, confirm SOON; set the window to 10
  and confirm it reads FINE; set it blank and confirm SOON returns → verify the edit round-trip
  through the API → check the dashboard counts → 390px → delete the records → verify → commit in
  two commits (`feat: add supplies create, detail and edit pages`, then
  `feat: surface supply low stock and expiry on the dashboard`).

---

## Task 7: Search and the export

**Files:** Modify `src/app/api/search/route.ts`, `src/components/search/GlobalSearch.tsx`, `src/app/api/exports/full-armory/route.ts`, `src/lib/exports/full-armory.ts`, `src/app/exports/full-armory/preview/page.tsx`

**Search:** a `supplies` key, matching name, brand and category with `containsInsensitive` — never
a bare `contains`, which was silently case-sensitive on Postgres. Sequential, same `take`, explicit
`select`, and the key must appear in the empty-query response so the UI cannot read `undefined`.
Add the results group and link rows to `/supplies/item/[id]`. Prove the helper is used by spying
on it — on SQLite a bare `contains` is behaviourally identical, so a results-only test cannot
catch a regression.

**Export:** a Supplies section with name, brand, category label, quantity, unit, threshold,
expiry, price, purchase date, storage location, notes — plus a `totalSupplies` summary counter,
and supplies included in `missingEvidence` where the counters meaningfully apply (check which do;
phase 3 learned that a headline count and its "missing" counters must share a denominator).

**The export has four renderers** — JSON, CSV, PDF and the preview page. Phase 2 shipped a gear
section that reached the payload but missed the PDF's image line, and it looked complete. **Name
in your report the exact place each of the four emits the supplies section**, and verify each.
If you touch the preview's print path, measure under `media: print` and keep any `body` rule
scoped with `body:has(.armory-preview-print)`.

- [ ] Write failing tests → implement → verify all four renderers with real records → delete them
  → verify → commit as `feat: include supplies in search and the full-armory export`.

---

## Verification before the phase is called done

```bash
npm test && npm run lint && npx tsc --noEmit -p . && npm run build
bash scripts/check-migration-drift.sh
```

Then, dev server running, at desktop and 390px:

1. A supply with a decimal quantity round-trips: `12.5 oz` stays `12.5`, not `12` or `13`.
2. Editing only a supply's notes leaves every other field untouched (checked via the API).
3. An emptied quantity input preserves the stored value rather than zeroing it.
4. LOW, EXPIRED and SOON badges appear correctly, and a long name does not hide them.
5. Changing `expiryWarningDays` in Settings changes which supplies read SOON.
6. The dashboard shows low-stock supplies beside low ammo, plus expired and expiring counts.
7. A supply with an unrecognised category is visible in exactly one section, not missing.
8. Back up, delete a supply, restore: it returns. A backup taken **before** this phase still
   restores.
9. Supplies appear in search and in all four export renderers.
10. `/vault`, `/accessories`, `/gear`, `/builds`, `/ammo` and the configurator behave as before.
