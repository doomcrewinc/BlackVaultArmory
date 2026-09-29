# Accounts, Sessions and Roles — Design Spec

**Date:** 2026-09-27
**Status:** Draft — awaiting review
**Epic:** Auth + encryption, step 2a (public URL ✅ → **accounts** → audit log (2b) → encryption at rest → phone photo capture)
**Builds on:** `docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md` (merged, `1a4fb8a`)

## Directive

> "the shared app password is gay as fuck. I want accounts. So if an item is removed, I can see 'Oh
> that asshole jeff did it' and assign blame."

BlackVault gets real user accounts for a household or NFA trust. This spec delivers identity,
login and roles. Attribution itself (the audit log) is spec 2b, which builds on the "current user"
this spec provides.

## Problem

- **There is no authentication at all.** `src/lib/server/auth.ts` is a stub: `requireAuth()`
  returns `null`, `hasValidSessionCookie()` returns `true`. 16 of 52 API routes call it; 51 write
  handlers exist; 8 server components query Prisma directly and call nothing.
- **Dormant, unsafe shared-password code** exists (`/api/session/unlock` compares a plaintext
  `AppSettings.appPassword` and stores the raw password as the cookie value). It is removed, not
  revived.
- **Direct access cannot be switched off** once an upgrade seeded it on (spec 1, ruling R9): the
  in-app toggle was deferred to this spec.
