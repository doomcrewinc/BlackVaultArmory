# Audit Log — Design Spec

**Date:** 2026-09-29
**Status:** Draft — awaiting review
**Epic:** Auth + encryption, step 2b (public URL ✅ → accounts ✅ → **audit log** → encryption at rest → phone photo capture)
**Builds on:** `docs/superpowers/specs/2026-09-27-accounts-design.md` (merged, `9f57074`)

## Directive

> "if an item is removed, I can see 'Oh that asshole jeff did it' and assign blame."

Every change to the vault is attributed to the account that made it, permanently, in a record that
nobody can edit or erase through the app — admins included — and that still names Jeff after Jeff's
account is disabled.

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | Scope: every create / edit / delete of inventory and settings, plus security events | user (option C) |
| 2 | Edits record the fields that changed, before and after | user (option C) |
| 3 | Entries are kept forever; no pruning, no retention setting | user |
| 4 | Capture is automatic, in a Prisma client extension, not per-route calls | user (approach B) |
| 5 | A guard test forces every schema model to be either audited or explicitly excluded | approach B |
| 6 | Security events are explicit `recordEvent` calls in the auth/admin routes | approach B |
| 7 | Append-only: no app code path updates or deletes an audit entry | assumption, uncontradicted |
| 8 | Deletes store a snapshot (and cascaded child counts); the item's row is gone | assumption, uncontradicted |
| 9 | Serial numbers, password hashes, token hashes and API keys are never stored — `"[redacted]"` | assumption, uncontradicted |
| 10 | Only admins can view or export the log | assumption, uncontradicted |
| 11 | The audit table is excluded from backup and restore; a restore is itself logged | design default, stated to user |
| 12 | `client-ip.ts` is fixed first: last `X-Forwarded-For` value, only when `TRUSTED_PROXIES` is set, else null | carried from accounts review |

## Data model

`AuditEvent` — one migration per provider (SQLite incremental; PostgreSQL its own timestamped folder;
`0_init` frozen). Enum-like fields are `String` columns with a TS union in `src/lib/accounts.ts`-style
constants (repo convention: SQLite has no enums). JSON is stored as `String` text (portable across both
providers).

| Field | Type | Meaning |
|---|---|---|
| `id` | cuid | |
| `at` | DateTime, default now | UTC instant |
| `actorId` | String? → `User` (onDelete: Restrict) | null = system or anonymous |
| `actorName` | String | Snapshot at the time: `"Display Name (@username)"`, `"system"` or `"anonymous"` |
| `actorIp` | String? | From the fixed client-IP helper; null unless trusted proxies are configured |
| `action` | String | `CREATE` `UPDATE` `DELETE` `LOGIN` `LOGIN_FAILED` `LOGOUT` `INVITE_CREATED` `INVITE_REDEEMED` `ROLE_CHANGED` `USER_DISABLED` `USER_ENABLED` `RESET_LINK_ISSUED` `PASSWORD_CHANGED` `DIRECT_ACCESS_CHANGED` `BACKUP_CREATED` `RESTORE` |
| `entityType` | String? | Prisma model name, e.g. `Firearm` |
| `entityId` | String? | Plain text — not a foreign key, so it survives the row's deletion |
| `entityLabel` | String? | Human snapshot, e.g. `Glock 19 (9mm)` |
| `changes` | String? (JSON) | UPDATE: `{ field: [before, after] }` · DELETE: removed row's fields + `_children: { MaintenanceLog: 12, … }` · CREATE: key fields · security events: event details |

Indexes: `at`, `(entityType, entityId)`, `actorId`, `action`.

**Redaction** — a single `REDACTED_FIELDS` list (`serialNumber`, `passwordHash`, `tokenHash`,
`googleCseApiKey`, and any field whose name matches `/secret|token|password|apikey/i`). A redacted field
that changed is recorded as `{ field: ["[redacted]", "[redacted]"] }`, so the change is visible and the
values are not.

**Labels** — a per-model label function (name / manufacturer+model / caliber, etc.), with a fallback of
`"<Model> <id>"`.

**Append-only** — the extension throws on `update`, `updateMany`, `upsert`, `delete`, `deleteMany` of
`AuditEvent`. No route writes to it except through `recordEvent` / the extension. A person with shell
access to the database can still alter rows — accepted threat model.

## Which models are audited

- **Audited automatically:** every inventory model (Firearm, Accessory, AmmoStock, AmmoTransaction, Gear,
  Supply, Kit, KitItem, Build, BuildSlot, Document, MaintenanceLog, BatteryChangeLog, RangeSession,
  RangeSessionAmmoLink, SessionDrill, RoundCountLog) and `AppSettings`.
- **Excluded, with reasons in code:** `Session` (noise), `AuthToken` and `User` (covered by explicit
  security events), `ImageCache` and `DateNormalizationAudit` (system data), `AuditEvent` (itself).
- The exact list is whatever `Prisma.dmmf` holds when the plan is written; the **guard test** fails when
  a model is in neither list.

## Capture mechanics

### Actor

