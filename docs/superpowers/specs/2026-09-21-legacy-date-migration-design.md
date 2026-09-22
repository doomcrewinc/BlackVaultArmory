# Legacy Date Migration — Design Spec

**Date:** 2026-09-21
**Status:** Approved
**Ships with:** the date-only handling fix (same branch, same PR). They cannot ship apart.

## Problem

The date-only handling fix pins the display of ten date-only fields to UTC. That is correct for
every row written from a date picker, which stored exactly UTC midnight. It is **wrong for rows
the old code wrote with `new Date()`**, which stored a true instant:

```
api/firearms/route.ts:106           acquisitionDate: ... : new Date()
api/firearms/route.ts:131           sessionDate: ... ?? new Date()
api/range/drills/route.ts:75        sessionDate: new Date()
api/accessories/[id]/battery/route.ts:15   lastBatteryChangeDate: ... : new Date()
```

The old display rendered in browser-local time, which made those rows **accidentally correct** for
the person who wrote them. Pinning display to UTC breaks them:

| Row, written by a Denver user | Stored | Before the fix | After the fix |
|---|---|---|---|
| from a date picker | `2026-09-20T00:00Z` | Sep 19 ❌ | Sep 20 ✅ |
| `new Date()`, 7:30pm | `2026-09-21T01:30Z` | Sep 20 ✅ | **Sep 21 ❌** |

West of UTC, evening rows shift forward a day. East of UTC, morning rows shift back. So the
display fix, shipped alone, silently moves dates that currently show correctly. This migration
converts each legacy instant into the calendar day its author meant.

## The constraint: the server does not know the author's timezone

Converting `2026-09-21T01:30Z` to "the day the user meant" requires the timezone they were in.
No deployment configures one — every container runs UTC. Truncating to the UTC day would make the
"after" column above permanent.

BlackVault is single-user and self-hosted, so one deployment is effectively one person in one
timezone. The migration needs to be told that zone.

## Decisions

| Decision | Choice |
|---|---|
| Timezone source | A **Settings UI field**, prefilled from the browser, stored as an IANA zone |
| Timezone unknown at startup | **Proceed with UTC** — provisionally |
| Safety | **Audit table** recording every original value; migration is reversible |

These three reconcile through the audit table:

1. **At server start**, migrate every legacy row using the configured zone, or **UTC** if none is
   set. Record each row's original instant in the audit table before changing it.
2. **When the user saves a timezone in Settings**, re-convert every audited row **from its
   recorded original** using that zone.
3. A row is re-converted **only if it still holds the value the migration wrote**. If the user
   edited the date in between, their edit wins and the row is left alone.

UTC therefore becomes a provisional guess the setting later corrects, rather than a permanent
error. Rows are right from day one for users near UTC, and right for everyone once they set a zone.

## Identifying a legacy row

After the date-only fix, every write to a date-only field goes through `toDateOnlyUTC()`, so every
**new** value sits at exact UTC midnight. A value **not** at UTC midnight
(`getTime() % 86_400_000 !== 0`) can only have been written by the old code. That makes detection
exact and the migration idempotent: once normalized, a row is at midnight and is never selected
again by the first-time pass.

Detection runs in application code after a fetch, not in SQL, so it is identical on SQLite and on
Postgres. BlackVault's data volumes are single-user; a full scan per table is acceptable.

## The fields

The ten date-only `(model, field)` pairs:

| Model | Field |
|---|---|
| `Firearm` | `acquisitionDate`, `lastMaintenanceDate` |
| `Accessory` | `acquisitionDate`, `lastBatteryChangeDate` |
| `AmmoStock` | `purchaseDate` |
| `AmmoTransaction` | `purchaseDate` |
| `RangeSession` | `sessionDate` |
| `SessionDrill` | `drillDate` |
| `MaintenanceLog` | `date` |
| `BatteryChangeLog` | `changedAt` |

## Conversion

`normalizeInstant(instant, zone)`: render the instant's calendar date **in `zone`**, then return
UTC midnight of that date. For `2026-09-21T01:30Z`:

- `America/Denver` → Sep 20 → `2026-09-20T00:00:00.000Z`
- `UTC` → Sep 21 → `2026-09-21T00:00:00.000Z`
- `Pacific/Auckland` → Sep 21 → `2026-09-21T00:00:00.000Z`

Implemented with `Intl.DateTimeFormat(..., { timeZone: zone }).formatToParts()`, which needs no
dependency and handles DST correctly.

## Schema

```prisma
model AppSettings {
  // ...existing fields...
  timezone  String?   // IANA zone, e.g. "America/Denver". null = unset.
}

model DateNormalizationAudit {
  id            String   @id @default(cuid())
  model         String   // Prisma model name, e.g. "RangeSession"
  field         String   // e.g. "sessionDate"
  recordId      String
  originalValue DateTime // the instant exactly as the old code stored it
  appliedValue  DateTime // what the migration most recently wrote
  appliedZone   String   // the zone used for appliedValue
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([model, field, recordId])
}
```

The audit table has no foreign keys: it must survive, and stay meaningful, even if the row it
describes is later deleted.

## Triggers

- **Server start** — Next.js `src/instrumentation.ts`, `register()`, Node runtime only. Idempotent,
  so it is safe that it also runs on every dev-server restart.
- **Timezone saved** — `PUT /api/settings`, after a successful write that changed `timezone`.

A migration failure is **logged and never blocks server start** or the settings save. The app must
remain usable if normalization cannot run.

## Validation

A timezone is accepted only if `new Intl.DateTimeFormat("en-US", { timeZone })` does not throw.
An invalid zone is rejected by `PUT /api/settings` with HTTP 400.

## Scope

**In:** the schema changes; `src/lib/date-migration.ts`; the two triggers; zone validation; a
Settings timezone field prefilled from the browser; tests.

**Out (explicit non-goals):**
- Using the timezone for anything other than this migration — for example making server-side
  "today" fallbacks local. A natural follow-up, deliberately excluded here.
- A UI for viewing or reverting the audit table. The data is kept so reversal is *possible*.
- Adding the audit table to backup/restore. The Postgres epic replaces backup's hand-maintained
  model list with a registry guarded by a test that fails on any unregistered model, so it will be
  forced to decide then.

## Acceptance criteria

- [ ] `normalizeInstant` returns the correct UTC-midnight date for the three examples above, and
      handles a DST-transition day.
- [ ] A legacy non-midnight row is normalized at server start and an audit row records its original.
- [ ] A row already at UTC midnight is never touched and never audited.
- [ ] Running the migration twice with the same zone changes nothing the second time.
- [ ] Saving a timezone re-converts audited rows from their originals.
- [ ] A row edited by the user after migration is **not** overwritten by re-conversion.
- [ ] An invalid timezone is rejected with HTTP 400.
- [ ] A migration failure does not prevent the server from starting.
- [ ] The Settings timezone field is prefilled from the browser when unset.
- [ ] `npm run lint` 0 errors; `npm test` green; `npm run build` clean.
