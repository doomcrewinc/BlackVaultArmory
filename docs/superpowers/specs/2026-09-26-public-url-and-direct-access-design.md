# Public URL, Origin Enforcement and Direct-Access Gate — Design Spec

**Date:** 2026-09-26
**Status:** Draft — awaiting review
**Epic:** Auth + encryption, step 1 of 4 (public URL → accounts → encryption at rest → phone photo capture)

## Directive

BlackVault runs behind a reverse proxy (Caddy Proxy Manager, Nginx Proxy Manager, …) that
terminates TLS. The trusted public address is configured once, by environment variable, and
everything that needs to know "where does this app live" reads it. Direct access to the
container's port — `http://<ip>:<port>`, bypassing the proxy — is a setting: when it is off, the
connection is reset, not merely redirected.

## Problem

1. **Nothing knows the public address.** The LAN banner and Settings QR code advertise
   `http://<lan-ip>:<port>` (`/api/network/local-access`), which bypasses the proxy and its TLS.
2. **No request is checked for origin.** There is no middleware, no server action, no CORS
   handling anywhere in `src/`. Any page on any site can POST to the API from a user's browser.
3. **The session cookie guesses its `secure` flag** from `NODE_ENV`
   (`src/lib/server/auth.ts:18`). Right behind an HTTPS proxy, wrong over plain HTTP, where a
   `Secure` cookie is silently discarded.
4. **The published port is open to the LAN.** Compose publishes `${PORT:-3000}:3000` on all
   interfaces. Any header-based check is bypassable, because a client writes its own headers.

Context: authentication is currently **stubbed** — `requireAuth()` is a no-op called from ~25
routes. Accounts are step 2 of this epic and a separate spec. This spec must not revive the
dormant shared-password code (`/api/session/unlock` compares plaintext and stores the raw password
as the cookie value).

## Decisions

| # | Decision | Source |
|---|---|---|
| 1 | Env var `BLACKVAULT_PUBLIC_URL`, a full origin including scheme | user |
| 2 | Exactly one value, not a list | user |
| 3 | Unset or invalid → the app refuses to start | user |
| 4 | Wrong host → **307** (non-permanent) redirect to the public URL | user |
| 5 | Accept `X-Forwarded-Host` when matching the host | user |
| 6 | Direct access is an **admin setting**, off by default on a new instance | user |
| 7 | Break-glass: real loopback always allowed, **and** `BLACKVAULT_ALLOW_DIRECT_ACCESS=true` forces it on | user |
| 8 | `update` asks whether to keep direct access, and seeds the setting from the answer | user |
| 9 | Direct access off → **connection reset by peer**, not an HTTP response | user |
| 10 | Direct access on → LAN banner + QR to the LAN URL; off → no banner, QR encodes the public URL | user |
| 11 | Fresh install with no trusted proxy → installer offers to allow direct access until the proxy exists | user (option a) |
| 12 | The toggle **UI** ships with accounts (spec 2), admin-only. This spec exposes status only | user |
| 13 | `/api/health` is exempt from the redirect | user |

**Accepted risk (user decision):** on a single Docker host where the proxy reaches BlackVault by
dialing the host's own IP and published port (the maintainer's topology), every connection from
that host arrives from the same masqueraded address. "Trusted proxy" then means "anything on this
host". Accepted: the host is fully controlled and firewalled.

## Configuration

| Host `.env` | Container env | Meaning |
|---|---|---|
| `BLACKVAULT_PUBLIC_URL` | `PUBLIC_URL` | **Required.** e.g. `https://vault.example.com` |
| `BLACKVAULT_TRUSTED_PROXIES` | `TRUSTED_PROXIES` | Comma-separated IPs, CIDRs and host names |
| `BLACKVAULT_ALLOW_DIRECT_ACCESS` | `ALLOW_DIRECT_ACCESS` | Break-glass. Only the exact value `true` has effect |
| `BLACKVAULT_DIRECT_ACCESS_INITIAL` | `DIRECT_ACCESS_INITIAL` | One-time seed written by the installers: `on` / `off` |

