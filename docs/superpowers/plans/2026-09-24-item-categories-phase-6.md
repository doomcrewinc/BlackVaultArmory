# Item Categories Phase 6 — Kits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `Kit` and `KitItem` — packing lists that point at inventory, with target quantities, a missing count, over-allocation flagged across kits, and an expiry rollup.

**Architecture:** A kit is a container, not a copy. A `KitItem` holds exactly one of five foreign keys — or none plus a free-text `label` — and says how much of that record lives in this kit. Prisma cannot express "exactly one of five" portably, so the API enforces it and a test covers every shape. Allocation across kits is flagged, never blocked. Kits join the category registry as a new `kit` source, which is what phase 5's compile-time guards exist to catch.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 5.22, vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-22-item-categories-design.md` — `### Kit and KitItem: what is packed where` (the model and the four rules), the Kits row in `### Sections`, `**Kit page**` in `## UI`, and the backup bullet in `## Data flow, backup and export`.

## Global Constraints

- **Verify with the FULL suite:** `npx vitest run`. Branch starts at 679/679 across 48 files. Never verify with a scoped file list — a scoped run let a breakage through twice in phase 5.
- **`npx tsc --noEmit -p .` baseline is exactly 16 errors**, all in `src/app/api/exports/data/route.backup.test.ts` (14) and `scripts/check-migration-drift.test.ts` (2). Anything else is yours.
- **SQLite runs `connection_limit=1`.** Sequential awaits only, never `Promise.all` over Prisma queries. `src/app/api/backup/route.test.ts` pins `maxInFlight === 1`.
- **Routes expose `PUT`, never `PATCH`.**
- **`?? undefined` on a where-builder is FORBIDDEN** — it turns "matches nothing here" into "match everything", and has caused two live bugs in this epic.
- **Catch-alls are defined by negation (`notIn`), never an allowlist.**
- **`Number("")` and `Number(" ")` are both `0`.** Numeric normalizers trim before deciding "absent". Use `normalizeMoney` from `@/lib/money` for currency.
- **Expiry predicates never read the clock.** They take `today`; `todayForExpiry(timezone, now)` from `@/lib/supply` is the only sanctioned way to build it, resolved once per request from `AppSettings`.
- **A `NOT NULL DEFAULT` column treats explicit `null` as absent; a nullable column treats it as "clear".**
- **Schema changes go through `npm run gen:schemas`.** Never hand-edit the generated `prisma/{postgres,sqlite}/schema.prisma`.
- **Prove guards by injection, not inspection.** Break it, watch the named test or tsc error fire, restore, verify byte-identical. Phase 5 found four dead or vacuous guards this way that reading had passed every time.
- **No test may assert a hardcoded list against itself, use `toBeTruthy()` where `{}` would also pass, compare a value against an expression derived from that same value, or assert one literal against another.** All four shipped in this project; two were caught inside phase 5.
- Path alias `@/` = `src/`. Accent `#00C2FF`, error `#E53935`, amber `#F5A623`, success `#00C853`. Classes `text-vault-text`, `text-vault-text-muted`, `bg-vault-surface`, `border-vault-border`.

---

## File Structure

**Created:**
- `src/lib/kit.ts` — `KIT_CATEGORIES`, labels, `normalizeKitCategory`, and `KIT_ITEM_SOURCES` (the five FK field names as one list everything else derives from).
- `src/lib/kits/kitItemSource.ts` — the exactly-one-or-label rule, as a pure function plus its error type.
- `src/lib/kits/allocation.ts` — allocation across kits, the missing count, and the expiry rollup. Pure; takes `today` as an argument.
- `src/app/api/kits/route.ts`, `src/app/api/kits/[id]/route.ts`, `src/app/api/kits/[id]/items/route.ts`, `src/app/api/kits/[id]/items/[itemId]/route.ts` (+ tests)
- `src/app/kits/page.tsx`, `src/app/kits/[id]/page.tsx`, `src/app/kits/new/page.tsx`, `src/app/kits/KitsClientPage.tsx`, `src/app/kits/[id]/KitContents.tsx`, `src/app/kits/[id]/AddKitItem.tsx`
- `prisma/migrations-sqlite/<timestamp>_kits/migration.sql` — generated.