- **DNS rebinding** can reach the API while direct access is on, because nothing requires a
  session (spec 1 known limitation).

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | Two roles: `ADMIN`, `USER`. Fine-grained RBAC later | user |
| 2 | First account is admin; later accounts are users until an admin promotes them | user |
| 3 | First admin requires a one-time **setup token** printed to the container log and shown by the update scripts | user |
| 4 | Accounts are created by **invite link** (single-use, expiring); the invitee chooses their own username and password; the admin never knows it | user |
| 5 | Password reset = admin-issued single-use **reset link** (same mechanism) | follows from 4 |
| 6 | Lost-admin recovery = a command inside the container that prints a reset link | user |
| 7 | Sessions: DB-backed, **30-day sliding** | user |
| 8 | Username + password; no email/SMTP | user (confirmed assumption) |
| 9 | Admin-only: user management, the direct-access toggle, settings writes, backup/restore | user (confirmed assumption) |
| 10 | Users can do everything to inventory | user (confirmed assumption) |
| 11 | Admin-only **pages** opened by a plain user render a dedicated "Admins only" page naming the admins (served as HTTP 200 — Next does not carry a rewrite's status to the client; only the admin API returns 403) | user |
| 12 | Built in-repo (no auth library): `node:crypto` scrypt, own tables | approach A, user-approved |
| 13 | Users are never hard-deleted — "delete" means disable (2b needs "Jeff" to outlive Jeff's account) | design |
| 14 | Backups exclude auth tables; restore never touches them | design |

## Data model

One migration per provider (SQLite incremental; PostgreSQL its own timestamped folder — `0_init` is
frozen). Schema edits go in `prisma/schema.base.prisma` only.

**`User`**
- `id` cuid · `username` unique, stored lowercase, `^[a-z0-9._-]{3,32}$` · `displayName` 1–64 chars
- `passwordHash` — self-describing string `scrypt$N$r$p$<salt b64>$<hash b64>`, so parameters can be
  raised later and old hashes still verify (rehash on successful login when parameters are stale)
- `role` `ADMIN | USER` · `disabledAt DateTime?` · `createdAt` · `lastLoginAt DateTime?`

**`Session`**
- `id` · `userId` → `User` (cascade) · `tokenHash` unique — SHA-256 of a 32-byte random token; the
  cookie carries the raw token, the DB only the hash
- `createdAt` · `lastSeenAt` · `expiresAt` · `userAgent String?` (display only)

**`AuthToken`**
- `id` · `kind` `INVITE | RESET | SETUP` · `tokenHash` unique · `userId?` (RESET) · `role?` (INVITE)
- `createdById?` → `User` · `createdAt` · `expiresAt` · `usedAt DateTime?`
- Single-use: redemption is a conditional update `where usedAt IS NULL AND expiresAt > now`, so
  two concurrent redemptions cannot both succeed.
- Lifetimes: INVITE 7 days · RESET 24 hours · SETUP until used (at most one unused SETUP token
  exists; a fresh one replaces it at each start while no admin exists).

**Removed:** `AppSettings.appPassword` (column dropped), `/api/session/unlock`, `/api/session/logout`,
`src/components/auth/UnlockScreen.tsx`.

## Passwords

- scrypt via `node:crypto` — no native dependency (the image is Alpine). Parameters chosen so one
  verify takes ~50–100 ms on the maintainer's hardware; record the measured value in the plan.
- Minimum 12 characters, maximum 256; no composition rules (NIST SP 800-63B). Compared with
  `timingSafeEqual`.
- Password change requires the current password. Any password change or reset **ends all of that
  user's sessions** except, for a self-change, the current one.

## Request flow

`src/proxy.ts` keeps spec 1's host/origin decision first, then adds an authentication decision,
again as a pure function (`decideAuth`) with `proxy.ts` only gathering input.

**Always public:** `/api/health`, `/login`, `/setup`, `/invite/<token>`, `/reset/<token>`,
`/api/auth/*`, `/api/internal/gate-config`, and static build assets (`/_next/static/*`, favicon,
manifest).

| State | Page request | API request |
|---|---|---|
| No users exist | 307 → `/setup` | 503 `{ "error": "Setup required" }` |
| No / invalid / expired session, or user disabled | 307 → `/login?next=<path>` | 401 `{ "error": "Authentication required" }` |
| Valid session | pass | pass |

- `next` accepts only a same-origin path: must start with a single `/`, must not start with `//` or
  `/\`, no scheme. Anything else becomes `/`.
- **Current user:** `getCurrentUser()` re-validates the cookie against the DB (it never trusts a
  proxy-set header), memoised per request with React `cache()`. `requireUser()` / `requireAdmin()`
  build on it. The existing `requireAuth()` call sites are rewired to real checks.
- **Admin guard** on: user management, the direct-access toggle, `PUT /api/settings`, backup,
  restore. API → 403 `{ "error": "Admins only" }`; pages → the Admins-only page.
- **Cookie:** `bv_session`, httpOnly, SameSite=Lax, `Secure` via spec 1's `isSecureRequest`,
  Path=/, Max-Age 30 days. Login rotates to a fresh session (no fixation).
- **Sliding expiry:** `expiresAt` and `lastSeenAt` are extended at most once per hour per session,
  so SQLite is not written on every request.
- **Disable / reset takes effect on the next request** — every request re-validates against the DB.

## Login throttling

- The app cannot see real client addresses (the TCP gate pipes bytes; it adds no forwarding
  header). Throttling is therefore **per username**: after 5 consecutive failures, each further
  attempt must wait an exponentially growing delay capped at 15 minutes (`429` + `Retry-After`).
  Never a hard lockout — a lockout would let anyone lock the admin out.
- When `TRUSTED_PROXIES` is set, the first `X-Forwarded-For` address is also throttled per IP.
- In-memory (single process); resets on restart — acceptable.
- Responses are identical for "no such user", "wrong password" and "disabled", and the no-such-user
  path still runs a dummy scrypt so timing does not reveal which.

## Setup, first boot and upgrade

- While no admin exists, at startup (from `instrumentation.ts`, after the public-URL check) the app
  prints: `[auth] Setup token: XXXX-XXXX-XXXX-XXXX — create the first admin at <PUBLIC_URL>/setup`.
- `/setup` takes the token, username, display name and password (twice); creates the admin, logs
  them in, marks the token used. Once any admin exists, `/setup` returns 404.
- `update.sh` / `update.bat` print the setup-token line from the container log after starting.
  **For the release that introduces accounts, the update script users run is still the old one**
  (see memory `old-script-runs-on-upgrade`): the README and release notes must tell users to run
  `docker compose logs blackvault | grep "Setup token"` (Windows: the same with `findstr`).
- Upgraded installs show `/setup` until the admin exists. No inventory data changes.

## Admin recovery

`docker compose exec blackvault node scripts/admin-reset-link.mjs <username> [--promote]`

- Prints a one-time RESET link for that user (and with `--promote` also makes them `ADMIN` and
  clears `disabledAt`). Plain JS, no TypeScript step, like `gate/`.
- Anyone who can run it already has shell on the Docker host and therefore the database — no new
  attack surface.
- Documented in README Troubleshooting ("I'm the only admin and I forgot my password").

## UI

All pages use the dark `vault-*` design tokens and work at 390 px.

- **`/setup`**, **`/login`**, **`/invite/<token>`**, **`/reset/<token>`** — as above. An expired or
  used link renders a friendly "This link has expired or was already used — ask your admin for a
  new one", not an error page.
- **`/account`** (any user) — change display name and password; list own active sessions (device
  from user agent, last seen) with "end session"; "Log out everywhere".
- **`/admin/users`** (admin) — users with role, status, last login; **create invite** (choose role;
  shows the link with a QR code and Copy); **issue reset link**; promote/demote; disable/re-enable.
  The last active admin cannot be demoted or disabled (control disabled with the reason; the API
  enforces it too).
- **Admins-only page** — shield icon; heading "Restricted — admins only"; "You're signed in as
  **<displayName>**. This area is for administrators."; the display names of the current admins so
  the user knows whom to ask; a button back to the Command Center.
  **Amendment (ruling A11, verified in code — `src/app/admins-only/page.tsx`, `src/proxy.ts`):**
  this page is served as HTTP 200, not 403. `NextResponse.rewrite()`'s `status` option does not
  carry through to the client for a page rewrite — proven with curl: the response carries an
  `x-middleware-rewrite` header but the outer status is 200. Only the admin API
  (`/api/admin/*`) actually returns 403.
- **Navigation** — signed-in user and Log out; admin links hidden for plain users (cosmetic only —
  the server enforces).
- **Settings → Mobile Access** — the direct-access status becomes an admin-only **toggle**
  (`PUT /api/settings/direct-access`), showing spec 1's plain-HTTP warning before enabling. When
  `BLACKVAULT_ALLOW_DIRECT_ACCESS=true`, the toggle is locked with "Forced on by the server
  environment". Users see the status read-only. This closes spec 1 ruling R9.
- **Other admin Settings sections** (backup/restore, app settings) render read-only for users with
  an "Admins only" note — not the full-page treatment.

## Backup and restore

- Backups exclude `User`, `Session`, `AuthToken`; restore never deletes or writes them. Password
  hashes never leave the server in an export; restoring an old backup cannot delete today's
  accounts or lock anyone out.
- A test asserts those three models are absent from both the backup and restore model lists (the
  lists are hand-maintained — see the known maintenance-log backup bug).

## Out of scope

- Audit log / attribution (spec 2b).
- Two-factor auth, email, self-registration, fine-grained roles.
- SSO/OIDC (Authentik already runs on the maintainer's host — a candidate for a later spec).
- Per-user data visibility (everyone sees the whole household inventory).

## Risks to verify during planning (not assume)

1. **`/_next/image`** — if the image optimizer fetches uploaded images from the app's own URL
   without the cookie, thumbnails break under login enforcement.
2. **Server-side self-fetches** — the PDF export or any code calling the app's own URLs.
3. **Existing route tests** — handlers that gain `requireUser`/`requireAdmin` need their tests to
   supply a user.

## Testing

Guards are proven by injection.

- **Unit:** password hash/verify (round-trip, stored parameters honoured, stale-parameter rehash,
  timing-safe compare); token create/hash/redeem (single-use under concurrency, expiry); throttle
  (growth, cap, no lockout, identical responses); `next` sanitiser (`//evil.com`, `/\evil.com`,
  `https://evil.com`, `javascript:` → `/`).
- **`decideAuth` table test:** path kinds (public, page, API, static) × states (no users, logged
  out, valid, expired, disabled).
- **Routes:** setup (token required, works once, 404 after); login/logout/log-out-everywhere;
  invite and reset redemption; admin guards (403 for users); last-admin protection; direct-access
  toggle (admin-only; refused while env-forced).
- **Components:** Admins-only page lists admin names; nav hides admin links for users.
- **Backup:** auth models excluded from backup and restore.
- **Real run, built image:** starts, prints the setup token, redirects to `/setup`; create admin;
  invite a user in a second browser context; the user gets the Admins-only page on `/admin/users`;
  disabling the user ends their session on the next request; the recovery command prints a working
  reset link; thumbnails and the PDF export work with login enforced.

## Release notes

**Breaking:** BlackVault now requires an account. After updating, open `<PUBLIC_URL>/setup` and
create the first admin using the setup token from `docker compose logs blackvault | grep "Setup
token"`. Your inventory is unchanged. Other household members join by invite link from
Settings → Users.

## Acceptance criteria

1. A fresh or upgraded instance redirects every page to `/setup` and prints a setup token; API calls
   get 503.
2. `/setup` without the token fails; with it, creates an admin and logs them in; afterwards `/setup`
   is 404.
3. Logged out: pages → `/login?next=…`; API → 401. `next` never leads off-site.
4. An invite link creates a `USER` (or the chosen role) with the invitee's own credentials; it
   works once and expires after 7 days.
5. A plain user opening an admin page sees the Admins-only page naming the admins; admin API
   calls return 403. **Amendment (ruling A11, verified in code):** the page itself is served as
   HTTP 200 — Next does not carry a `NextResponse.rewrite()`'s `status` option through to the
   client for a page rewrite. 403 is real only for the admin API.
6. Disabling a user or resetting their password ends their sessions on the next request.
7. The last active admin cannot be demoted or disabled.
8. The recovery command prints a reset link that works.
9. Five wrong passwords slow further attempts for that username; the right password still works
   after the delay; no lockout.
10. An admin can turn direct access on and off from Settings; a user cannot; env-forced shows
    locked.
11. Backups contain no users, sessions or tokens; restoring one leaves accounts untouched.
12. No inventory data changes on upgrade; thumbnails and the PDF export work with login enforced.
