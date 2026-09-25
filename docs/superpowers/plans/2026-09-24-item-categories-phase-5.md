# Item Categories Phase 5 — Preparedness Gear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the full `Gear` category set, the armor fields, gear expiry, and the seven Preparedness sections with a section renderer that can show more than one source on one page.

**Architecture:** `Gear` grows fourteen categories, two armor-only free-text columns and an `expirationDate`. The category registry gains five prep sections and moves both catch-alls onto "Other Prep". The single-source-early-return in `/gear/[slug]` and `/prep/[slug]` is replaced by one shared loader plus one shared view, because prep sections are mixed: Medical is gear `MEDICAL_KIT` **and** supply `MEDICAL`. The loader's `switch` over source kinds is exhaustive, so a new source kind fails `tsc` rather than silently rendering nothing.

**Tech Stack:** Next.js 16 App Router, React 19, Prisma 5.22, vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-22-item-categories-design.md` (phase 5 in `## Phases`; the section table in `### Sections`; `### Gear: new model for standalone kit`; `### Expiry`)

## Global Constraints

- **SQLite runs `connection_limit=1`.** Never `Promise.all` over Prisma queries. Sequential `await`s only. `src/app/api/backup/route.test.ts` pins `maxInFlight === 1`.
- **Routes expose `PUT`, not `PATCH`.** Follow the existing `src/app/api/gear/[id]/route.ts` shape.
- **Every task's verification runs `npx tsc --noEmit -p .`.** Baseline: 16 errors, all in `src/app/api/exports/data/route.backup.test.ts` (14) and `scripts/check-migration-drift.test.ts` (2). Any error outside those two files is yours.
- **`?? undefined` on a where-builder is forbidden.** `whereForSection(...) ?? undefined` turns "matches nothing here" into "match everything" — it has caused two live bugs in this epic. A missing matcher means `notFound()` or an empty list, never an unfiltered query.
- **Catch-alls are defined by negation (`notIn`), never by an allowlist.** A category the build does not recognise must still land in exactly one section.
- **Expiry predicates never read the clock.** They take `today` as an argument; `todayForExpiry(timezone, now)` from `src/lib/supply.ts` is the only sanctioned way to build it.
- **Schema changes go through `npm run gen:schemas`.** Never hand-edit `prisma/postgres/schema.prisma` or `prisma/sqlite/schema.prisma`.
- **`Number("")` and `Number(" ")` are both `0`.** Any numeric normalizer trims first and treats empty as absent.
- **A `NOT NULL DEFAULT` column treats explicit `null` as absent, not as "clear".** A nullable column treats explicit `null` as "clear".
- Path alias `@/` = `src/`. Prisma client from `@/lib/prisma`. Accent `#00C2FF`, error `#E53935`, success `#00C853`, amber `#F5A623`. Dark theme classes: `text-vault-text`, `text-vault-text-muted`, `bg-vault-surface`, `border-vault-border`.

---

## File Structure

**Created:**
- `src/lib/sections/loadSectionItems.ts` — loads every source a section declares, sequentially, and returns one `SectionPayload` per source kind. The exhaustive `switch` lives here.
- `src/lib/sections/loadSectionItems.test.ts`
- `src/components/sections/SectionView.tsx` — renders a `SectionPayload[]`: one block per source, each with its own heading when more than one is present.
- `src/components/sections/SectionLoadError.tsx` — the retry UI, currently copy-pasted into four pages.
- `prisma/migrations-sqlite/<timestamp>_gear_categories_armor_expiry/migration.sql` — generated, not hand-written.

**Modified:**
- `prisma/schema.base.prisma` — `Gear` gains `protectionLevel`, `armorSize`, `expirationDate`, an `@@index([expirationDate])`, and an updated category comment.
- `src/lib/gear.ts` — the full twenty-value category set, labels, and `isArmorCategory`.
- `src/lib/categories.ts` — five new prep sections; both catch-alls move to `other-prep`; `gearSectionForItem` searches every group; `sectionSources` added.
- `src/lib/categories.test.ts` — placement tests updated; renderability invariant added.
- `src/lib/date-migration.ts` — `Gear.expirationDate` registered as date-only.
- `src/app/api/gear/route.ts`, `src/app/api/gear/[id]/route.ts` (+ their tests) — armor fields, expiry, money validation.
- `src/app/gear/new/page.tsx`, `src/app/gear/item/[id]/edit/page.tsx`, `src/app/gear/item/[id]/page.tsx` — conditional armor fieldset, expiry input and badge.
- `src/app/gear/[slug]/page.tsx`, `src/app/prep/[slug]/page.tsx` — both reduced to a call into the shared loader and view.
- `src/app/prep/page.tsx` — seven sections with counts.
- `src/app/api/categories/counts/route.ts` — gear counts for prep sections.
- `src/components/layout/Sidebar.tsx` — the prep group lists seven sections.
- `src/app/api/exports/full-armory/route.ts`, `src/app/api/exports/data/route.ts` — armor and expiry columns, timezone footnote.
- `src/components/dashboard/SupplyAlertsWidget.tsx` — expiring gear joins expiring supplies.

---

### Task 1: Gear grows its full category set, the armor fields and expiry

**Files:**
- Modify: `prisma/schema.base.prisma` (the `Gear` model, around line 167)
- Modify: `src/lib/gear.ts`
- Modify: `src/lib/date-migration.ts` (the `DATE_ONLY_FIELDS` array, around line 40)
- Test: `src/lib/gear.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `GEAR_CATEGORIES` (twenty values), `GEAR_CATEGORY_LABELS: Record<GearCategory, string>`, `isArmorCategory(value: string): boolean`, and the `Gear.protectionLevel` / `Gear.armorSize` / `Gear.expirationDate` columns.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/gear.test.ts`:

```ts
describe("the full category set", () => {
  it("carries every category the spec's section table places", () => {
    expect([...GEAR_CATEGORIES]).toEqual([
      "KNIFE",
      "CASE",
      "ARMOR",
      "MEDICAL_KIT",
      "WATER_TREATMENT",
      "POWER",
      "COMMS",
      "LIGHT",
      "FIRE",
      "SHELTER",
      "CLOTHING",
      "TOOL",
      "SANITATION",
      "CBRN",
      "NAVIGATION",
      "SIGNALING",
      "DOCUMENTS",
      "SAFETY",
      "BUGOUT",
      "OTHER",
    ]);
  });

  it("labels every category, with no label left as the raw enum value", () => {
    for (const category of GEAR_CATEGORIES) {
      const label = GEAR_CATEGORY_LABELS[category];
      expect(label, `${category} has no label`).toBeTruthy();
      expect(label).not.toBe(category);
    }
  });

  it("keeps KNIFE as the fallback, so an unknown category does not become armor", () => {
    expect(normalizeGearCategory("NOPE")).toBe("KNIFE");
    expect(normalizeGearCategory(undefined)).toBe("KNIFE");
  });

  it("recognises armor, and only armor, as carrying the armor fields", () => {
    expect(isArmorCategory("ARMOR")).toBe(true);
    for (const category of GEAR_CATEGORIES.filter((c) => c !== "ARMOR")) {
      expect(isArmorCategory(category), `${category} claimed armor`).toBe(false);
    }
    // Reached through restore and the sqlite->postgres copier, which do not
    // normalize: an unrecognised value is not armor.
    expect(isArmorCategory("armor")).toBe(false);
    expect(isArmorCategory("PLATE")).toBe(false);
  });
});
```

Add `isArmorCategory` to the existing import from `@/lib/gear` at the top of the file.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/lib/gear.test.ts`
Expected: FAIL — `isArmorCategory` is not exported, and `GEAR_CATEGORIES` has two entries.

- [ ] **Step 3: Extend `src/lib/gear.ts`**

Replace the `GEAR_CATEGORIES` const, the labels map and the doc comment above them with:

```ts
/**
 * Standalone kit: things you own that never mount on a firearm. `Gear` is for
 * durable goods and `Supply` for things you consume — that line decides where a
 * new category goes: a plate carrier is `Gear`, the water in the bag is `Supply`.
 *
 * Order matters only for the category dropdowns, which render it directly.
 * KNIFE and CASE lead because they predate the rest; OTHER is last because it
 * is the explicit "none of these" choice, distinct from the fallback below.
 */
export const GEAR_CATEGORIES = [
  "KNIFE",
  "CASE",
  "ARMOR",
  "MEDICAL_KIT",
  "WATER_TREATMENT",
  "POWER",
  "COMMS",
  "LIGHT",
  "FIRE",
  "SHELTER",
  "CLOTHING",
  "TOOL",
  "SANITATION",
  "CBRN",
  "NAVIGATION",
  "SIGNALING",
  "DOCUMENTS",
  "SAFETY",
  "BUGOUT",
  "OTHER",
] as const;