**Modified:**
- `prisma/schema.base.prisma` — `Kit`, `KitItem`, and a `kitItems` back-relation on `Firearm`, `Accessory`, `AmmoStock`, `Gear`, `Supply`.
- `src/lib/backup/models.ts` (+ its DMMF-guarded test) — `Kit` then `KitItem`, last.
- `src/lib/categories.ts` — a `kit` source kind and the Kits section.
- `src/lib/sections/renderableSources.ts`, `src/components/sections/SectionView.tsx`, `src/lib/sections/loadSectionItems.ts` — the new source kind, which the phase-5 guards force you to handle.
- `src/app/api/search/route.ts`, the export routes, `src/lib/dashboard/get-dashboard-stats.ts`.

---

### Task 1: The schema, the category vocabulary, and the backup registry

**Files:**
- Modify: `prisma/schema.base.prisma`
- Create: `src/lib/kit.ts`, `src/lib/kit.test.ts`
- Modify: `src/lib/backup/models.ts`
- Test: `src/lib/backup/models.test.ts`

**Interfaces produced:** `KIT_CATEGORIES`, `KIT_CATEGORY_LABELS`, `DEFAULT_KIT_CATEGORY`, `normalizeKitCategory`, `KIT_ITEM_SOURCES`; the `Kit` and `KitItem` tables.

- [ ] **Step 1: Add both models to the base schema**

Copy the two models from the spec's `### Kit and KitItem` section VERBATIM — they are given in full there, including every relation, `onDelete: Cascade` on all six, and both `@@index` lines. Do not improvise the shape.

Then add the back-relation to each of the five inventory models:

```prisma
  kitItems        KitItem[]
```

on `Firearm`, `Accessory`, `AmmoStock`, `Gear` and `Supply`. Prisma errors on a one-sided relation, so a missing one fails `npm run gen:schemas` rather than shipping.

- [ ] **Step 2: Write the failing vocabulary test**

Create `src/lib/kit.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KIT_CATEGORY,
  KIT_CATEGORIES,
  KIT_CATEGORY_LABELS,
  KIT_ITEM_SOURCES,
  normalizeKitCategory,
} from "./kit";

describe("kit categories", () => {
  it("carries the six the spec names", () => {
    expect([...KIT_CATEGORIES]).toEqual([
      "BUGOUT",
      "MEDICAL",
      "RANGE",
      "VEHICLE",
      "HOME",
      "OTHER",
    ]);
  });

  it("labels every category, with no label left as the raw token", () => {
    for (const category of KIT_CATEGORIES) {
      const label = KIT_CATEGORY_LABELS[category];
      expect(label, `${category} has no label`).toBeTruthy();
      expect(label).not.toBe(category);
    }
  });

  it("falls back rather than throwing on input from outside the enum", () => {
    expect(normalizeKitCategory("NOPE")).toBe(DEFAULT_KIT_CATEGORY);
    expect(normalizeKitCategory(undefined)).toBe(DEFAULT_KIT_CATEGORY);
    expect(normalizeKitCategory("  bugout  ")).toBe("BUGOUT");
  });

  it("names the five KitItem foreign keys, in schema order", () => {
    expect([...KIT_ITEM_SOURCES]).toEqual([
      "gearId",
      "supplyId",
      "accessoryId",
      "ammoStockId",
      "firearmId",
    ]);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then write `src/lib/kit.ts`**

Follow `src/lib/gear.ts` exactly for shape: a `readonly` tuple, a `Record<KitCategory, string>` labels map (so a missed label is TS2741, not a runtime `undefined`), a `DEFAULT_KIT_CATEGORY`, and a `normalizeKitCategory` that trims, uppercases, and falls back. Add:

```ts
/**
 * The five foreign keys a KitItem may set, in schema order. ONE definition:
 * the exactly-one rule, the API's validation, the picker and the tests all
 * derive from this rather than restating five field names. A hand-maintained
 * list that pins itself is the shape this project has paid for three times.
 */
export const KIT_ITEM_SOURCES = [
  "gearId",
  "supplyId",
  "accessoryId",
  "ammoStockId",
  "firearmId",
] as const;