`BLACKVAULT_` prefix per the repo rule (shell-exported generic names override `.env` in Compose).
Compose interpolates with `${VAR:-}`, never `${VAR:?}`: the app produces the error, with a better
message.

### Public URL rules — `src/lib/server/public-url.ts`

- Scheme `http` or `https`.
- No path (a lone trailing `/` is allowed), no query, no fragment, no userinfo. Hosting under a
  sub-path is unsupported: Next's `basePath` is fixed at build time.
- Normalised: host lowercased, default port dropped. `https://Vault.Example.com:443/` →
  `https://vault.example.com`.
- Failure throws an error naming `BLACKVAULT_PUBLIC_URL` with a valid example.

### Refusing to start

- `src/instrumentation.ts` validates it and calls `process.exit(1)` on failure. In the container
  the gate loads Next in the same process, so this exits the gate too; the gate itself does not
  duplicate the parser (it is plain JS and cannot import the TypeScript module). This check
  sits **outside** the existing never-throw blocks, which exist so a failed migration cannot block
  startup — this one is meant to.
- `next build` must NOT require the variable (CI builds images without it).
- Must be proven by running: unset the variable, start, observe a non-zero exit and the message.

### Stored setting

`AppSettings.allowDirectAccess Boolean?` — new nullable column, one migration per provider.
PostgreSQL `0_init` is frozen: this is its own timestamped migration.

- `null` = never decided. On the first boot that finds `null`: `DIRECT_ACCESS_INITIAL=on` →
  `true`, anything else → `false`. A fresh install has no seed, so it lands on **off**.
- Once non-null, the seed is ignored; the setting belongs to the UI (spec 2).

