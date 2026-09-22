# Date-Only Handling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a date picked as `2026-09-20` display as `Sep 20, 2026` in every timezone, and make
form date defaults show the viewer's local date — without migrating any data.

**Architecture:** Keep `DateTime` storage. Split the single ambiguous `formatDate` helper into two
explicit ones — `formatDateOnly` (pinned to UTC) and `formatTimestamp` (browser-local) — and route
every write to a date-only field through one normalizer, `toDateOnlyUTC`, that forces
`00:00:00.000Z`. Deleting the generic `formatDate` name is deliberate: a call site must choose its
semantics rather than inherit the wrong one by default.

**Tech Stack:** Next.js 16.1.6, React 19, TypeScript 5, Prisma 5.22, vitest

**Spec:** `docs/superpowers/specs/2026-09-21-date-only-handling-design.md`

## Global Constraints

- **App/display time is browser-local. DB and wire time is UTC.** (User directive.)
- The nine date-only fields are exactly: `Firearm.acquisitionDate`, `Firearm.lastMaintenanceDate`,
  `Accessory.acquisitionDate`, `Accessory.lastBatteryChangeDate`, `AmmoStock.purchaseDate`,
  `AmmoTransaction.purchaseDate`, `RangeSession.sessionDate`, `SessionDrill.drillDate`,
  `MaintenanceLog.date`.
- Audit timestamps (`createdAt`, `updatedAt`, `loggedAt`, `transactedAt`, `cachedAt`,
  `changedAt`) are **instants** and must keep rendering browser-local. Do not touch them.
- `BatteryChangeLog.changedAt` and `RoundCountLog.loggedAt` are **timestamps**, not date-only.
- **No data migration.** Verified: all stored `acquisitionDate` values are already at exact UTC
  midnight (4/4 by `% 86400000 = 0`).
- No schema change. `prisma/schema.prisma` is not edited by this plan.
- A server cannot know the browser's timezone. Server-side "today" fallbacks are documented
  approximations, never presented as local.
- `npm run lint` must stay at **0 errors**. `npm test` must stay green.
- Branch `fix/date-only-handling` off `develop`, PR into `develop`.
- `gh pr create` requires `--repo doomcrewinc/BlackVaultArmory` in this fork.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `vitest.config.ts` | Modify | Pin `TZ` so date tests are deterministic on any host |
| `src/lib/date.ts` | **Create** | The four date helpers — sole sanctioned entry points |
| `src/lib/date.test.ts` | **Create** | Unit tests incl. multi-timezone proofs |
| `src/lib/utils.ts` | Modify | Remove `formatDate`; keep `formatDateInput` |
| 9 display files | Modify | Point 17 call sites at the correct explicit helper |
| 5 API route files | Modify | Route date-only writes through `toDateOnlyUTC` |
| 3 form files | Modify | Replace UTC "today" defaults with `todayLocalISO()` |

---

## Task 1: The date helper module

**Files:**
- Modify: `vitest.config.ts`
- Create: `src/lib/date.ts`
- Test: `src/lib/date.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `toDateOnlyUTC(input: Date | string): Date` — forces `00:00:00.000Z`
  - `formatDateOnly(value: Date | string | null | undefined): string` — pinned UTC, `"—"` when null
  - `formatTimestamp(value: Date | string | null | undefined, timeZone?: string): string` — browser-local by default
  - `todayLocalISO(now?: Date): string` — local `YYYY-MM-DD`

- [ ] **Step 1: Create the branch**

```bash
cd /Users/doomcrew/repos/BlackVaultArmory
git checkout develop && git pull
git checkout -b fix/date-only-handling
```

- [ ] **Step 2: Pin the test timezone**

`todayLocalISO` reads local date parts, so a test asserting its output is only deterministic if
the host timezone is fixed. CI runners are UTC; this machine is `America/Denver`. Pin it.

Replace `vitest.config.ts` with:

```ts
import path from "node:path";