export type KitItemSourceField = (typeof KIT_ITEM_SOURCES)[number];
```

- [ ] **Step 4: Register both models for backup**

In `src/lib/backup/models.ts`, append to `BACKUP_MODELS` — **`Kit` before `KitItem`, both LAST**:

```ts
  { model: "Kit", delegate: "kit", key: "kits" },
  { model: "KitItem", delegate: "kitItem", key: "kitItems" },
```

`BACKUP_MODELS` is parent-first restore order. `KitItem` points at five inventory models plus `Kit`, all of which sit earlier, so the end of the array is FK-safe. Do **not** add either to `V1_0_MODEL_NAMES`: that set is what a pre-existing backup file is REQUIRED to contain, and a backup written before this branch has neither key. Adding them there rejects every existing backup with a 400 — the exact near-miss phase 4 caught.

Read the comment above `REQUIRED_BACKUP_KEYS` before you touch this file; it explains why restore order and required-ness cannot both come from array position.

- [ ] **Step 5: Generate, migrate, verify**

```bash
npm run gen:schemas
npx prisma migrate dev --schema prisma/sqlite/schema.prisma --name kits
```

Regenerate the Postgres `0_init` in place per `CONTRIBUTING.md` "Changing the schema". Then:

```bash
npx prisma generate --schema prisma/sqlite/schema.prisma
bash scripts/check-migration-drift.sh
```

Expected: sqlite reports "ok: no drift". The Postgres leg SKIPs without a `SHADOW_DATABASE_URL` — that is a known carried gap, not your problem to solve.

`src/lib/date-migration.ts` has a DMMF guard requiring every `DateTime` column to be registered as date-only or explicitly excluded. `Kit` and `KitItem` have only `createdAt`/`updatedAt`, which are row bookkeeping — add all four to `DATE_ONLY_EXCLUDED_FIELDS` with the same reasoning the existing entries give. The guard failing until you do is it working.

- [ ] **Step 6: Prove the backup guard**

Remove the `KitItem` entry from `BACKUP_MODELS`, run `npx vitest run src/lib/backup/models.test.ts`, confirm the DMMF-derived test FAILS naming `KitItem`, restore, verify byte-identical. Report the failing test's name. Then run the full suite.

- [ ] **Step 7: Commit**

```bash
git add prisma src/lib/kit.ts src/lib/kit.test.ts src/lib/backup src/lib/date-migration.ts
git commit -m "feat: add the Kit and KitItem models and their backup registration

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The exactly-one-source rule and the allocation maths

**Files:**
- Create: `src/lib/kits/kitItemSource.ts`, `src/lib/kits/kitItemSource.test.ts`
- Create: `src/lib/kits/allocation.ts`, `src/lib/kits/allocation.test.ts`

**Interfaces produced:** `resolveKitItemSource(input)`, `KitItemSourceError`; `allocationByItem(rows)`, `isOverAllocated(...)`, `missingQuantity(item)`, `kitExpiryRollup(lines, today, warningDays)`.

Both modules are PURE — no Prisma, no clock, no `new Date()`. That is what lets the tests be cheap and the rules be reused by the API, the kit page and the export without drifting.

- [ ] **Step 1: Write the failing source-rule test**

The spec: "A `KitItem` sets one of the five foreign keys, or none of them plus a `label`." Cover every shape:

```ts
describe("resolveKitItemSource", () => {
  it("accepts exactly one foreign key", () => {
    expect(resolveKitItemSource({ gearId: "g1" })).toEqual({
      ok: true,
      field: "gearId",
      id: "g1",
      label: null,
    });
  });

  it("accepts no foreign key plus a label", () => {
    expect(resolveKitItemSource({ label: "spare keys" })).toEqual({
      ok: true,
      field: null,
      id: null,
      label: "spare keys",
    });
  });

  it("rejects two foreign keys, naming both", () => {
    const result = resolveKitItemSource({ gearId: "g1", supplyId: "s1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fields).toEqual(["gearId", "supplyId"]);
      expect(result.reason).toBe("multiple-sources");
    }
  });

  it("rejects a foreign key together with a label", () => {
    const result = resolveKitItemSource({ gearId: "g1", label: "spare keys" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("source-and-label");
  });

  it("rejects nothing at all", () => {
    const result = resolveKitItemSource({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-source");
  });

  it("treats a blank or whitespace-only label as absent", () => {
    expect(resolveKitItemSource({ label: "   " }).ok).toBe(false);
  });

  it("rejects every PAIR of the five, derived rather than hand-listed", () => {
    // Derived from KIT_ITEM_SOURCES so a sixth foreign key is covered the day
    // it is added — the five-name list lives in kit.ts and nowhere else.
    for (const a of KIT_ITEM_SOURCES) {
      for (const b of KIT_ITEM_SOURCES) {
        if (a === b) continue;
        const result = resolveKitItemSource({ [a]: "x", [b]: "y" });
        expect(result.ok, `${a}+${b} was accepted`).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 2: Run it, watch it fail, implement**

Return a discriminated union (`{ ok: true, … } | { ok: false, reason, fields }`) rather than throwing — the API turns it into a 400 with a useful message, and the picker uses it to disable invalid states. Derive the key scan from `KIT_ITEM_SOURCES`; do not restate the five names.

- [ ] **Step 3: Write the failing allocation test**

Three rules from the spec, each independently testable:

```ts
describe("allocation across kits", () => {
  it("sums one item's quantity over every kit that holds it", () => {
    const rows = [
      { accessoryId: "a1", quantity: 4 },
      { accessoryId: "a1", quantity: 8 },
      { accessoryId: "a2", quantity: 1 },
    ];
    expect(allocationByItem(rows).get("accessoryId:a1")).toBe(12);
    expect(allocationByItem(rows).get("accessoryId:a2")).toBe(1);
  });

  it("keys by source AND id, so two tables sharing an id cannot collide", () => {
    // cuid collisions across tables are vanishingly unlikely, but a bare id
    // key would make the bug silent and unfalsifiable if one ever happened.
    const rows = [
      { gearId: "x1", quantity: 2 },
      { supplyId: "x1", quantity: 5 },
    ];
    const allocation = allocationByItem(rows);
    expect(allocation.get("gearId:x1")).toBe(2);
    expect(allocation.get("supplyId:x1")).toBe(5);
  });

  it("ignores label-only lines, which allocate nothing", () => {
    expect(allocationByItem([{ label: "cash", quantity: 3 }]).size).toBe(0);
  });

  it("flags over-allocation without blocking it", () => {
    // Spec: "14 of 12 assigned" is shown, never refused.
    expect(isOverAllocated({ allocated: 14, owned: 12 })).toBe(true);
    expect(isOverAllocated({ allocated: 12, owned: 12 })).toBe(false);
    expect(isOverAllocated({ allocated: 4, owned: 12 })).toBe(false);
  });

  it("treats an unknown owned quantity as not over-allocated", () => {
    // A label-only line owns nothing measurable; flagging it would cry wolf.
    expect(isOverAllocated({ allocated: 3, owned: null })).toBe(false);
  });

  it("reports missing only when the target exceeds what is packed", () => {
    expect(missingQuantity({ quantity: 2, targetQuantity: 5 })).toBe(3);
    expect(missingQuantity({ quantity: 5, targetQuantity: 5 })).toBe(0);
    expect(missingQuantity({ quantity: 7, targetQuantity: 5 })).toBe(0);
    expect(missingQuantity({ quantity: 2, targetQuantity: null })).toBe(0);
  });
});
```

For the rollup, pass `today` explicitly and assert the boundary the timezone work exists for:

```ts
describe("kitExpiryRollup", () => {
  const today = new Date(Date.UTC(2026, 5, 15));

  it("reports the earliest expiry and counts each state", () => {
    const rollup = kitExpiryRollup(
      [
        { expirationDate: new Date(Date.UTC(2026, 5, 1)) },
        { expirationDate: new Date(Date.UTC(2026, 6, 1)) },
        { expirationDate: null },
      ],
      today,
      90,
    );
    expect(rollup.earliest).toEqual(new Date(Date.UTC(2026, 5, 1)));
    expect(rollup.expired).toBe(1);
    expect(rollup.soon).toBe(1);
  });

  it("returns a null earliest and zero counts for a kit with no dated contents", () => {
    expect(kitExpiryRollup([{ expirationDate: null }], today, 90)).toEqual({
      earliest: null,
      expired: 0,
      soon: 0,
    });
  });

  it("counts an item expiring TODAY as soon, not expired", () => {
    // The off-by-one this epic paid for: `today` is a calendar day, and an
    // item expiring on it has not expired yet.
    const rollup = kitExpiryRollup([{ expirationDate: today }], today, 90);
    expect(rollup.expired).toBe(0);
    expect(rollup.soon).toBe(1);
  });
});
```

- [ ] **Step 4: Implement, reusing `expiryStatus`**

`kitExpiryRollup` must call `expiryStatus` from `@/lib/supply` rather than re-deriving expiry. Two implementations of "expired" is how the dashboard and a section page come to disagree.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/lib/kits src/lib/kit.ts`