**Effective direct access** = `ALLOW_DIRECT_ACCESS === "true"` OR the stored value. Read through a
cache with a 5-second TTL. On a DB read failure use the last known value; with none, treat as off
(loopback still works, so this cannot lock out the host's own checks).

### Dev

`dev.sh` writes `PUBLIC_URL=http://localhost:$PORT` into a new dev `.env`, and appends it to an
existing dev `.env` that lacks it. A request to `localhost:<port>` matches its own public URL and
never redirects.

## Architecture

Two layers. The outer one decides **whether a connection may exist**; the inner one decides
**what an allowed request may do**.

```
client ──TCP──> gate :3000 ──pipe──> next start 127.0.0.1:3001 ──> proxy.ts ──> routes
                  │                                                  │
          reset if untrusted                         redirect / 403 / pass
```

### Layer 1 — the TCP gate

Rejected alternatives: `proxy.ts` alone (no socket access; it cannot see the peer IP or reset a
connection, and headers are forgeable); a custom Next server (loses the `standalone` output the
Dockerfile ships, `Dockerfile:58`).

- **Container only.** The gate sets `PORT=3001`, `HOSTNAME=127.0.0.1`, loads Next's standalone
  `server.js` in the same process, and listens on `:3000`. The Dockerfile `CMD` runs the gate
  where it ran `server.js`; migrations still run first. `npm run dev` has no gate.
- **Per connection:**
  1. Normalise the peer address: strip the IPv4-mapped prefix (`::ffff:10.10.10.5` →
     `10.10.10.5`). Without this every IPv4 rule silently fails to match on a dual-stack socket.
  2. **Pass** if the peer is real loopback, OR matches `TRUSTED_PROXIES`, OR effective direct
     access is on.
  3. Otherwise `socket.resetAndDestroy()` (the client sees ECONNRESET) and log
     `[gate] rejected <ip> (not a trusted proxy; direct access off)`, rate-limited per IP. This
     log is how an operator discovers which address their proxy arrives from.
  4. A passed connection is piped byte-for-byte to `127.0.0.1:3001`. The gate never parses HTTP.
- **`TRUSTED_PROXIES`:** IPs and CIDRs matched directly; host names resolved at start and every
  30 s, keeping the last good result on failure. Empty list with direct access off → startup
  warning "all non-loopback connections will be reset", and the gate still runs.
- **Toggle:** the gate polls `GET http://127.0.0.1:3001/api/internal/gate-config` every 5 s. The
  route returns only `{ allowDirectAccess: boolean }` via the shared cached reader, so the gate
  has no Prisma dependency. The route is reachable by any peer the gate passes; it exposes that
  one boolean and nothing else, which is acceptable. The gate's own poll arrives with
  `Host: 127.0.0.1`, which the request gate passes as loopback. When effective direct access flips to **off**, the gate destroys
  open connections from untrusted peers — a keep-alive socket must not outlive the setting.
- **Docker Desktop:** detected (`host.docker.internal` resolves). Logs a warning that peer
  addresses are unreliable there. Warning only; behaviour unchanged.
- **Caveat, documented:** inside Docker, a browser on the host opening `localhost:<port>` arrives
  from the bridge gateway, not loopback. Real-loopback exemption therefore covers the container's
  own healthcheck; the operator's break-glass is `BLACKVAULT_ALLOW_DIRECT_ACCESS=true` + restart.

### Layer 2 — the request gate, `proxy.ts`

Next 16 `proxy.ts` always runs on Node.js (verified against the Next.js docs), so it can use the
cached settings reader. The logic lives in a pure function in `src/lib/server/request-gate.ts`:
`decideRequest(input) → pass | redirect(location) | forbidden(reason)`; `proxy.ts` only gathers
input and applies the result.

1. `pathname === "/api/health"` → pass.
2. **Effective host** = first value of `X-Forwarded-Host` if forwarded headers are trusted, else
   `Host`. Compared including port.
3. Host equals the public URL's host → pass. Host is `localhost`, `127.0.0.1` or `[::1]` → pass.
   Effective direct access on → pass. Otherwise → **307** to `PUBLIC_URL` + original path and
   query.
4. **Origin check**, POST/PUT/PATCH/DELETE only, on requests that passed step 3:
   - no `Origin` header → pass (not a browser; browsers always send it cross-site);
   - `Origin` equals `PUBLIC_URL` → pass;
   - `Origin` equals the request's own origin (loopback or direct access) → pass;
   - anything else, including `Origin: null` → **403** JSON
     `{ "error": "Cross-origin request rejected" }`. Only API routes accept writes, so JSON is
     always the right shape.
5. **No CORS headers are ever emitted.**

**Trusting `X-Forwarded-*`:** only when `TRUSTED_PROXIES` is non-empty. With direct access off,
only trusted peers reach Next, so the headers are genuine by construction. With it on, an
untrusted peer could forge them, and the only effect is on its own redirect or cookie flag. A
forged `X-Forwarded-Host` cannot redirect anyone elsewhere: the target is always `PUBLIC_URL`.

### Session cookie

`getSessionCookieOptions(request)` sets `secure` when the request is HTTPS — the first
`X-Forwarded-Proto` value when forwarded headers are trusted, otherwise the request URL's scheme.
The helper is dormant today; this spec fixes its signature and its callers so accounts inherit a
correct one.

## UI

No toggle in this spec.

- `/api/network/local-access` additionally returns `publicUrl` and
  `directAccess: { allowed: boolean, source: "setting" | "env" }`.
- **Settings → Mobile Access**
  - Direct access **on**: current behaviour (LAN URL, manual host field, QR of the LAN URL), plus:
    > ⚠️ Direct access is on. Anyone on your network can reach BlackVault at
    > `http://<ip>:<port>` without HTTPS. Logins over that address are sent unencrypted.
  - Direct access **off**: shows the public URL; QR encodes `PUBLIC_URL`; manual host field
    hidden.
  - Both: read-only status, "Direct access: Off (setting)" / "On (forced by
    BLACKVAULT_ALLOW_DIRECT_ACCESS)", with how to change it.