export default {
  test: {
    environment: "node",
    // Pinned so date-only tests are deterministic regardless of host timezone.
    // America/Denver is UTC-6/-7, which is what surfaces the off-by-one this
    // module exists to fix.
    env: { TZ: "America/Denver" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
};
```

- [ ] **Step 3: Confirm the TZ pin actually takes effect**

Node applies `TZ` only if it is set before the first `Date` use, so verify rather than assume.

Create a scratch file `src/lib/tz-probe.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("test timezone pin", () => {
  it("runs in America/Denver", () => {
    expect(new Date("2026-09-21T01:30:00.000Z").getDate()).toBe(20);
  });
});
```

Run: `npm test -- src/lib/tz-probe.test.ts`
Expected: PASS. `01:30Z` on the 21st is `19:30` on the 20th in Denver, so `getDate()` is `20`.

**If it FAILS**, the `env` option is not applying in time. Do not work around it silently —
instead set the timezone in the npm script (`"test": "TZ=America/Denver vitest run"`), re-run, and
note the change in your report. If neither works, report `BLOCKED`.

Once it passes, delete the probe:

```bash
rm src/lib/tz-probe.test.ts
```

- [ ] **Step 4: Write the failing tests**

Create `src/lib/date.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatDateOnly, formatTimestamp, toDateOnlyUTC, todayLocalISO } from "./date";

describe("toDateOnlyUTC", () => {
  it("normalizes a YYYY-MM-DD string to UTC midnight", () => {
    expect(toDateOnlyUTC("2026-09-20").toISOString()).toBe("2026-09-20T00:00:00.000Z");
  });

  it("strips the time from a full ISO timestamp", () => {
    expect(toDateOnlyUTC("2026-09-20T18:45:12.345Z").toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    );
  });

  it("strips the time from a Date", () => {
    expect(toDateOnlyUTC(new Date("2026-09-20T23:59:59.999Z")).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z"
    );
  });

  it("uses the UTC calendar day, not the local one", () => {
    // 01:30Z on the 21st is still the 20th in America/Denver. The UTC day wins,
    // because the stored value is UTC and the server cannot know the viewer's zone.
    expect(toDateOnlyUTC(new Date("2026-09-21T01:30:00.000Z")).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z"
    );
  });

  it("is idempotent", () => {
    const once = toDateOnlyUTC("2026-09-20");
    expect(toDateOnlyUTC(once).toISOString()).toBe(once.toISOString());
  });

  it("throws on an unparseable input rather than storing Invalid Date", () => {
    expect(() => toDateOnlyUTC("not-a-date")).toThrow(/invalid date/i);
  });
});

describe("formatDateOnly", () => {
  it("shows the stored calendar day, not the local one", () => {
    // This is the bug: under browser-local formatting in Denver this rendered "Sep 19".
    expect(formatDateOnly("2026-09-20T00:00:00.000Z")).toBe("Sep 20, 2026");
  });

  it("is pinned to UTC, so the host timezone cannot shift it", () => {
    // The suite runs in America/Denver (UTC-6). A local formatter would say Sep 19.
    expect(formatDateOnly(new Date("2026-09-20T00:00:00.000Z"))).toBe("Sep 20, 2026");
  });

  it("renders a dash for null and undefined", () => {
    expect(formatDateOnly(null)).toBe("—");
    expect(formatDateOnly(undefined)).toBe("—");
  });
});

describe("formatTimestamp", () => {
  it("renders in the supplied timezone", () => {
    const instant = "2026-09-20T02:00:00.000Z";
    expect(formatTimestamp(instant, "UTC")).toContain("Sep 20");
    // UTC-11: 02:00Z on the 20th is 15:00 on the 19th.
    expect(formatTimestamp(instant, "Pacific/Pago_Pago")).toContain("Sep 19");
    // UTC+13: 02:00Z on the 20th is 15:00 on the 20th.
    expect(formatTimestamp(instant, "Pacific/Auckland")).toContain("Sep 20");
  });

  it("renders a dash for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });
});

describe("todayLocalISO", () => {
  it("returns the LOCAL date, not the UTC one, across the boundary", () => {
    // 01:30Z on the 21st is 19:30 on the 20th in America/Denver.
    // The old `new Date().toISOString().split("T")[0]` returned 2026-09-21 here.
    expect(todayLocalISO(new Date("2026-09-21T01:30:00.000Z"))).toBe("2026-09-20");
  });

  it("agrees with UTC when the local day matches", () => {
    expect(todayLocalISO(new Date("2026-09-20T18:00:00.000Z"))).toBe("2026-09-20");
  });

  it("zero-pads month and day", () => {
    expect(todayLocalISO(new Date("2026-01-05T18:00:00.000Z"))).toBe("2026-01-05");
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -- src/lib/date.test.ts`
Expected: FAIL — `Failed to resolve import "./date"`.

- [ ] **Step 6: Write the implementation**

Create `src/lib/date.ts`:

```ts
/**
 * date.ts — the only sanctioned way to read or write a date in this app.
 *
 * Two kinds of temporal value exist here and they must not be confused:
 *
 *   DATE-ONLY   a calendar day with no time: acquisitionDate, sessionDate,
 *               purchaseDate, lastMaintenanceDate, lastBatteryChangeDate,
 *               drillDate, MaintenanceLog.date.
 *               Stored as DateTime pinned to 00:00:00.000Z.
 *               Written with toDateOnlyUTC(). Displayed with formatDateOnly().
 *
 *   TIMESTAMP   an instant: createdAt, updatedAt, loggedAt, transactedAt,
 *               cachedAt, changedAt.
 *               Stored UTC. Displayed with formatTimestamp() in local time.
 *
 * A date-only value rendered in local time is off by one day for every viewer
 * west of UTC — that is the bug this module exists to prevent. There is
 * deliberately no generic `formatDate`: every call site must state which kind
 * of value it holds.
 */

const DASH = "—";

/**
 * Force a value onto UTC midnight of its UTC calendar day.
 * The only correct way to write a date-only field.
 *
 * Throws on unparseable input — storing an Invalid Date would corrupt the row
 * silently, and a date-only column has no sentinel for "unknown" other than null,
 * which the caller must choose explicitly.
 */
export function toDateOnlyUTC(input: Date | string): Date {
  const parsed = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`toDateOnlyUTC: invalid date input: ${String(input)}`);
  }
  return new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate())
  );
}

/**
 * Render a date-only value. Pinned to UTC so the stored calendar day is shown
 * verbatim to every viewer, in any timezone.
 */
export function formatDateOnly(value: Date | string | null | undefined): string {
  if (!value) return DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Render an instant in the viewer's local timezone.
 * `timeZone` exists for tests; production callers omit it.
 */
export function formatTimestamp(
  value: Date | string | null | undefined,
  timeZone?: string
): string {
  if (!value) return DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return DASH;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

/**
 * Today's date in the VIEWER's timezone, as YYYY-MM-DD for a date input.
 *
 * Deliberately not `new Date().toISOString().split("T")[0]`, which returns the
 * UTC day and therefore shows tomorrow to anyone west of UTC late in the evening.
 * Call this from client components only — on the server "local" is the
 * container's timezone, which is UTC in Docker and not the user's.
 */
export function todayLocalISO(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -- src/lib/date.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 8: Run the whole suite and lint**

Run: `npm test && npm run lint`
Expected: all green, lint at 0 errors. The pre-existing suites must be unaffected by the pinned TZ —
if any of them start failing because of it, report that as a concern rather than editing them.

- [ ] **Step 9: Commit**

```bash
git add vitest.config.ts src/lib/date.ts src/lib/date.test.ts
git commit -m "feat: add explicit date-only and timestamp helpers

Introduces toDateOnlyUTC, formatDateOnly, formatTimestamp and
todayLocalISO. Date-only values are pinned to UTC on write and rendered
in UTC on read, so a day picked as 2026-09-20 shows as Sep 20 in every
timezone. Instants keep rendering in the viewer's local zone.

Pins the vitest timezone to America/Denver so the off-by-one these
helpers prevent is actually exercised on a UTC CI runner.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Retire `formatDate` and fix every display call site

**Files:**
- Modify: `src/lib/utils.ts`
- Modify: `src/app/accessories/AccessoriesClientPage.tsx`
- Modify: `src/app/accessories/[id]/page.tsx`
- Modify: `src/app/exports/full-armory/preview/page.tsx`
- Modify: `src/app/api/exports/full-armory/route.ts`
- Modify: `src/app/vault/[id]/page.tsx`
- Modify: `src/components/dashboard/DashboardClient.tsx`
- Modify: `src/components/vault/MaintenanceSection.tsx`
- Modify: `src/lib/exports/full-armory-pdf.ts`

**Interfaces:**
- Consumes: `formatDateOnly`, `formatTimestamp` from Task 1
- Produces: no `formatDate` identifier anywhere in `src/`

- [ ] **Step 1: Remove `formatDate` from utils**

In `src/lib/utils.ts`, delete the whole `formatDate` function:

```ts
export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(date));
}
```

**Keep `formatDateInput` unchanged.** It reads a stored UTC-midnight value back through
`toISOString()`, which yields the correct `YYYY-MM-DD` — it is already right for date-only fields.

- [ ] **Step 2: Find every call site**

```bash
grep -rn "formatDate(" src/ | grep -v formatDateInput
```

There are 17. For each one, decide from the **field name** which helper applies:

- One of the nine date-only fields (`acquisitionDate`, `lastMaintenanceDate`, `purchaseDate`,
  `sessionDate`, `drillDate`, `lastBatteryChangeDate`, `MaintenanceLog.date`, a derived
  maintenance/battery **due date**) → `formatDateOnly`
- `createdAt`, `updatedAt`, `loggedAt`, `transactedAt`, `cachedAt`, `changedAt`, or any
  "uploaded/generated/exported at" → `formatTimestamp`

A derived due date (`lastMaintenanceDate + intervalDays`) is date-only: it is computed from a
date-only value, so it inherits those semantics.

- [ ] **Step 3: Update each call site and its import**

Replace `import { formatDate } from "@/lib/utils"` with the needed helper(s) from
`@/lib/date`, keeping any other `utils` imports on their original line. Example shape:

```ts
import { formatCurrency } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
```

- [ ] **Step 4: Verify no call site was missed**

```bash
grep -rn "formatDate(" src/ | grep -v formatDateInput && echo "MISSED A CALL SITE" || echo "all migrated"
grep -rn "formatDate\b" src/ | grep -v formatDateInput | grep -v formatDateOnly && echo "IDENTIFIER SURVIVES" || echo "formatDate fully retired"
```

Expected: `all migrated` and `formatDate fully retired`.

- [ ] **Step 5: Verify build and lint**

Run: `npm run lint && npm test && npm run build`
Expected: all pass. TypeScript will catch any missed import.

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "refactor: replace formatDate with explicit date-only and timestamp helpers

Date-only fields rendered through a browser-local formatter displayed a
day early for every viewer west of UTC. Each of the 17 call sites now
states which kind of value it holds, and the ambiguous formatDate name
is gone so a new call site cannot inherit the wrong semantics.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Normalize writes and fix form defaults

**Files:**
- Modify: `src/app/api/firearms/route.ts:106,112,131`
- Modify: `src/app/api/firearms/[id]/route.ts:113,121`
- Modify: `src/app/api/accessories/route.ts:111,119`
- Modify: `src/app/api/accessories/[id]/route.ts:129,139`
- Modify: `src/app/api/accessories/[id]/battery/route.ts:14-15`
- Modify: `src/app/api/ammo/route.ts:101`
- Modify: `src/app/api/ammo/[id]/route.ts:81`
- Modify: `src/app/api/ammo/[id]/transactions/route.ts:102`
- Modify: `src/app/api/range/sessions/route.ts:162`
- Modify: `src/app/api/range/sessions/[id]/route.ts`
- Modify: `src/app/api/range/sessions/[id]/drills/route.ts:129`
- Modify: `src/app/api/range/drills/route.ts:75`
- Modify: `src/app/api/firearms/[id]/maintenance/route.ts`
- Modify: `src/app/vault/new/page.tsx:378`
- Modify: `src/app/accessories/[id]/page.tsx:124,218`
- Modify: `src/app/accessories/[id]/edit/page.tsx:37`

**Interfaces:**
- Consumes: `toDateOnlyUTC`, `todayLocalISO` from Task 1
- Produces: every date-only write pinned to UTC midnight

- [ ] **Step 1: Route every date-only write through the normalizer**

For each of the nine date-only fields, replace bare `new Date(x)` with `toDateOnlyUTC(x)`.
The already-safe pattern still changes, because correctness should not depend on the caller
having passed a bare `YYYY-MM-DD`:

```ts
// before
acquisitionDate: acquisitionDate ? new Date(acquisitionDate) : null,
// after
acquisitionDate: acquisitionDate ? toDateOnlyUTC(acquisitionDate) : null,
```

**Do not touch** `createdAt`, `updatedAt`, `loggedAt`, `transactedAt`, `cachedAt`, or
`BatteryChangeLog.changedAt` — those are instants.

- [ ] **Step 2: Fix the five server-side "today" fallbacks**

These write a non-midnight instant to a date-only field — the exact failure this approach is
vulnerable to. Each becomes a normalized UTC today, with a comment naming the limitation:

`src/app/api/firearms/route.ts:106`

```ts
        // No date supplied: fall back to UTC's today. The server cannot know the
        // viewer's timezone (in Docker this container is UTC), so the client sends
        // the date whenever it has one.
        acquisitionDate: acquisitionDate
          ? toDateOnlyUTC(acquisitionDate)
          : toDateOnlyUTC(new Date()),
```

`src/app/api/firearms/route.ts:131`

```ts
          sessionDate: firearm.acquisitionDate
            ? toDateOnlyUTC(firearm.acquisitionDate)
            : toDateOnlyUTC(new Date()),
```

`src/app/api/range/sessions/route.ts:162`

```ts
      return Number.isNaN(parsed.getTime())
        ? toDateOnlyUTC(new Date())
        : toDateOnlyUTC(parsed);
```

`src/app/api/range/drills/route.ts:75`

```ts
          sessionDate: toDateOnlyUTC(new Date()),
```

`src/app/api/accessories/[id]/battery/route.ts:14-15`

```ts
      ? toDateOnlyUTC(body.lastBatteryChangeDate)
      : toDateOnlyUTC(new Date()),
```

- [ ] **Step 3: Fix the client-side "today" defaults**

Replace every `new Date().toISOString().split("T")[0]` used as a **form default** with
`todayLocalISO()`. These are client components, so local is genuinely the viewer's:

- `src/app/vault/new/page.tsx:378`
- `src/app/accessories/[id]/page.tsx:124` and `:218`

```tsx
// before
defaultValue={new Date().toISOString().split("T")[0]}
// after
defaultValue={todayLocalISO()}
```

At `src/app/accessories/[id]/edit/page.tsx:37`, the call reads a **stored** value rather than
producing today. Leave its behaviour intact — `new Date(dateStr).toISOString().split("T")[0]` on a
UTC-midnight value is already the correct `YYYY-MM-DD`. Replace it with `formatDateInput(dateStr)`
only if that is a pure simplification; otherwise leave it and say so in your report.

- [ ] **Step 4: Verify no UTC "today" default survives**

```bash
grep -rn 'new Date().toISOString().split' src/app --include="*.tsx" && echo "UTC TODAY DEFAULT SURVIVES" || echo "all form defaults now local"
```

Expected: `all form defaults now local`. Hits inside `src/app/api/` are fine — those are wire
timestamps, not form defaults — so check what any remaining match actually is before changing it.

- [ ] **Step 5: Prove the round trip end to end**

```bash
./dev.sh --setup-only >/dev/null 2>&1
npx --yes tsx -e '
const { toDateOnlyUTC, formatDateOnly, todayLocalISO } = require("./src/lib/date.ts");
' 2>/dev/null || true
npm test -- src/lib/date.test.ts
```

Then start the app and exercise a real write:

```bash
./dev.sh --port 3055 &
sleep 25
curl -s -X POST http://127.0.0.1:3055/api/firearms \
  -H 'content-type: application/json' \
  -d '{"name":"TZ Probe","manufacturer":"Test","model":"T","caliber":"9mm","serialNumber":"TZ-PROBE-1","type":"PISTOL","acquisitionDate":"2026-09-20"}' | head -c 200
echo
curl -s http://127.0.0.1:3055/api/firearms | python3 -c '
import json,sys
for f in json.load(sys.stdin):
    if f["serialNumber"]=="TZ-PROBE-1": print("stored:", f["acquisitionDate"])
'
pkill -f "next dev.*3055"
```

Expected: the stored value is exactly `2026-09-20T00:00:00.000Z`. Paste the real output into your
report. If the endpoint shape differs from this guess, adapt the call and say what you changed.

- [ ] **Step 6: Verify lint, tests, build**

Run: `npm run lint && npm test && npm run build`
Expected: all pass, lint 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src/
git commit -m "fix: pin date-only writes to UTC midnight and default forms to local today

Every write to one of the nine date-only fields now goes through
toDateOnlyUTC, so a value can no longer land at an arbitrary time and
render as the wrong day. Five server-side fallbacks previously wrote
new Date() straight into a date-only column.

Form date defaults now use todayLocalISO instead of the UTC day, which
showed tomorrow to anyone west of UTC late in the evening.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

| Spec acceptance criterion | Task |
|---|---|
| `2026-09-20` displays as `Sep 20, 2026` in every timezone | 1 (`formatDateOnly` pinned UTC), 2 (call sites) |
| Test proves it for UTC-11, UTC, UTC+13 | 1 (`formatTimestamp` contrast test) |
| Form defaults show the local date, proven across the UTC boundary | 1 (`todayLocalISO` test), 3 Step 3 |
| `toDateOnlyUTC` forces `00:00:00.000Z` for Date, `YYYY-MM-DD`, full ISO | 1 |
| No `formatDate` identifier remains | 2 Step 4 |
| All five write sites route through `toDateOnlyUTC` | 3 Step 2 |
| Audit timestamps still render browser-local | 2 Step 2 (classification rule) |
| Lint 0 errors, tests pass | 1 Step 8, 2 Step 5, 3 Step 6 |

**Type consistency:** `toDateOnlyUTC(input: Date | string): Date`,
`formatDateOnly(value: Date | string | null | undefined): string`,
`formatTimestamp(value, timeZone?)`, and `todayLocalISO(now?: Date): string` are defined in Task 1
and used with those exact signatures in Tasks 2 and 3.

**Placeholder scan:** No TBDs. Task 2 Step 2 gives a classification *rule* rather than listing all
17 sites individually, because the rule is what must be applied correctly — the grep in the same
step enumerates them, and Step 4 proves none were missed.

**Known risks:**
1. **The TZ pin may not apply.** Task 1 Step 3 probes it explicitly and gives a fallback plus a
   BLOCKED path rather than letting a silently-unpinned suite give false confidence.
2. **Pinning TZ could disturb pre-existing suites.** Step 8 says to report rather than edit them.
3. **The end-to-end probe in Task 3 Step 5 guesses the POST body shape.** The implementer is told
   to adapt and disclose rather than force it.