```bash
git add src/lib/kits src/lib/kit.ts
git commit -m "feat: the KitItem source rule and the allocation, missing and expiry maths

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The kits API

**Files:**
- Create: `src/app/api/kits/route.ts`, `src/app/api/kits/[id]/route.ts`, `src/app/api/kits/[id]/items/route.ts`, `src/app/api/kits/[id]/items/[itemId]/route.ts`
- Test: a `route.test.ts` beside each

**Interfaces consumed:** Task 1's `normalizeKitCategory`; Task 2's `resolveKitItemSource`.

Follow `src/app/api/gear/route.ts` and `src/app/api/gear/[id]/route.ts` for shape: `export const dynamic = "force-dynamic"`, a `normalizeString` helper, `PUT` not `PATCH`, 404 on a missing row, `InvalidDateError` → 400, everything else → 500 with a `console.error`.

- [ ] **Step 1: Kits collection and item**

`GET /api/kits` lists kits ordered by name. `POST` creates one: `name` required (400 if blank), `category` through `normalizeKitCategory`, the rest nullable strings.

`GET /api/kits/[id]` returns the kit with its `items`, each including whichever of the five relations it points at. `PUT` updates; `DELETE` removes the kit — cascade removes its lines and touches no inventory.

- [ ] **Step 2: The lines**

`POST /api/kits/[id]/items` adds a line. Run `resolveKitItemSource` over the body FIRST; on `ok: false` return 400 with the reason and the offending fields. `quantity` through `normalizeAmount` from `@/lib/supply` (decimal, no floor); `targetQuantity` the same but nullable.

`PUT /api/kits/[id]/items/[itemId]` updates a line. Re-run `resolveKitItemSource` over the MERGED record — what the client sent layered on what is stored — not over the body alone. A PUT that sets `supplyId` on a line that already has `gearId` must be rejected, and the body alone cannot see that. This is the merge-then-normalize rule the NFA and armor gates already follow.

`DELETE /api/kits/[id]/items/[itemId]` removes one line.

- [ ] **Step 3: Write route tests that assert on the Prisma arguments**

Mocked-Prisma style, as in `src/app/api/gear/route.test.ts`. Assert on what the route hands `prisma.kitItem.create` / `.update`, not on a helper's return — this project has had 286 tests pass while a deleted `where` clause would have shown every section the whole vault. At minimum:

1. POST a line with two foreign keys → 400, and `prisma.kitItem.create` NOT called.
2. POST a line with a foreign key and a label → 400.
3. POST a label-only line → 201 with all five FKs null.
4. PUT setting `supplyId` on a stored `gearId` line → 400 (the merged-record case).
5. PUT with `quantity: ""` preserves the stored quantity rather than resetting it to 1.
6. DELETE a kit calls `prisma.kit.delete` and no inventory delegate's `delete`.

Test 6 matters: "deleting a kit touches no inventory" is a spec guarantee, and a cascade misconfigured in the other direction would silently delete a firearm.

- [ ] **Step 4: Prove the source rule reaches the route**

Break `resolveKitItemSource` so it accepts two foreign keys, run the kits route tests, confirm a ROUTE test fails (not only the unit test), restore, verify byte-identical. If only the unit test fails, the route is not actually enforcing it — fix that before committing, and report which test caught it.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/app/api/kits`