export type GearCategory = (typeof GEAR_CATEGORIES)[number];

export const GEAR_CATEGORY_LABELS: Record<GearCategory, string> = {
  KNIFE: "Knife",
  CASE: "Case",
  ARMOR: "Armor",
  MEDICAL_KIT: "Medical Kit",
  WATER_TREATMENT: "Water Treatment",
  POWER: "Power",
  COMMS: "Comms",
  LIGHT: "Light",
  FIRE: "Fire",
  SHELTER: "Shelter",
  CLOTHING: "Clothing",
  TOOL: "Tool",
  SANITATION: "Sanitation",
  CBRN: "CBRN",
  NAVIGATION: "Navigation",
  SIGNALING: "Signaling",
  DOCUMENTS: "Documents",
  SAFETY: "Safety",
  BUGOUT: "Bugout",
  OTHER: "Other",
};

/**
 * The armor fields (`protectionLevel`, `armorSize`) apply to exactly one
 * category. Takes a raw string rather than a `GearCategory` because the callers
 * that matter — the API's clearing gate and the detail page — hold whatever is
 * stored, which restore and the copier can set to anything.
 */
export function isArmorCategory(value: string): boolean {
  return value === "ARMOR";
}
```

`DEFAULT_GEAR_CATEGORY` and `normalizeGearCategory` are unchanged. Leave them exactly as they are — `KNIFE` stays the fallback deliberately: an unrecognised value must not become `ARMOR` and start showing armor fields.

- [ ] **Step 4: Add the columns to the base schema**

In `prisma/schema.base.prisma`, replace the `Gear` model's category comment and add three fields. The comment becomes:

```prisma
  // GearCategory: KNIFE | CASE | ARMOR | MEDICAL_KIT | WATER_TREATMENT | POWER |
  //               COMMS | LIGHT | FIRE | SHELTER | CLOTHING | TOOL | SANITATION |
  //               CBRN | NAVIGATION | SIGNALING | DOCUMENTS | SAFETY | BUGOUT | OTHER
```

After `acquisitionDate DateTime?` add:

```prisma
  // Armor plates have a rated life; a knife does not. Optional everywhere and
  // simply absent from the form where it does not apply.
  expirationDate  DateTime?
  // Armor only, shown when category = ARMOR. Free text rather than enums: NIJ
  // ratings and plate cuts vary by maker, and a wrong enum would block a real
  // plate from being recorded.
  protectionLevel String?
  armorSize       String?
```

And beside the existing `@@index([category])` add:

```prisma
  @@index([expirationDate])
```

- [ ] **Step 5: Register the new date column**

In `src/lib/date-migration.ts`, add to `DATE_ONLY_FIELDS` immediately after the `Gear.acquisitionDate` entry:

```ts
  { model: "Gear", delegate: "gear", field: "expirationDate" },
```

The DMMF guard in `date-migration.test.ts` fails until this is present — that is the guard working, not a problem to route around.

- [ ] **Step 6: Generate both schemas and the migration**

```bash
npm run gen:schemas
npx prisma migrate dev --schema prisma/sqlite/schema.prisma --name gear_categories_armor_expiry
```

Regenerate the Postgres `0_init` in place per `CONTRIBUTING.md` "Changing the schema". Then:

```bash
npx prisma generate --schema prisma/sqlite/schema.prisma
bash scripts/check-migration-drift.sh
```

Expected: the sqlite leg reports "This is an empty migration" (no drift).

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/gear.test.ts src/lib/date-migration.test.ts && npx tsc --noEmit -p .`
Expected: PASS, and no `tsc` error outside the two baseline files.

Note: `GEAR_CATEGORY_LABELS` is a `Record<GearCategory, string>`, so a missed label is a `tsc` error (TS2741), not a runtime `undefined`. Adding types to a const array has broken `Record<…>` maps elsewhere in this repo — if `tsc` names a file you did not touch, fix it rather than widening the type.

- [ ] **Step 8: Commit**

```bash
git add prisma src/lib/gear.ts src/lib/gear.test.ts src/lib/date-migration.ts
git commit -m "feat: add the full gear category set, armor fields and gear expiry

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The gear API learns armor fields, expiry and money validation

**Files:**
- Create: `src/lib/money.ts`
- Create: `src/lib/money.test.ts`
- Modify: `src/lib/nfa.ts` (delete its private `normalizeMoney`, import the shared one)
- Modify: `src/app/api/gear/route.ts`, `src/app/api/gear/[id]/route.ts`
- Test: `src/app/api/gear/route.test.ts`, `src/app/api/gear/[id]/route.test.ts`

**Interfaces:**
- Consumes: `isArmorCategory` and the new columns from Task 1.
- Produces: `normalizeMoney(value: unknown): number | null` from `@/lib/money`; `normalizeGearArmorFields(...)` exported from `@/lib/gear` for the clearing gate.

**Why the gate:** the same merge-then-normalize rule the NFA field group uses. Whether the armor fields move is decided from what the client sent; what they move *to* is decided by re-running eligibility over the **merged** record. A PUT that changes `category` from `ARMOR` to `TOOL` without sending `protectionLevel` must still clear it, or a plate rating stays attached to a hammer.

- [ ] **Step 1: Write the failing test for the shared money normalizer**

Create `src/lib/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeMoney } from "./money";