- **`LanBanner`**: rendered only when direct access is on. Its existing localhost suppression
  stays.

## Installers

`.sh` and `.bat` change in lockstep. `.env` edits touch only their own keys and leave a `.env.bak`,
following the existing `DATA_DIR` edit in `update.sh`.

**`install.sh` / `install.bat`** (fresh instance):
1. Public URL — required, re-prompted until the shape is valid (the app remains the authority).
2. Trusted proxies — optional.
3. If trusted proxies was left blank: warn that every connection will be reset until a proxy is
   configured, and ask **"Allow direct access until your proxy is set up? [Y/n]"**. Yes → write
   `BLACKVAULT_DIRECT_ACCESS_INITIAL=on`.
4. The closing message prints the public URL, not `http://localhost:$PORT`.

**`update.sh` / `update.bat`** (existing instance):
1. `BLACKVAULT_PUBLIC_URL` set → "Public URL is `X` — still current? [Y/n]"; unset → prompt.
2. `.env` has no `BLACKVAULT_DIRECT_ACCESS_INITIAL` line (first upgrade only) → **"Keep allowing
   direct access by IP? [Y/n]"**, default yes. Write `on` / `off`.
3. `BLACKVAULT_TRUSTED_PROXIES` absent → prompt (optional).

## Out of scope

- The direct-access toggle UI, admin role, accounts, setup token — spec 2.
- Audit log, encryption at rest, photo capture — later specs.
- Changing the published-port binding in `docker-compose.yml`.
- Multiple public URLs.

## Testing

Guards are proven by injection: break each one, watch its named test fail, restore.

- **Unit:** public-URL parsing (every rejection rule + normalisation); `decideRequest` (every
  branch, including `Origin: null` and forwarded-header trust on/off); peer matching (IPv4-mapped
  normalisation, CIDR edges, host-name resolution failure keeps last good).
- **Gate, real sockets:** start the gate on an ephemeral port with a stub upstream; an untrusted
  peer must observe **ECONNRESET** (not merely a close); a trusted peer reaches the stub; flipping
  the toggle off destroys an open keep-alive connection.
- **Startup:** missing / invalid `PUBLIC_URL` → non-zero exit with the message, both with the gate
  and under `next start`. `next build` succeeds without it.
- **Windows CI job:** assertions for the new `install.bat` / `update.bat` prompts and `.env`
  writes.
- **Built image, run — not a green build:** `docker compose up` with direct access off; `curl`
  from an untrusted address gets a reset; healthcheck stays healthy; with
  `BLACKVAULT_ALLOW_DIRECT_ACCESS=true` the same `curl` gets a page.

## Release notes

**Breaking:** `BLACKVAULT_PUBLIC_URL` is now required; the container will not start without it.
For this update, run `git pull` first and then `./update.sh` (or `update.bat`), which prompts
for it: the `update.sh` users already have keeps running its old copy after pulling. Existing installs keep direct access by
default when upgraded through the update script.

## Acceptance criteria

1. Container without `BLACKVAULT_PUBLIC_URL` exits non-zero with a message naming the variable.
2. Direct access off: a connection from an untrusted peer is reset; the healthcheck passes; a
   trusted peer with the public host is served.
3. Direct access on: `http://<ip>:<port>` is served; the Settings warning and the LAN banner show.
4. A wrong host from a trusted peer gets a 307 to `PUBLIC_URL` with path and query preserved.
5. A cross-origin POST gets 403; a same-origin POST and an Origin-less POST pass.
6. No response carries an `Access-Control-Allow-*` header.
7. Fresh install with blank trusted proxies and "yes" to the prompt is reachable by IP on first
   start; with "no" it is not.
8. Upgrade via `update.sh` / `update.bat` with default answers keeps the instance reachable exactly
   as before.