```bash
git add src/app/api/kits
git commit -m "feat: the kits API, with the exactly-one-source rule enforced server-side

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `kit` becomes a registry source — and phase 5's guards decide how

**Files:**
- Modify: `src/lib/categories.ts`, `src/lib/categories.test.ts`
- Modify: `src/lib/sections/renderableSources.ts`
- Modify: `src/lib/sections/loadSectionItems.ts`, `src/lib/sections/loadSectionItems.test.ts`
- Modify: `src/components/sections/SectionView.tsx`

**THIS TASK IS THE ONE PHASE 5 BUILT ITS GUARDS FOR.** Adding `"kit"` to `SectionSource` should immediately produce tsc errors in `loadSectionItems.ts` (the `const unhandled: never = kind` after the switch, TS2322) and, once you add it to `SECTION_VIEW_SOURCES`, in `SectionView.tsx` (TS2366). Those errors are the plan working, not obstacles.

**Step 1 is to observe them before fixing anything.** Add `"kit"` to the `SectionSource` union alone, run `npx tsc --noEmit -p .`, and RECORD the exact errors and their file:line. If either guard does NOT fire, that is a finding worth more than this task — stop and report it, because it means a guard this project believes it has is dead. Phase 5 found four of those.

- [ ] **Step 1: Observe the guards firing** (see above). Record the output verbatim in your report.

- [ ] **Step 2: Add the Kits section to the registry**

Per the spec's section table: Preparedness | Kits | kit, all. So:

```ts
function kitSection(): SectionMatcher {
  return {
    source: "kit",
    where: {},
    holds: () => true,
  };
}
```

**STOP AND THINK ABOUT `where: {}` BEFORE YOU WRITE IT.** Every other matcher in this file carries a real filter, and `loadSectionItems.test.ts` has a test asserting no query is issued with an empty `where` — because `{}` IS an unfiltered query, and that test was tightened in phase 5 precisely because `toBeTruthy()` passed for `{}`.

Here "all kits" is the honest intent, so an unfiltered query is correct — but it collides with a guard that exists for good reason. Resolve it deliberately: either narrow the assertion to the sources where a filter is meaningful and document why `kit` is exempt, or give `KitRow` a matcher shape that expresses "everything" without an empty object. Pick one, write down which and why, and make sure the guard still catches a genuinely accidental empty `where` on the other four sources. Do not simply delete the assertion.

Add the section itself with `slug: "kits"`, `label: "Kits"`, `group: "prep"`, a description, and a `lucide-react` icon you have VERIFIED exists in the installed package.

- [ ] **Step 3: Handle `kit` in the loader**

Add the branch the tsc error demands: load kits with their items, sequentially, and compute each kit's expiry rollup using the single `resolveExpiryContext` the other branches share. Do not resolve `today` a second time.

- [ ] **Step 4: Handle `kit` in the view**

Add `"kit"` to `SECTION_VIEW_SOURCES` and a `kit` case to `PayloadList`. A kit block renders a card per kit: name, category, item count, the missing count, and the expiry rollup as badges. Follow the layout rule — the name gets its own `truncate min-w-0` element, badges are `shrink-0` siblings OUTSIDE it.

- [ ] **Step 5: Update the registry tests**

The existing suites derive from `CATEGORY_SECTIONS` and `SECTION_GROUPS`, so several will fail on an eighth prep section — that is them working. Update the expected slug list. Add a test that `sectionIsRenderable` is true for `kits`, and one that a kit row matches the kits section and nothing else.

- [ ] **Step 6: Re-prove both guards after wiring**

With `kit` fully handled, temporarily REMOVE the `kit` case from `PayloadList` and confirm tsc fails; restore. Then remove `"kit"` from `SECTION_VIEW_SOURCES` while the view still handles it and confirm TS2678; restore. Both directions, byte-identical after. Report the codes.

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/lib src/components/sections`