describe("normalizeMoney", () => {
  it("treats absent, blank and whitespace-only as not recorded", () => {
    expect(normalizeMoney(undefined)).toBeNull();
    expect(normalizeMoney(null)).toBeNull();
    expect(normalizeMoney("")).toBeNull();
    // Number(" ") is 0, so an untrimmed guard silently records a free item.
    expect(normalizeMoney("   ")).toBeNull();
  });

  it("rejects values that are not a non-negative finite number", () => {
    expect(normalizeMoney("abc")).toBeNull();
    expect(normalizeMoney(-1)).toBeNull();
    expect(normalizeMoney(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeMoney(Number.NaN)).toBeNull();
    expect(normalizeMoney({})).toBeNull();
  });

  it("accepts numbers and numeric strings, including zero", () => {
    expect(normalizeMoney(0)).toBe(0);
    expect(normalizeMoney("0")).toBe(0);
    expect(normalizeMoney("149.99")).toBe(149.99);
    expect(normalizeMoney(" 149.99 ")).toBe(149.99);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/money.test.ts`
Expected: FAIL — `src/lib/money` does not exist.

- [ ] **Step 3: Create `src/lib/money.ts` and rewire `nfa.ts`**

```ts
/**
 * A currency amount, or null when nothing usable was sent.
 *
 * Extracted from nfa.ts, where it was private, because six write routes take a
 * price and only the NFA tax fields validated it. `Number("")` and `Number(" ")`
 * are both `0`, so an emptied price input records a free item unless the blank
 * guard trims — a bug that shipped three separate times in this codebase.
 *
 * Zero is a legitimate recorded price (a gift, a transfer at no cost), which is
 * why "blank" and "zero" have to be distinguished before the parse, not after.
 */
export function normalizeMoney(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}
```

In `src/lib/nfa.ts`, delete the private `normalizeMoney` (lines 35-41) and add `import { normalizeMoney } from "./money";` with the other imports. Its call sites are unchanged.

- [ ] **Step 4: Write the failing test for the armor clearing gate**

Append to `src/lib/gear.test.ts`:

```ts
describe("normalizeGearArmorFields", () => {
  const stored = {
    category: "ARMOR",
    protectionLevel: "IIIA",
    armorSize: "M SAPI",
  };

  it("keeps the fields when the merged record is still armor", () => {
    expect(normalizeGearArmorFields({ existing: stored, body: {} })).toEqual({
      protectionLevel: "IIIA",
      armorSize: "M SAPI",
    });
  });

  it("clears the fields when the category moves off armor, even if the body never mentions them", () => {
    // The gate that matters: a PUT sending only { category: "TOOL" } must not
    // leave a plate rating attached to a hammer.
    expect(
      normalizeGearArmorFields({ existing: stored, body: { category: "TOOL" } }),
    ).toEqual({ protectionLevel: null, armorSize: null });
  });

  it("accepts the fields when the category moves onto armor in the same request", () => {
    expect(
      normalizeGearArmorFields({
        existing: { category: "TOOL", protectionLevel: null, armorSize: null },
        body: { category: "ARMOR", protectionLevel: "IV", armorSize: "L" },
      }),
    ).toEqual({ protectionLevel: "IV", armorSize: "L" });
  });

  it("treats an explicit null as clearing one nullable field", () => {
    expect(
      normalizeGearArmorFields({
        existing: stored,
        body: { protectionLevel: null },
      }),
    ).toEqual({ protectionLevel: null, armorSize: "M SAPI" });
  });

  it("treats a blank string as clearing, and trims what it keeps", () => {
    expect(
      normalizeGearArmorFields({
        existing: stored,
        body: { protectionLevel: "   ", armorSize: "  III  " },
      }),
    ).toEqual({ protectionLevel: null, armorSize: "III" });
  });

  it("preserves the fields on a category this build does not recognise", () => {
    // Forward compatibility, the rule restore already follows: a category a
    // later version added is not a reason to erase data this one cannot judge.
    expect(
      normalizeGearArmorFields({
        existing: { ...stored, category: "EXOSUIT" },
        body: {},
      }),
    ).toEqual({ protectionLevel: "IIIA", armorSize: "M SAPI" });
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run src/lib/gear.test.ts`
Expected: FAIL — `normalizeGearArmorFields` is not exported.

- [ ] **Step 6: Implement the gate in `src/lib/gear.ts`**

```ts
type ArmorFieldInput = {
  existing: { category: string; protectionLevel: string | null; armorSize: string | null };
  body: Record<string, unknown>;
};

function mergedText(
  body: Record<string, unknown>,
  key: string,
  stored: string | null,
): string | null {
  if (!(key in body)) return stored;
  const value = body[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return stored;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Merge first, then decide. Whether the armor fields MOVE comes from what the
 * client sent; what they move TO comes from re-running eligibility over the
 * merged record — the same shape as normalizeFirearmNfaFields.
 *
 * Reading eligibility off `body.category` alone would miss the case that
 * matters: a PUT that changes only the category, leaving a plate rating on a
 * hammer. Reading it off `existing.category` alone would refuse the fields on
 * the request that makes an item armor in the first place.
 *
 * A category this build does not recognise is left alone rather than cleared.
 * The codebase already made the opposite mistake once, silently declassifying
 * firearms whose class came from a later build; preserving what we cannot judge
 * is the rule here too.
 */
export function normalizeGearArmorFields({ existing, body }: ArmorFieldInput): {
  protectionLevel: string | null;
  armorSize: string | null;
} {
  const category =
    "category" in body && typeof body.category === "string" && body.category.trim() !== ""
      ? normalizeGearCategory(body.category)
      : existing.category;

  const protectionLevel = mergedText(body, "protectionLevel", existing.protectionLevel);
  const armorSize = mergedText(body, "armorSize", existing.armorSize);

  const knownCategory = (GEAR_CATEGORIES as readonly string[]).includes(category);
  if (knownCategory && !isArmorCategory(category)) {
    return { protectionLevel: null, armorSize: null };
  }
  return { protectionLevel, armorSize };
}
```

- [ ] **Step 7: Wire both routes**

In `src/app/api/gear/route.ts` POST: destructure `expirationDate`, `protectionLevel` and `armorSize` from the body; import `normalizeMoney` from `@/lib/money` and `normalizeGearArmorFields` from `@/lib/gear`. Replace the two money lines and add the three new columns:

```ts
        purchasePrice: normalizeMoney(purchasePrice),
        currentValue: normalizeMoney(currentValue),
        expirationDate: expirationDate ? toDateOnlyUTC(expirationDate) : null,
        ...normalizeGearArmorFields({
          existing: { category: "", protectionLevel: null, armorSize: null },
          body,
        }),
```

The empty `existing.category` is deliberate: on a create there is no stored row, and `""` is not a known category, so the gate falls through to "preserve what was sent" and the merged `body.category` decides. Add an assertion for this in the route test rather than trusting the read.

In `src/app/api/gear/[id]/route.ts` PUT, inside the `data` object:

```ts
        ...(purchasePrice !== undefined && {
          purchasePrice: normalizeMoney(purchasePrice),
        }),
        ...(currentValue !== undefined && {
          currentValue: normalizeMoney(currentValue),
        }),
        ...(expirationDate !== undefined && {
          expirationDate: expirationDate ? toDateOnlyUTC(expirationDate) : null,
        }),
        ...normalizeGearArmorFields({ existing, body }),
```

`normalizeGearArmorFields` is spread **unconditionally** — that is the point of the gate. It always returns both keys, and it is the only thing deciding their value.

- [ ] **Step 8: Write the route tests**

Add to `src/app/api/gear/route.test.ts` and `src/app/api/gear/[id]/route.test.ts`, following the mocked-Prisma style already in those files. Assert on the **arguments passed to the mocked Prisma call**, not on a helper's return — this repo has had 286 tests pass while a deleted `where` clause would have shown every section the whole vault, because helper tests are not route tests. At minimum:

1. POST with `category: "ARMOR"`, `protectionLevel: "III"` stores both armor fields.
2. POST with `category: "TOOL"`, `protectionLevel: "III"` stores `protectionLevel: null`.
3. POST with `purchasePrice: "  "` stores `purchasePrice: null`, not `0`.
4. PUT sending only `{ category: "TOOL" }` against a stored `ARMOR` row calls `update` with `protectionLevel: null` and `armorSize: null`.
5. PUT sending `{ expirationDate: "" }` calls `update` with `expirationDate: null`.
6. PUT sending a malformed `expirationDate` returns 400 (the `InvalidDateError` branch), not 500.

- [ ] **Step 9: Run everything**

Run: `npx vitest run src/lib/gear.test.ts src/lib/money.test.ts src/lib/nfa.test.ts src/app/api/gear && npx tsc --noEmit -p . && npx eslint src/lib/money.ts src/lib/gear.ts src/app/api/gear`
Expected: PASS, no new `tsc` errors, no lint errors.

- [ ] **Step 10: Commit**

```bash
git add src/lib/money.ts src/lib/money.test.ts src/lib/nfa.ts src/lib/gear.ts src/lib/gear.test.ts src/app/api/gear
git commit -m "feat: validate gear money and gate the armor fields on category

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Gear forms and detail page — conditional armor fieldset, expiry input, expiry badge

**Files:**
- Modify: `src/app/gear/new/page.tsx`
- Modify: `src/app/gear/item/[id]/edit/page.tsx`
- Modify: `src/app/gear/item/[id]/page.tsx`
- Modify: `src/app/gear/GearClientPage.tsx`

**Interfaces:**
- Consumes: `GEAR_CATEGORIES`, `GEAR_CATEGORY_LABELS`, `isArmorCategory` (Task 1); the API contract from Task 2.
- Produces: nothing later tasks import.

Both forms already map `GEAR_CATEGORIES` into their category `<select>`, so the twenty values appear there with no change. What is new: an expiry date input, and an armor fieldset that appears only when the selected category is `ARMOR`.

- [ ] **Step 1: Make the category a controlled value in `new/page.tsx`**

The form is uncontrolled (`FormData` on submit). Add one piece of state for the category only, so the armor fieldset can react:

```tsx
const [category, setCategory] = useState<string>(DEFAULT_GEAR_CATEGORY);
```

Import `DEFAULT_GEAR_CATEGORY` and `isArmorCategory` from `@/lib/gear`. On the existing `<select name="category">`, add `value={category}` and `onChange={(e) => setCategory(e.target.value)}`, and remove any `defaultValue`. Leave every other field uncontrolled.

- [ ] **Step 2: Add the expiry input**

Beside the existing `acquisitionDate` input, matching its markup exactly (same `LABEL_CLASS`, same `<input type="date">` shape):

```tsx
<div>
  <label htmlFor="expirationDate" className={LABEL_CLASS}>
    Expiration Date
  </label>
  <input
    type="date"
    id="expirationDate"
    name="expirationDate"
    className={INPUT_CLASS}
  />
  <p className="mt-1 text-xs text-vault-text-muted">
    Optional. Plates, filters and medical kits have a rated life.
  </p>
</div>
```

No `defaultValue` — a new item has no expiry until the user sets one. (This is the same rule the V1 brief applied to `lastMaintenanceDate`: a fresh record has not aged yet.)

- [ ] **Step 3: Add the armor fieldset**

Rendered only when `isArmorCategory(category)`:

```tsx
{isArmorCategory(category) && (
  <fieldset className="rounded-lg border border-vault-border p-4">
    <legend className="px-2 text-sm font-medium text-vault-text">Armor</legend>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label htmlFor="protectionLevel" className={LABEL_CLASS}>
          Protection Level
        </label>
        <input
          type="text"
          id="protectionLevel"
          name="protectionLevel"
          placeholder="IIIA, III, IV"
          className={INPUT_CLASS}
        />
      </div>
      <div>
        <label htmlFor="armorSize" className={LABEL_CLASS}>
          Size / Cut
        </label>
        <input
          type="text"
          id="armorSize"
          name="armorSize"
          placeholder="M SAPI, Swimmer, 10x12"
          className={INPUT_CLASS}
        />
      </div>
    </div>
    <p className="mt-2 text-xs text-vault-text-muted">
      Free text — NIJ ratings and plate cuts vary by maker.
    </p>
  </fieldset>
)}
```

- [ ] **Step 4: Send the new fields**

In the submit handler, add to the posted body:

```ts
      expirationDate: (data.get("expirationDate") as string) || null,
      protectionLevel: (data.get("protectionLevel") as string) || null,
      armorSize: (data.get("armorSize") as string) || null,
```

`data.get` returns `null` for a field that is not in the DOM, so when the fieldset is hidden both armor keys post as `null` — which the Task 2 gate reads as "clear", consistent with the category not being armor. Do not guard these with `isArmorCategory` in the client; the server gate is the authority and the client must not be a second, divergent copy of that rule.

- [ ] **Step 5: Repeat in `item/[id]/edit/page.tsx`**

Same three additions, with two differences:
- the category `useState` initialises from the loaded record: `useState<string>(gear.category)` once the fetch resolves (the page already holds the fetched `gear` in state — initialise from it in the same place the other fields are populated, not in a `useEffect` that sets state on every render).
- both new inputs carry a `defaultValue`: `toISODate(gear.expirationDate)` for the date, `gear.protectionLevel ?? ""` and `gear.armorSize ?? ""` for the armor fields.

Use `toISODate` from `@/lib/date`, which this page already imports. Do **not** write a local `new Date(x).toISOString().split("T")[0]` helper — two other edit pages carry that exact off-by-one and Task 9 removes them.

- [ ] **Step 6: Show expiry and armor on the detail page**

In `src/app/gear/item/[id]/page.tsx`, add to the spec/details list:
- `Expires` — the formatted date, with a badge when it is expired or expiring soon
- `Protection Level` and `Size / Cut` — rendered **only** when `isArmorCategory(gear.category)`, so a non-armor item shows no empty armor rows

For the badge, resolve `today` once on the server from `AppSettings.timezone` exactly as `getSupplySectionItems` does, then call `expiryStatus(gear.expirationDate, today, warningDays)` from `@/lib/supply`. Do not call `new Date()` and pass that — the predicate needs a date whose UTC day equals the user's LOCAL day, which is what `todayForExpiry` is for. Getting this wrong reads items as expired a day early every evening west of UTC.

Badge styling, matching the supply pages:
- expired → `#E53935` text on a transparent red tint
- soon → `#F5A623`
- otherwise no badge

- [ ] **Step 7: Show the expiry badge in the gear list**

`GearClientPage.tsx` renders the card grid. Add the same badge beside the existing category badge. Follow the layout rule the phase-2 review established: the name gets its own `truncate min-w-0` element and every badge is a `shrink-0` sibling **outside** it. Putting `truncate` and `flex` on one element hid the `×N` quantity badge entirely for long names — markup that looked correct and only a browser caught.

`GearClientPage` is a client component and must not compute `today` itself. Pass the already-resolved status down from the server page as part of each item.

- [ ] **Step 8: Verify in a browser**

```bash
npm run dev
```

Start a **fresh** dev server — a long-uptime one holds a pre-migration Prisma client and 500s after Task 1's schema change.

Check, at 390px and at desktop width:
1. `/gear/new` — selecting Armor reveals the fieldset; selecting anything else hides it.
2. Create an armor item with a level, a size and a past expiry date. The detail page shows both armor rows and an expired badge; the list card shows the badge without hiding the name.
3. Edit it to category Tool and save. Both armor rows disappear from the detail page, and the stored values are gone (check with `npx prisma studio`) — not merely hidden.
4. Create a knife. No armor rows anywhere, no empty labels.

- [ ] **Step 9: Verify and commit**

Run: `npx tsc --noEmit -p . && npx eslint src/app/gear && npx vitest run`
Expected: no new `tsc` errors, no lint errors, all tests pass.

`react-hooks/set-state-in-effect` is severity ERROR in this repo — but the compiler-based rule silently bails on some components, so a clean lint is not proof the pattern is absent. If you set state in an effect here, justify it in the commit message rather than assuming the linter vouched for it.

```bash
git add src/app/gear
git commit -m "feat: gear forms and detail show expiry and the armor fields

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The registry gains five prep sections and both catch-alls move to Other Prep

**Files:**
- Modify: `src/lib/categories.ts`
- Test: `src/lib/categories.test.ts`

**Interfaces:**
- Consumes: the twenty gear categories from Task 1.
- Produces: seven `prep`-group sections (`armor`, `medical`, `food-water`, `power-comms`, `shelter-clothing`, `tools-fire`, `other-prep`); `gearSectionForItem` searching every group; `sectionSources(section)`.

**The section table, from the spec:**

| Section | Gear categories | Supply categories |
| --- | --- | --- |
| Armor | `ARMOR` | — |
| Medical | `MEDICAL_KIT` | `MEDICAL` |
| Food & Water | `WATER_TREATMENT` | `FOOD`, `WATER`, `FILTER` |
| Power & Comms | `POWER`, `COMMS` | `BATTERY` |
| Shelter & Clothing | `SHELTER`, `CLOTHING` | — |
| Tools & Fire | `TOOL`, `FIRE`, `LIGHT`, `SIGNALING` | `FUEL`, `SIGNAL` |
| Other Prep | `SANITATION`, `CBRN`, `NAVIGATION`, `DOCUMENTS`, `SAFETY`, `BUGOUT`, `OTHER` + the gear catch-all | `SANITATION`, `CBRN_FILTER`, `OTHER` + the supply catch-all |

Kits is the eighth Preparedness row in the spec and belongs to **phase 6**. Do not add it.

- [ ] **Step 1: Write the failing tests**

In `src/lib/categories.test.ts`, the existing suites already assert "places every gear category in exactly one section" and "places every supply category in exactly one section" derived from `GEAR_CATEGORIES` / `SUPPLY_CATEGORIES` — those will fail on their own once Task 1 added eighteen categories, which is the guard working. Update the hand-written groupings and add:

```ts
describe("preparedness sections", () => {
  it("declares the seven sections the spec names, in order", () => {
    expect(sectionsForGroup("prep").map((s) => s.slug)).toEqual([
      "armor",
      "medical",
      "food-water",
      "power-comms",
      "shelter-clothing",
      "tools-fire",
      "other-prep",
    ]);
  });

  it("groups the gear categories the way the spec says", () => {
    const expected: Record<string, string> = {
      KNIFE: "knives",
      CASE: "cases",
      ARMOR: "armor",
      MEDICAL_KIT: "medical",
      WATER_TREATMENT: "food-water",
      POWER: "power-comms",
      COMMS: "power-comms",
      LIGHT: "tools-fire",
      FIRE: "tools-fire",
      SHELTER: "shelter-clothing",
      CLOTHING: "shelter-clothing",
      TOOL: "tools-fire",
      SANITATION: "other-prep",
      CBRN: "other-prep",
      NAVIGATION: "other-prep",
      SIGNALING: "tools-fire",
      DOCUMENTS: "other-prep",
      SAFETY: "other-prep",
      BUGOUT: "other-prep",
      OTHER: "other-prep",
    };
    for (const category of GEAR_CATEGORIES) {
      expect(
        gearSectionForItem({ category })?.slug,
        `${category} landed in the wrong section`,
      ).toBe(expected[category]);
    }
  });

  it("groups the supply categories the way the spec says", () => {
    const expected: Record<string, string> = {
      CLEANING: "cleaning",
      MEDICAL: "medical",
      FOOD: "food-water",
      WATER: "food-water",
      FILTER: "food-water",
      BATTERY: "power-comms",
      FUEL: "tools-fire",
      SANITATION: "other-prep",
      CBRN_FILTER: "other-prep",
      SIGNAL: "tools-fire",
      OTHER: "other-prep",
    };
    for (const category of SUPPLY_CATEGORIES) {
      expect(
        supplySectionForItem({ category })?.slug,
        `${category} landed in the wrong section`,
      ).toBe(expected[category]);
    }
  });

  it("sends an unrecognised gear category to other-prep, not to cases", () => {
    // Phase 4 parked the gear catch-all on `cases` because prep had no home
    // for it. It has one now, and a bugout-bag category must not surface
    // under Gear > Cases.
    expect(gearSectionForItem({ category: "EXOSUIT" })?.slug).toBe("other-prep");
  });

  it("sends an unrecognised supply category to other-prep, not to food-water", () => {
    expect(supplySectionForItem({ category: "PLUTONIUM" })?.slug).toBe("other-prep");
  });

  it("finds a gear item whose section lives outside the gear group", () => {
    // gearSectionForItem searched only sectionsForGroup("gear"), which was
    // correct while every gear category was a Gear section. Armor is a prep
    // section, so a group-scoped search returns undefined and the detail
    // page's back link falls back to "/" for fourteen of twenty categories.
    const section = gearSectionForItem({ category: "ARMOR" });
    expect(section?.slug).toBe("armor");
    expect(section?.group).toBe("prep");
  });

  it("keeps mixed sections' two sources independent", () => {
    const medical = sectionBySlug("medical")!;
    expect(gearWhereForSection(medical)).toEqual({
      category: { in: ["MEDICAL_KIT"] },
    });
    expect(supplyWhereForSection(medical)).toEqual({
      category: { in: ["MEDICAL"] },
    });
  });
});
```

Import `GEAR_CATEGORIES` from `@/lib/gear` and `SUPPLY_CATEGORIES` from `@/lib/supply` if not already imported.

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/categories.test.ts`
Expected: FAIL — the five sections do not exist, and the existing exactly-one-section tests fail because eighteen gear categories have no home.

- [ ] **Step 3: Restructure the category groupings in `src/lib/categories.ts`**

Replace the `KNIFE_CATEGORIES` / `CASE_CATEGORIES` / `GROUPED_GEAR` block with:

```ts
const KNIFE_CATEGORIES = ["KNIFE"];
const CASE_CATEGORIES = ["CASE"];
const ARMOR_CATEGORIES = ["ARMOR"];
const MEDICAL_GEAR_CATEGORIES = ["MEDICAL_KIT"];
const FOOD_WATER_GEAR_CATEGORIES = ["WATER_TREATMENT"];
const POWER_COMMS_GEAR_CATEGORIES = ["POWER", "COMMS"];
const SHELTER_GEAR_CATEGORIES = ["SHELTER", "CLOTHING"];
const TOOLS_FIRE_GEAR_CATEGORIES = ["TOOL", "FIRE", "LIGHT", "SIGNALING"];
const OTHER_PREP_GEAR_CATEGORIES = [
  "SANITATION",
  "CBRN",
  "NAVIGATION",
  "DOCUMENTS",
  "SAFETY",
  "BUGOUT",
  "OTHER",
];

// Every GearCategory an explicit section claims. The catch-all below is the
// negation of this list, so a category added to the schema without a section
// still lands somewhere visible instead of matching zero sections.
const GROUPED_GEAR = [
  ...KNIFE_CATEGORIES,
  ...CASE_CATEGORIES,
  ...ARMOR_CATEGORIES,
  ...MEDICAL_GEAR_CATEGORIES,
  ...FOOD_WATER_GEAR_CATEGORIES,
  ...POWER_COMMS_GEAR_CATEGORIES,
  ...SHELTER_GEAR_CATEGORIES,
  ...TOOLS_FIRE_GEAR_CATEGORIES,
  ...OTHER_PREP_GEAR_CATEGORIES,
];
```

Update `otherGearSection`'s doc comment: it now rides on `other-prep` rather than `cases`, and the reason is no longer "phase 5 will restructure this" but "Other Prep is where an unclassifiable durable good belongs".

Replace the supply grouping block with:

```ts
const CLEANING_CATEGORIES = ["CLEANING"];
const MEDICAL_SUPPLY_CATEGORIES = ["MEDICAL"];
const FOOD_WATER_SUPPLY_CATEGORIES = ["FOOD", "WATER", "FILTER"];
const POWER_COMMS_SUPPLY_CATEGORIES = ["BATTERY"];
const TOOLS_FIRE_SUPPLY_CATEGORIES = ["FUEL", "SIGNAL"];
const OTHER_PREP_SUPPLY_CATEGORIES = ["SANITATION", "CBRN_FILTER", "OTHER"];

const GROUPED_SUPPLIES = [
  ...CLEANING_CATEGORIES,
  ...MEDICAL_SUPPLY_CATEGORIES,
  ...FOOD_WATER_SUPPLY_CATEGORIES,
  ...POWER_COMMS_SUPPLY_CATEGORIES,
  ...TOOLS_FIRE_SUPPLY_CATEGORIES,
  ...OTHER_PREP_SUPPLY_CATEGORIES,
];
```

Rename the two existing uses of `MEDICAL_CATEGORIES` and `FOOD_WATER_CATEGORIES` in `CATEGORY_SECTIONS` to their new `_SUPPLY_` names. `otherSupplySection` keeps its `notIn GROUPED_SUPPLIES` shape unchanged — only the list it negates grew, which is the point of defining it by negation.

- [ ] **Step 4: Rewrite the prep sections in `CATEGORY_SECTIONS`**

Replace the existing `medical` and `food-water` entries (the last two in the array) with all seven, in this order:

```ts
  {
    slug: "armor",
    label: "Armor",
    description: "Plates, carriers & soft armor",
    group: "prep",
    icon: "ShieldCheck",
    sources: [gearSection(ARMOR_CATEGORIES)],
  },
  {
    slug: "medical",
    label: "Medical",
    description: "Kits, first aid & medical supplies",
    group: "prep",
    icon: "Cross",
    sources: [
      gearSection(MEDICAL_GEAR_CATEGORIES),
      supplySection(MEDICAL_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "food-water",
    label: "Food & Water",
    description: "Food, water, filters & treatment",
    group: "prep",
    icon: "Droplets",
    sources: [
      gearSection(FOOD_WATER_GEAR_CATEGORIES),
      supplySection(FOOD_WATER_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "power-comms",
    label: "Power & Comms",
    description: "Batteries, power & radios",
    group: "prep",
    icon: "BatteryCharging",
    sources: [
      gearSection(POWER_COMMS_GEAR_CATEGORIES),
      supplySection(POWER_COMMS_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "shelter-clothing",
    label: "Shelter & Clothing",
    description: "Shelter, sleep & clothing",
    group: "prep",
    icon: "Tent",
    sources: [gearSection(SHELTER_GEAR_CATEGORIES)],
  },
  {
    slug: "tools-fire",
    label: "Tools & Fire",
    description: "Tools, light, fire & signaling",
    group: "prep",
    icon: "Flame",
    sources: [
      gearSection(TOOLS_FIRE_GEAR_CATEGORIES),
      supplySection(TOOLS_FIRE_SUPPLY_CATEGORIES),
    ],
  },
  {
    slug: "other-prep",
    label: "Other Prep",
    description: "Sanitation, CBRN, navigation & everything else",
    group: "prep",
    icon: "Package",
    sources: [
      gearSection(OTHER_PREP_GEAR_CATEGORIES),
      otherGearSection(),
      supplySection(OTHER_PREP_SUPPLY_CATEGORIES),
      otherSupplySection(),
    ],
  },
```

And remove `otherSupplySection()` from the `food-water` entry's sources — it lives on `other-prep` now. Removing it and forgetting to add it is how a supply category becomes invisible, so the "never loses a supply with an unrecognised category" test is the one to watch.

`other-prep` carries **four** matchers: an explicit list and a catch-all per source. `gearWhereForSection` and `supplyWhereForSection` already combine multiple same-source matchers into a literal `OR`, so this needs no new machinery — but check the existing "combines cases' two matchers into a literal OR" test still describes reality and move it to `other-prep`.

Verify the icon names exist in `lucide-react` before committing: `ShieldCheck`, `BatteryCharging`, `Tent`, `Flame`, `Package`. Nothing renders `icon` today, but a name that does not exist becomes a runtime crash the moment something does.

- [ ] **Step 5: Widen `gearSectionForItem`**

```ts
/**
 * Searches every section rather than one group's, like supplySectionForItem
 * and unlike vaultSectionForFirearm. Gear categories are spread across both
 * the "gear" group (knives, cases) and the "prep" group (armor, medical kits,
 * shelter and the rest), so a group-scoped search would return undefined for
 * fourteen of the twenty categories — and the callers treat undefined as
 * "no section", falling back to "/" for the back link.
 */
export function gearSectionForItem(row: GearRow): CategorySection | undefined {
  return CATEGORY_SECTIONS.find((section) =>
    section.sources.some(
      (source) => source.source === "gear" && source.holds(row),
    ),
  );
}
```

- [ ] **Step 6: Add `sectionSources`**

Task 5's loader needs the source kinds a section declares, deduplicated and in declaration order:

```ts
/**
 * The distinct source kinds a section draws from, in declaration order. The
 * section renderer walks this rather than probing each where-builder for null,
 * so "this section has no data source at all" is a case the caller can see
 * instead of one that quietly renders an empty page.
 */
export function sectionSources(section: CategorySection): SectionSource[] {
  const seen: SectionSource[] = [];
  for (const source of section.sources) {
    if (!seen.includes(source.source)) seen.push(source.source);
  }
  return seen;
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/categories.test.ts && npx tsc --noEmit -p .`
Expected: PASS. If "places every gear category in exactly one section" fails, a category is either in two groupings or in none — read the failure's category name rather than adjusting the expectation.

- [ ] **Step 8: Prove the catch-all guard works**

Temporarily delete `otherGearSection()` from `other-prep`'s sources and re-run. "never loses gear with an unrecognised category" must fail. Restore it. Record the result in the report — a guard nobody has seen fail is not known to be a guard.

- [ ] **Step 9: Commit**

```bash
git add src/lib/categories.ts src/lib/categories.test.ts
git commit -m "feat: add the seven preparedness sections and move both catch-alls to Other Prep

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: One shared section loader and view, replacing the single-source early return

**Files:**
- Create: `src/lib/sections/loadSectionItems.ts`
- Create: `src/lib/sections/loadSectionItems.test.ts`
- Create: `src/components/sections/SectionView.tsx`
- Create: `src/components/sections/SectionLoadError.tsx`
- Modify: `src/app/gear/[slug]/page.tsx`
- Modify: `src/app/prep/[slug]/page.tsx`

**Interfaces:**
- Consumes: `sectionSources`, `gearWhereForSection`, `supplyWhereForSection`, `accessoryWhereForSection`, `firearmWhereForSection` (Task 4).
- Produces: `loadSectionItems(section): Promise<SectionPayload[]>` and `<SectionView payloads={…} />`.

**Why this task exists.** `/prep/[slug]` handles **only** supply sources and `notFound()`s otherwise, so `/prep/armor` — gear-only — would 404 the moment Task 4 registers it. `/gear/[slug]` returns early on the first source it finds, so a mixed section would silently show one of its two lists. Both pages also carry their own copy of the retry JSX; there are four copies in the tree. One loader and one view fixes all three at once.

- [ ] **Step 1: Write the failing test**

Create `src/lib/sections/loadSectionItems.test.ts`. Mock `@/lib/prisma` in the style of `src/app/api/gear/route.test.ts`. Assert on the **arguments handed to the mocked Prisma calls**, not on the helper's return shape alone:

```ts
describe("loadSectionItems", () => {
  it("loads both sources of a mixed section, in declaration order", async () => {
    const payloads = await loadSectionItems(sectionBySlug("medical")!);
    expect(payloads.map((p) => p.kind)).toEqual(["gear", "supply"]);
    expect(prisma.gear.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: { in: ["MEDICAL_KIT"] } } }),
    );
    expect(prisma.supply.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { category: { in: ["MEDICAL"] } } }),
    );
  });

  it("loads a gear-only section without touching the other tables", async () => {
    const payloads = await loadSectionItems(sectionBySlug("armor")!);
    expect(payloads.map((p) => p.kind)).toEqual(["gear"]);
    expect(prisma.supply.findMany).not.toHaveBeenCalled();
    expect(prisma.accessory.findMany).not.toHaveBeenCalled();
  });

  it("never issues a query with no where clause", async () => {
    // `?? undefined` on a where-builder has caused two live bugs in this
    // epic: it turns "matches nothing here" into "match everything". Every
    // query this loader issues carries a filter.
    for (const section of CATEGORY_SECTIONS) {
      vi.clearAllMocks();
      await loadSectionItems(section);
      for (const delegate of [prisma.firearm, prisma.accessory, prisma.gear, prisma.supply]) {
        for (const call of (delegate.findMany as Mock).mock.calls) {
          expect(call[0]?.where).toBeTruthy();
        }
      }
    }
  });

  it("queries sequentially, because sqlite runs connection_limit=1", async () => {
    // Same shape as the maxInFlight assertion in api/backup/route.test.ts.
    let inFlight = 0;
    let maxInFlight = 0;
    const track = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [];
    };
    (prisma.gear.findMany as Mock).mockImplementation(track);
    (prisma.supply.findMany as Mock).mockImplementation(track);
    await loadSectionItems(sectionBySlug("medical")!);
    expect(maxInFlight).toBe(1);
  });

  it("resolves the expiry timezone once for the whole section", async () => {
    await loadSectionItems(sectionBySlug("medical")!);
    expect(prisma.appSettings.findUnique).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run src/lib/sections/loadSectionItems.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the loader**

```ts
import { prisma } from "@/lib/prisma";
import {
  accessoryWhereForSection,
  firearmWhereForSection,
  gearWhereForSection,
  sectionSources,
  supplyWhereForSection,
  type CategorySection,
  type SectionSource,
} from "@/lib/categories";
import {
  DEFAULT_EXPIRY_WARNING_DAYS,
  expiryStatus,
  isLowStock,
  todayForExpiry,
  type ExpiryStatus,
} from "@/lib/supply";

export type SectionPayload =
  | { kind: "firearm"; items: FirearmSectionItem[] }
  | { kind: "accessory"; items: AccessorySectionItem[] }
  | { kind: "gear"; items: GearSectionItem[]; timezoneConfigured: boolean }
  | { kind: "supply"; items: SupplySectionItem[]; timezoneConfigured: boolean };

/**
 * Loads every source a section declares, in declaration order.
 *
 * Replaces the single-source early return both [slug] pages used to carry.
 * `/prep/[slug]` handled ONLY supply sources, so a gear-backed prep section
 * (armor, shelter) 404'd; `/gear/[slug]` returned after its first source, so
 * a mixed section (medical, food & water) silently showed one of its lists.
 *
 * The `switch` below is exhaustive over SectionSource with no `default`, so a
 * source kind added to the registry is a tsc error here rather than a section
 * that renders one fewer list than it claims. That is the guard the
 * reachability test cannot express.
 *
 * Sequential awaits throughout — sqlite runs connection_limit=1 — and the
 * expiry timezone is resolved at most once per call, shared by the gear and
 * supply branches so the two lists on one page cannot disagree about today.
 */
export async function loadSectionItems(
  section: CategorySection,
): Promise<SectionPayload[]> {
  const payloads: SectionPayload[] = [];
  let expiryContext: { today: Date; warningDays: number; configured: boolean } | null = null;

  const resolveExpiryContext = async () => {
    if (expiryContext) return expiryContext;
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });
    expiryContext = {
      today: todayForExpiry(settings?.timezone ?? null, new Date()),
      warningDays: settings?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS,
      configured: Boolean(settings?.timezone),
    };
    return expiryContext;
  };

  for (const kind of sectionSources(section)) {
    switch (kind) {
      case "firearm": {
        const where = firearmWhereForSection(section);
        if (!where) continue;
        const rows = await prisma.firearm.findMany({
          where,
          orderBy: { name: "asc" },
        });
        payloads.push({ kind: "firearm", items: rows });
        break;
      }
      case "accessory": {
        const where = accessoryWhereForSection(section);
        if (!where) continue;
        payloads.push({
          kind: "accessory",
          items: await loadSectionAccessories(where),
        });
        break;
      }
      case "gear": {
        const where = gearWhereForSection(section);
        if (!where) continue;
        const { today, warningDays, configured } = await resolveExpiryContext();
        const rows = await prisma.gear.findMany({
          where,
          orderBy: { name: "asc" },
        });
        payloads.push({
          kind: "gear",
          items: rows.map((row) => ({
            ...row,
            expiry: expiryStatus(row.expirationDate, today, warningDays),
          })),
          timezoneConfigured: configured,
        });
        break;
      }
      case "supply": {
        const where = supplyWhereForSection(section);
        if (!where) continue;
        const { today, warningDays, configured } = await resolveExpiryContext();
        const rows = await prisma.supply.findMany({
          where,
          orderBy: { name: "asc" },
        });
        payloads.push({
          kind: "supply",
          items: rows.map((row) => mapSupplyRow(row, today, warningDays)),
          timezoneConfigured: configured,
        });
        break;
      }
    }
  }

  return payloads;
}
```

Three things to carry over rather than reinvent:

- `loadSectionAccessories(where)` is `getSectionAccessories` from `src/app/gear/[slug]/page.tsx`, moved here unchanged — the `buildSlots`/`build`/`firearm` `include`, the `orderBy: { roundCount: "desc" }`, and the `currentBuild` mapping. Move it, do not retype it.
- `mapSupplyRow(row, today, warningDays)` is the `.map(...)` body currently inline in `getSupplySectionItems`. Export it from `src/app/supplies/getSupplySectionItems.ts` and have both callers use it, so the supply list shape cannot drift between the section pages and `/supplies/item/[id]`.
- **Every branch `continue`s on a null where.** Never fall through to an unfiltered query, and never coerce with `?? undefined`.

The item types in `SectionPayload` are:

```ts
type FirearmSectionItem = Awaited<ReturnType<typeof prisma.firearm.findMany>>[number];
type AccessorySectionItem = Awaited<ReturnType<typeof loadSectionAccessories>>[number];
type GearSectionItem = Awaited<ReturnType<typeof prisma.gear.findMany>>[number] & {
  expiry: ExpiryStatus;
};
```

`SupplySectionItem` already exists — import it from `@/app/supplies/getSupplySectionItems` rather than declaring a second copy. Deriving the other three from the Prisma delegates means a schema change updates them automatically; hand-written row interfaces are the shape that fell behind the schema in `DATE_ONLY_FIELDS`.

Keep `src/app/supplies/getSupplySectionItems.ts` in place; `/supplies/item/[id]` and the supply pages still use it. Do not leave a second copy of the mapping logic behind — have `getSupplySectionItems` and the loader's supply branch share one exported `mapSupplyRow` helper.

- [ ] **Step 4: Prove the exhaustive switch is load-bearing**

Temporarily add `"kit"` to `SectionSource` in `src/lib/categories.ts` and run `npx tsc --noEmit -p .`. Expected: an error on the `switch` in `loadSectionItems.ts` (TS2322 or TS7030, depending on how the branch returns). Revert. Record the exact error code in the report — phase 6 adds a `kit` source and will rely on this firing.

- [ ] **Step 5: Create the shared error UI**

`src/components/sections/SectionLoadError.tsx`:

```tsx
import Link from "next/link";

/** The retry UI the section pages, the supply pages and the accessories and
 *  builds pages each carried their own copy of. */
export function SectionLoadError({
  label,
  href,
}: {
  label: string;
  href: string;
}) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
      <p className="text-sm text-vault-text-muted">Failed to load {label}.</p>
      <Link href={href} className="text-sm text-[#00C2FF] hover:underline">
        Tap to retry
      </Link>
    </div>
  );
}
```

- [ ] **Step 6: Create `SectionView`**

Renders a `SectionPayload[]`. When there is exactly one payload, it renders that list alone with the section heading, so single-source sections look exactly as they do today. When there is more than one, each payload gets its own sub-heading ("Gear", "Supplies") above its list, because a plate carrier and a pack of chest seals are not interchangeable rows. Reuse `GearClientPage`, `SupplyClientPage` and `AccessoriesClientPage` for the lists rather than re-implementing them; pass `heading`/`subheading` through for the single-payload case and suppress their internal headers for the multi-payload case.

`SupplyTimezoneNotice` must still appear when any payload reports `timezoneConfigured: false` — render it once for the whole page, not once per payload, or a mixed section shows it twice. That notice is the only thing telling a default install its expiry verdicts came from the host timezone rather than a configured one.

An empty payload still renders its list component and its existing empty state. Empty sections appear in the nav with a zero count by spec decision — hiding the block would make the same information invisible one level down.

- [ ] **Step 7: Reduce both `[slug]` pages**

Each becomes: resolve the slug, check the group, load, render. `/prep/[slug]`:

```tsx
const { slug } = await params;
const section = sectionBySlug(slug);
if (!section || section.group !== "prep") notFound();

let payloads: SectionPayload[];
try {
  payloads = await loadSectionItems(section);
} catch {
  return <SectionLoadError label={section.label} href={`/prep/${section.slug}`} />;
}

return <SectionView section={section} payloads={payloads} />;
```

`/gear/[slug]` is identical with `"gear"` and `/gear/`. Delete `getSectionGear`, `getSectionAccessories` and the inline retry JSX from the gear page. **Delete the supply-source `notFound()`** from the prep page — that guard is what made a gear-only prep section a 404, and the loader now handles a section with no matching source by returning an empty payload list. Task 6 adds the test that would have caught it.

- [ ] **Step 8: Verify in a browser**

With a fresh `npm run dev`, at 390px and desktop:
1. `/prep/armor` renders — a gear-only prep section. **This is the route that would have 404'd.**
2. `/prep/medical` shows both a Gear block and a Supplies block, with the right items in each.
3. `/gear/knives`, `/gear/optics`, `/gear/parts`, `/gear/cleaning` are unchanged from before this task.
4. `/gear/nonsense` and `/prep/nonsense` still 404.
5. `/prep/armor` with no armor items shows the empty state, not a blank page.

- [ ] **Step 9: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/lib/sections src/components/sections src/app/gear src/app/prep`

```bash
git add src/lib/sections src/components/sections src/app/gear src/app/prep src/app/supplies
git commit -m "feat: render every source a section declares, not just the first

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Close the reachability gap — a registered section must RENDER, not just resolve

**Files:**
- Modify: `src/lib/categories.test.ts`
- Modify: `src/lib/categories.ts` (add `sectionIsRenderable`)

**Interfaces:**
- Consumes: `sectionSources` (Task 4), the loader's contract (Task 5).
- Produces: `sectionIsRenderable(section): boolean`, consumed by both `[slug]` pages and the test.

**The gap, precisely.** Phase 4's reachability test asserts that `sectionHref(section)` resolves to a `page.tsx` on disk. It cannot see that the page's own body calls `notFound()` — which is exactly what `/prep/[slug]` did for any section without a supply matcher. `/prep/armor` would have passed the existing test and 404'd in a browser. Five new prep sections make that a live risk, not a hypothetical.

- [ ] **Step 1: Write the failing test**

```ts
describe("section renderability", () => {
  it("gives every registered section at least one source to render", () => {
    for (const section of CATEGORY_SECTIONS) {
      expect(
        sectionSources(section).length,
        `${section.slug} declares no source, so its page would render nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("builds a non-null where clause for every source a section declares", () => {
    // A section can declare a source kind whose where-builder returns null —
    // the loader skips it, and a section whose ONLY source did that would
    // render an empty page forever while every matching test stayed green.
    const builders = {
      firearm: firearmWhereForSection,
      accessory: accessoryWhereForSection,
      gear: gearWhereForSection,
      supply: supplyWhereForSection,
    } as const;
    for (const section of CATEGORY_SECTIONS) {
      for (const kind of sectionSources(section)) {
        expect(
          builders[kind](section),
          `${section.slug} declares a ${kind} source with no where clause`,
        ).not.toBeNull();
      }
    }
  });

  it("agrees with sectionIsRenderable, which the pages gate on", () => {
    for (const section of CATEGORY_SECTIONS) {
      expect(sectionIsRenderable(section), `${section.slug}`).toBe(true);
    }
  });

  it("fails a section with no sources, so the check above is not vacuous", () => {
    expect(
      sectionIsRenderable({
        slug: "hollow",
        label: "Hollow",
        description: "",
        group: "prep",
        icon: "Package",
        sources: [],
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch the last two fail**

Run: `npx vitest run src/lib/categories.test.ts -t renderability`
Expected: FAIL — `sectionIsRenderable` is not exported.

- [ ] **Step 3: Implement `sectionIsRenderable`**

```ts
/**
 * Whether a section's page can show anything at all: at least one declared
 * source, and a real where clause for each one it declares.
 *
 * Exists because "the route resolves" and "the page renders" are different
 * claims, and the test suite only ever checked the first. `/prep` shipped as
 * a 404 the sidebar linked from every page; `/prep/armor` would have shipped
 * the same way — the route file exists, but the page's own supply-matcher
 * guard called notFound() for a gear-only section. Both pages now gate on
 * this function and the test asserts it holds for every registered section,
 * so the page and the test can no longer disagree.
 */
export function sectionIsRenderable(section: CategorySection): boolean {
  const kinds = sectionSources(section);
  if (kinds.length === 0) return false;
  return kinds.every((kind) => {
    switch (kind) {
      case "firearm":
        return firearmWhereForSection(section) !== null;
      case "accessory":
        return accessoryWhereForSection(section) !== null;
      case "gear":
        return gearWhereForSection(section) !== null;
      case "supply":
        return supplyWhereForSection(section) !== null;
    }
  });
}
```

- [ ] **Step 4: Gate both `[slug]` pages on it**

In `/gear/[slug]` and `/prep/[slug]`, after the group check:

```tsx
if (!sectionIsRenderable(section)) notFound();
```

This is the only `notFound()` about sources either page may contain. It is safe precisely because the test above asserts it is never true for a registered section — a 404 here means the registry is broken, and the test says so before a user does.

- [ ] **Step 5: Prove the guard fails when it should**

Temporarily add a section to `CATEGORY_SECTIONS` with `sources: []`. Run `npx vitest run src/lib/categories.test.ts`. Expected: three failures — "at least one source", "agrees with sectionIsRenderable", and the existing route-reachability check (no `page.tsx` for its slug is irrelevant; it resolves through `[slug]`, so confirm which ones actually fire and report honestly). Remove it.

Do **not** verify by deleting `src/app/prep/page.tsx` — that is the phase-4 guard, already proven. This one is about a section whose route exists and whose page refuses to render it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/categories.ts src/lib/categories.test.ts src/app/gear src/app/prep
git commit -m "test: assert every registered section can render, not just resolve

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: The Preparedness overview earns its seven sections

**Files:**
- Modify: `src/app/prep/page.tsx`
- Verify (likely no change): `src/components/layout/Sidebar.tsx`, `src/app/api/categories/counts/route.ts`

**Interfaces:**
- Consumes: the seven sections from Task 4.
- Produces: nothing later tasks import.

Both the sidebar's prep `NavGroup` and `/prep` already derive their lists from `sectionsForGroup("prep")`, and the counts route already sums all four source kinds per section — so the seven sections and their counts appear with no change to any of the three. **Verify that claim before writing code**; if it holds, this task is the subtitle, the counts on the cards, and the evidence.

- [ ] **Step 1: Confirm what already works**

With a fresh `npm run dev`, load `/prep` and the sidebar. Record in the report: which of the seven sections appear, whether the sidebar lists all seven, and what `curl -s localhost:3000/api/categories/counts | jq '.counts'` returns for the five new slugs. If a count is missing or wrong for a **mixed** section, that is a real bug in the counts route's summing — fix it here.

- [ ] **Step 2: Fix the stale subtitle**

`"Medical, food & water stores"` described the two sections phase 4 shipped. Replace with:

```tsx
        subtitle="Armor, medical, food, water, power & bugout stores"
```

- [ ] **Step 3: Show a count on each card**

`/prep` is currently a static server component with no data. Add the count the same way the vault and gear group pages do it — read the same helper they use rather than inventing a third path. If they fetch `/api/categories/counts` client-side, do that; if they count directly, count directly, sequentially.

Render it as a subtle right-aligned number on each card. A zero count renders as `0`, not as a hidden card: empty sections appear with a zero count by spec decision, because hiding them makes the collection's shape invisible.

- [ ] **Step 4: Verify at both widths and commit**

Check `/prep` at 390px: seven cards, one column, no horizontal scroll, counts visible and not colliding with long labels ("Shelter & Clothing", "Other Prep"). Then:

Run: `npx tsc --noEmit -p . && npx eslint src/app/prep && npx vitest run`

```bash
git add src/app/prep
git commit -m "feat: the preparedness overview lists all seven sections with counts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Search, exports and the dashboard learn the new gear

**Files:**
- Modify: `src/app/api/search/route.ts` (+ its test)
- Modify: `src/app/api/exports/full-armory/route.ts`
- Modify: `src/app/api/exports/data/route.ts`
- Modify: `src/components/dashboard/SupplyAlertsWidget.tsx` and its server-side data source
- Test: the existing export and search test files

**Interfaces:**
- Consumes: Task 1's categories and columns, Task 4's registry.
- Produces: nothing later tasks import.

- [ ] **Step 1: Search**

`src/app/api/search/route.ts` already derives its category matching from `GEAR_CATEGORIES` and `GEAR_CATEGORY_LABELS`, so the eighteen new categories become searchable with no change — the comment at line 29 says exactly that. **Verify it** by adding a test asserting a search for "armor" returns a gear item with `category: "ARMOR"`, and one asserting "medical kit" matches `MEDICAL_KIT` by label. If the derivation does not in fact cover them, fix it.

Also confirm a gear search result's URL resolves: `/gear/item/<id>` is correct for every category, including the fourteen whose **section** now lives under `/prep`. The item route is not section-scoped, so it should hold — assert it rather than assume it.

- [ ] **Step 2: Export the armor fields and gear expiry**

In `src/app/api/exports/full-armory/route.ts`, the gear sheet gains three columns: `Expires`, `Protection Level`, `Size / Cut`. Follow the lesson from the phase-3 export bug: **carry each value in its own column**. Collapsing platform into class made the PDF print `Class: PISTOL` for an SBR; do not fold `protectionLevel` into the category cell.

A non-armor row leaves the two armor cells empty rather than printing a dash or the string "null".

- [ ] **Step 3: Add the timezone footnote**

The export is the fourth `expiryStatus` call site and the only one that says nothing about which timezone decided "expired". Add a footnote wherever the export already carries its generated-at line:

```
Expiry evaluated in <timezone> on <YYYY-MM-DD>.
```

Take both values from the same resolved expiry context the rows used — never a second `new Date()` and never a second `AppSettings` read, or the footnote can disagree with the rows it annotates. When `AppSettings.timezone` is unset, name the host timezone and say so: `Expiry evaluated in America/Denver (server default) on 2026-09-24.`

- [ ] **Step 4: Check the serial-number toggle still holds**

`Gear.serialNumber` exists and the data export has leaked serials four separate ways in this epic — including through `builds` slots' nested accessory objects. Add a test asserting `Gear.serialNumber` is absent from `/api/exports/data` output when the include-serials toggle is off, and that it is absent from **every** nesting path, not just the top-level gear array.

- [ ] **Step 5: Expiring gear joins the dashboard alerts**

`SupplyAlertsWidget` shows low and expiring supplies. Armor plates and filters expire too, and a dashboard that silently ignores half the expiring inventory is worse than one that shows none. Extend its server-side query to include gear whose `expirationDate` is expired or within the warning window, labelled so the two are distinguishable in the list.

Resolve `today` once, from the same `todayForExpiry` path. The widget is a client component; it must receive resolved statuses, never compute them.

Keep the widget's existing name and file. It is a byte-copy of `LowAmmoWidget` — noted, not fixed here; deduplicating three dashboard widgets is its own change, not a rider on this one.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/app/api src/components/dashboard`

Then by hand, with a fresh dev server: create an armor item with a past expiry and confirm it appears in the dashboard alerts; open Settings > Full Armory Export > Preview and confirm the three new columns render with proper spacing, the footnote names a timezone, and the letter-width print preview does not clip the new columns. The phase-3 review found a print flow clipping 457px — the entire NFA feature — off a page the preview itself offers to print, so **print it, do not just look at it**.

```bash
git add src/app/api src/components/dashboard
git commit -m "feat: gear armor, expiry and the timezone footnote reach search, exports and the dashboard

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Retire the two hand-rolled `toDateInputValue` copies

**Files:**
- Modify: `src/app/accessories/[id]/edit/page.tsx` (local helper at line 47; call sites at 442, 567)
- Modify: `src/app/vault/[id]/edit/page.tsx` (local helper at line 67; call sites at 675, 739)

**Interfaces:**
- Consumes: `toISODate` from `@/lib/date`.
- Produces: nothing.

**Not part of phase 5's feature work.** It is on the carried-gaps list, it is the same bug class the phase-4 timezone work established, the correct helper already exists and the gear edit page already uses it. Batched here as one small same-shape change across two files so it can be reviewed — or dropped — on its own.

Both pages define:

```ts
function toDateInputValue(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toISOString().split("T")[0];
  } catch {
    return "";
  }
}
```

`new Date(x).toISOString()` yields the **UTC** day. For a date-only column stored at UTC midnight the two agree, but for any value carrying a time-of-day west of UTC it shows the previous day — the user opens an edit form and finds the date one day earlier than the detail page shows.

- [ ] **Step 1: Delete both local helpers and import the shared one**

Add `toISODate` to each page's existing import from `@/lib/date` and replace all four call sites. `toISODate` normalises through `toDateOnlyUTC`, which is the same helper the API writes with, so the form round-trips a value unchanged.

`toISODate` **throws** on a malformed value where the local helper returned `""`. Both call sites read a column the API wrote through `toDateOnlyUTC`, so a malformed value means the database already holds something no write path can produce — but confirm the behaviour rather than assuming it, and if the throw can reach a render, wrap it.

- [ ] **Step 2: Verify by hand**

With a fresh dev server, open a firearm with an acquisition date and an accessory with a battery-change date. The date in the edit form must equal the date on the detail page. Check in the evening, or temporarily run the dev server with `TZ=America/Denver` and a value stored with a time-of-day, so the off-by-one would actually show.

- [ ] **Step 3: Verify and commit**

Run: `npx vitest run && npx tsc --noEmit -p . && npx eslint src/app/accessories src/app/vault`

```bash
git add src/app/accessories src/app/vault
git commit -m "fix: read edit-form dates through toISODate, not the UTC day

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Not in this phase

- **`Kit` and `KitItem`**, and the Kits section the spec lists under Preparedness. Phase 6.
- **`purchasePrice` validation in the other five write routes** (firearms, accessories, ammo, ammo transactions, supplies). Task 2 extracts `normalizeMoney` to `@/lib/money` and validates gear's, which is the route it already rewrites. Pointing the other five at the shared helper is a five-file change with its own review surface.
- **Deduplicating the three dashboard widgets.** `SupplyAlertsWidget` is a byte-copy of `LowAmmoWidget`; Task 8 extends it without fixing that.
- **`src/lib/exports/full-armory-pdf.ts`**, unwired dead code whose deletion would orphan `jspdf` and `pdf-lib`. A capability decision, not a cleanup.
- **A `/supplies` index page.** The route has no `page.tsx` and 404s, but nothing rendered links to it.
- **Windows `install.bat` / `update.bat`**, still never run on Windows.
