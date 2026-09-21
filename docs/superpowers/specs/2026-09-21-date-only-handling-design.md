# Date-Only Handling — Design Spec

**Date:** 2026-09-21
**Status:** Approved
**Epic:** C (lands before Epic B — Postgres default DB)

## Directive

> "app time should be handled by the browser, DB time should be UTC."

Display and form defaults use the viewer's local timezone. Storage, API payloads, exports and
backups use UTC.

## Problem

The schema has 33 `DateTime` fields that divide cleanly in two:

**Audit timestamps — genuine instants, already correct.** `createdAt` ×9, `updatedAt` ×7,
`loggedAt`, `transactedAt`, `cachedAt`, `changedAt`. Stored UTC, displayed browser-local. No
change needed.

**Domain dates — date-only concepts stored as instants. This is the bug.** Nine fields:

| Model | Field |
|---|---|
| `Firearm` | `acquisitionDate`, `lastMaintenanceDate` |
| `Accessory` | `acquisitionDate`, `lastBatteryChangeDate` |
| `AmmoStock` | `purchaseDate` |
| `AmmoTransaction` | `purchaseDate` |
| `RangeSession` | `sessionDate` |
| `SessionDrill` | `drillDate` |
| `MaintenanceLog` | `date` |

"September 20th" is not an instant. Storing it as one forces a timezone to exist where none
should, and that is the whole defect.

### Confirmed symptom

Verified in `America/Denver`:

```
user picks         : 2026-09-20
stored in DB (UTC) : 2026-09-20T00:00:00.000Z     <- correct
formatDate() shows : Sep 19, 2026                 <- OFF BY ONE
```

A second, narrower symptom: `new Date().toISOString().split("T")[0]` used as a form default
yielded `2026-09-21` while the local date was `2026-09-20` — "today" defaults to tomorrow.

## Decision

**Keep `DateTime` storage. Format date-only fields with `timeZone: "UTC"`.**

Chosen over migrating the nine fields to `String "YYYY-MM-DD"`. No data migration, and the
change is confined to display helpers plus five write sites.

### The accepted risk, and how it is contained

This approach is only correct while **every write to a date-only field lands exactly on UTC
midnight**. A write at any other time renders as the wrong day. That fragility was accepted
knowingly; this spec contains it rather than relying on discipline:

1. **A single normalizing writer.** `toDateOnlyUTC()` is the only sanctioned way to produce a
   date-only value. It forces the time component to `00:00:00.000Z`.
2. **Distinct, non-interchangeable display helpers.** `formatDateOnly()` (UTC) and
   `formatTimestamp()` (browser-local). The generic name `formatDate` is removed so a call site
   cannot silently pick the wrong semantics by defaulting.
3. **Tests that assert normalization**, including the specific late-evening-local case that
   produces the bug.

### Five live instances of the failure mode

These currently write a non-midnight instant to a date-only field:

```
api/firearms/route.ts:106                 acquisitionDate: ... : new Date()
api/firearms/route.ts:131                 sessionDate: ... ?? new Date()
api/range/sessions/route.ts:162           Number.isNaN(parsed) ? new Date() : parsed
api/range/drills/route.ts:75              sessionDate: new Date()
api/accessories/[id]/battery/route.ts:15  lastBatteryChangeDate: ... : new Date()
```

Every other write already uses `X ? new Date(X) : null` on a `"YYYY-MM-DD"` string, which lands
on UTC midnight by construction and is correct as-is.

### Server cannot know the browser's date

Those five fallbacks execute **server-side**. In Docker the container is UTC, so "today" on the
server is not the user's today. A server-side default is therefore always a guess.

**Resolution:** the client always sends the date; the server only normalizes what it receives.
Where a server-side fallback must remain, it normalizes UTC's today and that is documented as a
deliberate approximation — not silently local.

## Scope

**In:**
- `src/lib/date.ts` — `toDateOnlyUTC()`, `formatDateOnly()`, `formatTimestamp()`, `todayLocalISO()`
- Remove `formatDate` in favour of the two explicit helpers; update all 17 call sites
- Normalize the five write sites
- Replace `new Date().toISOString().split("T")[0]` form defaults with `todayLocalISO()`
- Tests for all of the above

**Out (explicit non-goals):**
- Migrating the nine fields to `String`. Rejected in favour of this approach.
- Changing any audit timestamp. They are already correct.
- Postgres native `DATE` (`@db.Date`). Would break Epic B's requirement that both providers keep
  an identical logical shape.
- Any data migration. Existing values were written from date strings and are already at UTC
  midnight; a spot check confirms this before work begins.
- `RoundCountLog.loggedAt` stays a **timestamp**. It records when an action happened, not a
  calendar date.

**Reclassified during the fix wave:** `BatteryChangeLog.changedAt` was originally listed above as
a timestamp that stays out of scope. User decision: it is populated from a date picker and means
"which day the battery was changed," not an instant, so it is now treated as date-only —
written with `toDateOnlyUTC()` and displayed with `formatDateOnly()`, same as the other nine
fields.

## Sequencing

Lands **before** Epic B. The SQLite→Postgres migrator then carries final semantics across in one
hop instead of requiring a follow-up change on already-migrated data.

## Acceptance criteria

- [ ] A date picked as `2026-09-20` displays as `Sep 20, 2026` in **every** timezone.
- [ ] A test proves the above for at least `UTC-11`, `UTC`, and `UTC+13`.
- [ ] Form date defaults show the **local** date, proven by a test fixed at a late-evening local
      time that crosses the UTC boundary.
- [ ] `toDateOnlyUTC()` forces `00:00:00.000Z` for a `Date`, a `"YYYY-MM-DD"` string, and a full
      ISO timestamp.
- [ ] No `formatDate` identifier remains; every call site uses `formatDateOnly` or
      `formatTimestamp` explicitly.
- [ ] All five listed write sites route through `toDateOnlyUTC()`.
- [ ] Audit timestamps still render in browser-local time.
- [ ] `npm run lint` stays at 0 errors; `npm test` passes with the new tests.