```bash
git add src/lib src/components/sections
git commit -m "feat: kits join the category registry as a fourth source kind

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `/kits` and the kit detail page

**Files:**
- Create: `src/app/kits/page.tsx`, `src/app/kits/KitsClientPage.tsx`, `src/app/kits/new/page.tsx`, `src/app/kits/[id]/page.tsx`, `src/app/kits/[id]/KitContents.tsx`, `src/app/kits/[id]/DeleteKitButton.tsx`

**Interfaces consumed:** Task 2's allocation maths; Task 4's registry section.

The spec: "Kit page lists contents grouped by source with quantity against target, a missing count, and expiry badges per line. An over-allocated line shows its warning inline." Detail pages follow the Accessory detail layout, minus what does not apply.

**TWO PATHS SHOW KITS, DELIBERATELY.** The spec's routing table gives `/kits` and `/kits/[id]`; its section table also puts Kits in the Preparedness group, which makes `/prep/kits` a registry-derived route with a nav entry and a count. Both must exist: dropping `/prep/kits` breaks the nav invariant and the counts, dropping `/kits` contradicts the routing table.

They must not drift. `/prep/kits` renders through `SectionView`'s kit branch (Task 4) and `/kits` renders the list directly — both using the SAME `KitsClientPage` component, so a change to the card shape lands in both. `/kits/[id]` is the only detail page; `/prep/kits` links to it. Say in your report which component each path mounts.

- [ ] **Step 1: `/kits`**

A card grid, one card per kit: name, category badge, item count, missing count, and the expiry rollup. Follow `src/app/gear/GearClientPage.tsx` for card shape and `SectionLoadError` for the failure branch — there is exactly one retry component in this repo now and five call sites; do not write a sixth copy.

- [ ] **Step 2: `/kits/[id]` — contents grouped by source**

Group lines by which source they point at (Gear, Supplies, Accessories, Ammo, Firearms, Other), each group a labelled block. Per line: the item's name (or the `label` for an untracked line), `quantity` against `targetQuantity` when a target is set, an expiry badge when the underlying record has a date, and — for an over-allocated line — an inline warning reading "N of M assigned across kits".

Resolve `today` ONCE on the server via `todayForExpiry(settings?.timezone ?? null, new Date())`, exactly as `getSupplySectionItems` does, and pass resolved statuses down. The client must never compute expiry.

`SupplyTimezoneNotice` belongs on this page too when the timezone is unconfigured and any line shows an expiry badge — a page showing EXPIRED verdicts without saying whose "today" decided them is what phase 4 and phase 5 both had to fix.

- [ ] **Step 3: The over-allocation number must be real**

"N of M assigned across kits" needs the sum across EVERY kit, not just this one. Compute it with one query per source kind at most, sequentially — not one query per line. State in your report how many queries a kit page with 20 lines issues; if it is 20, rework it.

- [ ] **Step 4: Delete, and what it must not touch**

`DeleteKitButton` follows `DeleteGearButton`, redirecting to `/prep/kits`. Deleting a kit removes its lines and no inventory — Task 3 tested the route; here confirm it in a browser with a kit holding a real firearm, then verify the firearm still exists.

- [ ] **Step 5: Browser verification, required**

Fresh `npm run dev`; `npx prisma migrate deploy` first if dev.db is behind. Use chrome-devtools `emulate` and READ BACK `window.innerWidth` — on this project `resize_page` and `new_page` both silently open at 500px while reporting success. Check at 390px and desktop:

1. A kit holding all five source kinds renders every group.
2. A line with `targetQuantity > quantity` shows the missing count; one at target does not.
3. An over-allocated accessory (4 in one kit, 8 in another, `quantity` 10) shows "12 of 10 assigned" on BOTH kits and is not refused.
4. A kit with no lines shows an empty state, not a blank page.
5. Long kit and item names do not hide the badges.

Delete any rows you seed and say so.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/app/kits`