The extension resolves the actor itself, per operation, through `getCurrentUser()` (which reads the
request cookie via Next's request context and is memoised per request). No route wrapper exists to be
forgotten.

- In a request with a signed-in user → that user; `actorName` snapshot taken now.
- In a request with no user → `anonymous` (should not happen — the proxy requires login; its presence
  signals a bug).
- Outside any request (startup jobs, migrator, recovery command, tests) → `system`.
- `actorIp` from the fixed `getClientIp(request)`; requires the request's headers from Next's context.

### Atomicity

The audit row is written in the same transaction as the change. Single operations outside a transaction
are wrapped in one; operations inside an interactive `$transaction` write the audit row through the same
transaction client.

**Unverified — the plan's first task is a spike** proving, on real SQLite inside a real route handler:
(1) `cookies()`/`headers()` are readable from inside the extension hook, including inside `$transaction`
callbacks; (2) the audit insert joins the caller's transaction (a rollback removes both). **If (2) is
impossible**, stop and return to the user with the trade-off (write after the change, failures logged
loudly) before building on it.

### Operations

| Operation | Behaviour |
|---|---|
| `create` | One CREATE with key fields |
| `update` | Read the row first; record only changed fields; no-op updates are not logged |
| `updateMany` / `deleteMany` | Read matching rows first; one entry per affected row |
| `delete` | Read the row (with `_count` of cascading children) first; DELETE snapshot incl. `_children` |
| `upsert` | CREATE or UPDATE depending on whether the row existed |
| nested creates | One CREATE on the parent; child data inside `changes` |

### Restore

Restore runs inside a "suppress row auditing" context (an explicit flag in the audit context, not a
second client), then writes one `RESTORE` event: actor, backup file name, per-model row counts.

### Security events

`recordEvent(tx | null, { action, entityType?, entityId?, entityLabel?, changes? })`, called in:
login (success and failure — failure records the typed username trimmed and lower-cased, and capped at 64 characters,
no actor), logout, invite created / redeemed, role changed, disabled / enabled, reset link issued,
password changed (self or via reset), direct-access toggled, backup created, restore.

## Client IP

`src/lib/server/client-ip.ts`: when `trustsForwardedHeaders()` is true, return the **last**
`X-Forwarded-For` value (ruling A8, same as the login throttle); otherwise return null. It never reads
`X-Real-IP` from an untrusted peer. Existing callers (document upload, image upload, image delete) are
updated to accept null.

## UI

- **`/admin/audit`** (admin only; plain users get the Admins-only page): newest first, 50 per page,
  "Load more" by time cursor. Row: when (browser-local via `formatTimestamp`), who, action, item label,
  one-line summary ("Deleted firearm *Glock 19 (9mm)* and 12 maintenance entries", "Changed *Glock 19*:
  status Active → Sold"). Expand → every changed field before/after; redacted fields show "changed".
  Filters: user (incl. disabled), action group (Creates / Edits / Deletes / Sign-ins / Security), item
  type, date range, item-name text search. Works at 390 px.
- **Item history** — admin-only "History" section on each item detail page listing that item's entries.
- **Sidebar** — "Audit log" link for admins, next to "Users".
- **CSV export** — admin only; everything matching the current filters. RFC 4180 escaping; any cell
  starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` (formula-injection guard).

## API

- `GET /api/admin/audit?cursor&user&action&type&from&to&q` → `{ events, nextCursor }` (admin only).
- `GET /api/admin/audit/export?…same filters` → `text/csv` attachment (admin only).
- `GET /api/admin/audit/item/:type/:id` → that item's events (admin only).

## Backups

`AuditEvent` joins `BACKUP_EXCLUDED_MODELS`; restore never touches it; the SQLite→PostgreSQL migrator
copies it (zero-loss rule, after `User`).

## Out of scope

- Tamper evidence (hash chains / signing) — the threat model accepts a host-level attacker.
- Showing history to non-admins.
- Undo / restore-from-audit.
- Auditing reads (who viewed what).

## Testing

Guards proven by injection.

- **Spike** (first): request context and transaction joining, real SQLite, real route.
- **Guard:** every model audited or excluded.
- **Per operation, real SQLite:** create / update (only changed fields; no-op not logged) / delete
  (snapshot + child counts) / updateMany / deleteMany / upsert / nested create; redaction in every path;
  rollback removes the audit row.
- **Append-only:** update/delete of `AuditEvent` through the app client throws.
- **Actor:** request by a user → that user; startup job → system; disabling the user later still shows
  the snapshot name.
- **Security events:** one test each; failed login with an unknown username.
- **Restore:** writes one RESTORE event, not per-row entries.
- **client-ip:** last XFF only when trusted; null otherwise; injection-proven.
- **CSV:** escaping and the formula-injection prefix.
- **Real image:** two users; the USER deletes a firearm; the ADMIN sees "… deleted firearm X", finds it by
  name, exports CSV; disable the USER — the entry still names them; upgrade from `develop` adds the
  table without touching data (SQLite and PostgreSQL).

## Acceptance criteria

1. Deleting an item as USER Jeff produces an entry naming Jeff, the item's label, and cascaded child counts.
2. Editing an item records only the fields that changed, before and after; serials appear only as "[redacted]".
3. Every security event in the list produces exactly one entry.
4. No app path can update or delete an audit entry; the backup contains no audit entries; restore leaves them intact and adds one RESTORE entry.
5. A new schema model without an audit decision fails the test suite.
6. Disabling or renaming a user does not change existing entries.
7. `/admin/audit` and item History are admin-only; filters and name search work; CSV export is formula-safe.
8. `actorIp` is null without trusted proxies and never the client-supplied first `X-Forwarded-For` value.
9. Upgrading from the current release adds the table without changing any inventory data (both providers).