```bash
git add src/app/kits
git commit -m "feat: the kits list and the kit detail page

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Adding a line — the inventory picker

**Files:**
- Create: `src/app/kits/[id]/AddKitItem.tsx`
- Create or modify: an endpoint the picker searches against
- Test: whatever the endpoint needs

The spec: "Adding a line is a picker over existing inventory with a free-text fallback for untracked things."

- [ ] **Step 1: Decide what the picker searches, and say why**

`/api/search` already covers gear, supplies and kits by name, brand and notes with a case-insensitive helper. VERIFY whether it returns what a picker needs — the id, the source kind, and a quantity to compute allocation against — before either reusing it or building something new. If it fits, reuse it; if it does not, say exactly what was missing rather than quietly adding a second search path.

- [ ] **Step 2: The picker**

One control: type to search, results grouped by source kind, selecting one fills the right foreign key. A "not in inventory" option switches to a free-text `label` field and clears any selected id — the two are mutually exclusive, and the server rejects a line carrying both, so the UI must not let the user build one.

The client does NOT re-implement `resolveKitItemSource`. Call the API and surface its 400. One rule, one place; a second copy in the client is how the two come to disagree.

- [ ] **Step 3: Quantity and target**

`quantity` defaults to 1; `targetQuantity` is optional and blank by default. An emptied quantity input posts `""` — confirm the API preserves the stored value rather than resetting to 1, which is the bug pattern `normalizeQuantity(value, existing.quantity)` exists for.

- [ ] **Step 4: Browser verification**

Add a line of each of the five source kinds plus one label-only line, at 390px and desktop, with the viewport read back. Confirm the mutually-exclusive behaviour cannot be defeated: select an item, then type a label — the id must clear.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/app/kits`

```bash
git add src/app/kits src/app/api
git commit -m "feat: add kit lines from an inventory picker, with a free-text fallback

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Backup round-trip, exports, search and the dashboard

**Files:**
- Modify: `src/app/api/backup/restore/route.ts` (+ tests), the export routes, `src/app/api/search/route.ts`, `src/lib/dashboard/get-dashboard-stats.ts`

- [ ] **Step 1: Restore must handle a backup that predates kits**

The spec is explicit: "a missing key is an empty table, not a failure." Task 1 kept `Kit`/`KitItem` out of `V1_0_MODEL_NAMES`; here prove the behaviour end to end with a test restoring a payload that has NO `kits` or `kitItems` key and succeeds.

Then the other direction: a round-trip test that backs up a database holding a kit with all five line kinds plus a label-only line, restores into an empty database, and asserts every line comes back pointing at the same records. `KitItem` restores after everything it references — if that ordering is wrong the restore fails on a foreign key, so this test is the guard for Task 1's array placement.

- [ ] **Step 2: Exports**

Kits join the full-armory export as their own section: kit name, category, location, item count, missing count, and the earliest expiry. Each value in its OWN column — phase 3 shipped an export that folded two fields into one and printed `Class: PISTOL` for an SBR.

**Print it.** Phase 5's gear table clipped 174px off a letter sheet and the fix was a column split. Measure the kits table's width against the available width and report both numbers; if it overflows, split it the same way.

The expiry footnote added in phase 5 must cover kit rows too, taking its timezone and date from the same resolved context — a second `new Date()` there prints tomorrow's date beside today's verdicts.

- [ ] **Step 3: Search**

`/api/search` covers `Kit` by name and notes using `containsInsensitive`. Use an explicit `select` — the search route already does, which is why the serial-number leak never reached it. A kit result's URL is `/kits/<id>`; assert it resolves.

- [ ] **Step 4: Dashboard**

A kit whose contents are expiring is exactly what the alerts widget is for. Add expiring-kit-contents to `SupplyAlertsWidget` alongside supplies and gear, distinguishable from both, with `today` resolved once server-side. If the widget is getting crowded, say so in your report rather than silently redesigning it.

- [ ] **Step 5: The serial sweep must cover kits**

`/api/exports/data` now serializes `KitItem` rows with nested `firearm` and `accessory` objects — the EXACT shape that leaked serials twice in this epic, once two levels deep through build slots. Extend the existing whole-payload sweep to a payload containing a kit line pointing at a firearm with a serial, and assert the serial appears nowhere in the serialized output when the toggle is off. Prove it: make the route include them, watch the sweep fail, restore.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src scripts && npm run build`

```bash
git add src
git commit -m "feat: kits reach backup, the exports, search and the dashboard

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in this phase

- **Nested kits** — a kit inside a kit. Explicitly out of scope in the spec.
- **Blocking over-allocation.** Flagged, never enforced.
- **Calorie or macro totals.** `CAL` exists as a unit; nothing sums it.
- The carried gaps phase 5 recorded: `VAULT_VIEW_SOURCES` not compile-pinned, `/gear` without counts, `purchasePrice` unvalidated in five write routes, `full-armory-pdf.ts` dead code, no jsdom so no component tests, the Postgres drift leg needing a CI scratch instance, and the Windows `.bat` files never run on Windows.
