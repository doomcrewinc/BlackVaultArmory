# BlackVault

A self-hosted, local-only web app for tracking firearms, accessories, and range sessions. All data stays on your machine.

---

## Screenshots

![Dashboard](docs/screenshots/dashboard.png)
![Vault](docs/screenshots/vault.png)
![Range Session](docs/screenshots/range.png)
![Settings](docs/screenshots/settings.png)

---

## Features

- Firearm and accessory tracking
- Document uploads
- Range sessions and drills
- Drill library and history
- Drill logging (standalone or tied to a session)
- Drill performance tracking
- CSV and PDF export
- Dashboard
- Mobile access via local network
- Serial numbers and NFA paperwork encrypted at rest

---

## Before You Start

**The only thing you need to install is Docker Desktop.** It's free.

| Platform | Download Link |
|----------|--------------|
| 🪟 Windows | [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) |
| 🍎 Mac | [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) |
| 🐧 Linux | [Docker Engine install guide](https://docs.docker.com/engine/install/) |

After installing, **open Docker Desktop and wait for it to fully load** before continuing.
You'll know it's ready when the whale 🐳 icon appears in your system tray (Windows) or menu bar (Mac).

**BlackVault needs Docker Compose v2.20 or newer** (run as `docker compose`, with a space). Any
current Docker Desktop has it. Check with:

```bash
docker compose version
```

On Linux without Docker Desktop, install or update the `docker-compose-plugin` package
([guide](https://docs.docker.com/compose/install/linux/)). The old standalone `docker-compose`
(v1) is not supported. The installer and `update.sh` / `update.bat` check this first and stop,
changing nothing, if Compose is missing or too old.

> ⚠️ **Updating an older install on older Compose:** the copy of `update.sh` / `update.bat` you
> already have predates this check. If your Compose is older than v2.20, that first update fails
> loudly at the rebuild step (`docker compose` cannot read the new `docker-compose.yml`). Your
> BlackVault keeps running on the old version and your data is untouched. Upgrade Docker Compose,
> then run the update again.

> ⚠️ **Windows users:** Use `install.bat` — do **not** run `install.sh` and do **not** install Git Bash.
> `install.bat` is the Windows version and does the exact same thing.

---

## Installation — Windows 🪟

### Step 1 — Download BlackVault

Go to the [BlackVault GitHub page](https://github.com/doomcrewinc/BlackVaultArmory), click **Code → Download ZIP**, and save it somewhere you'll find it (e.g. your Desktop).

### Step 2 — Extract the ZIP

Right-click the downloaded ZIP and choose **Extract All**. Extract it to a folder like `C:\BlackVault`.

### Step 3 — Run the installer

Open the extracted folder and **double-click `install.bat`**.

> 💡 If it flashes and closes, open **Command Prompt** and run:
> ```cmd
> cd C:\path\to\BlackVaultArmory
> ```
> Then:
> ```cmd
> install.bat
> ```

The installer will ask three questions — press **Enter** to accept the defaults:
- Where to store your data → press Enter
- Which port to use → press Enter
- Which database to use → press Enter for **PostgreSQL** (recommended), or type `2` for SQLite

It will then ask for your **public URL** and **trusted proxies**. If you're just trying
BlackVault on your own network with no reverse proxy yet, answer:
- Public URL → `http://localhost:3000` (or `http://localhost:<your port>`)
- Trusted proxies → press Enter to leave blank, then answer **yes** when asked to allow
  direct access

See **[Running behind a reverse proxy](#running-behind-a-reverse-proxy)** below if you're
putting BlackVault behind nginx, Caddy, Traefik or similar.

> ⚠️ PostgreSQL on Windows has not been tested yet. See
> [Known issue: PostgreSQL on Windows](#known-issue-postgresql-on-windows-is-untested). If you
> want the proven option on Windows, type `2` for SQLite.

For PostgreSQL the installer generates a random database password and saves it in `.env`
(it is never shown). **Keep `.env` safe** — your database cannot be opened without it.

It will then build and start BlackVault. **This can take 5–10 minutes the first time.**

### Step 4 — Open BlackVault

When the installer finishes, open your browser and go to:

```
http://localhost:3000
```

✅ **BlackVault is running.**

---

## Installation — Mac 🍎

### Step 1 — Open Terminal

Press `Cmd + Space`, type `Terminal`, and press Enter.

### Step 2 — Download BlackVault

Copy this command, paste it into Terminal, and press Enter:

```bash
git clone https://github.com/doomcrewinc/BlackVaultArmory.git
```

### Step 3 — Go into the folder

```bash
cd BlackVaultArmory
```

### Step 4 — Run the installer

```bash
chmod +x install.sh && ./install.sh
```

The installer will ask three questions — press **Enter** to accept the defaults:
- Where to store your data → press Enter
- Which port to use → press Enter
- Which database to use → press Enter for **PostgreSQL** (recommended), or type `2` for SQLite

It will then ask for your **public URL** and **trusted proxies**. If you're just trying
BlackVault on your own network with no reverse proxy yet, answer:
- Public URL → `http://localhost:3000` (or `http://localhost:<your port>`)
- Trusted proxies → press Enter to leave blank, then answer **yes** when asked to allow
  direct access

See **[Running behind a reverse proxy](#running-behind-a-reverse-proxy)** below if you're
putting BlackVault behind nginx, Caddy, Traefik or similar.

For PostgreSQL the installer generates a random database password and saves it in `.env`
(it is never shown). **Keep `.env` safe** — your database cannot be opened without it.

It will then build and start BlackVault. **This can take 5–10 minutes the first time.**

### Step 5 — Open BlackVault

When the installer finishes, open your browser and go to:

```
http://localhost:3000
```

✅ **BlackVault is running.**

> 💡 **Don't have Git?** Go to the [GitHub page](https://github.com/doomcrewinc/BlackVaultArmory), click **Code → Download ZIP**, extract it, open Terminal in that folder, then start from Step 4.

---

## Installation — Linux 🐧

### Step 1 — Open a terminal

### Step 2 — Download BlackVault

```bash
git clone https://github.com/doomcrewinc/BlackVaultArmory.git
```

### Step 3 — Go into the folder

```bash
cd BlackVaultArmory
```

### Step 4 — Run the installer

```bash
chmod +x install.sh && ./install.sh
```

The installer will ask three questions — press **Enter** to accept the defaults:
- Where to store your data → press Enter
- Which port to use → press Enter
- Which database to use → press Enter for **PostgreSQL** (recommended), or type `2` for SQLite

It will then ask for your **public URL** and **trusted proxies**. If you're just trying
BlackVault on your own network with no reverse proxy yet, answer:
- Public URL → `http://localhost:3000` (or `http://localhost:<your port>`)
- Trusted proxies → press Enter to leave blank, then answer **yes** when asked to allow
  direct access

See **[Running behind a reverse proxy](#running-behind-a-reverse-proxy)** below if you're
putting BlackVault behind nginx, Caddy, Traefik or similar.

For PostgreSQL the installer generates a random database password and saves it in `.env`
(it is never shown). **Keep `.env` safe** — your database cannot be opened without it.

It will then build and start BlackVault. **This can take 5–10 minutes the first time.**

### Step 5 — Open BlackVault

```
http://localhost:3000
```

✅ **BlackVault is running.**

---

## Stopping and Starting BlackVault

The same commands work for both databases. Run them from the BlackVault folder.

> 💡 **Which database am I using?** Look in `.env`. `COMPOSE_PROFILES=postgres` with
> `BLACKVAULT_DB_PROVIDER=postgres` is PostgreSQL. No `COMPOSE_PROFILES` line (installs made before
> PostgreSQL support, or SQLite chosen at install) is SQLite. Docker reads `.env` itself, so
> plain `docker compose` always starts the right one.

**To stop BlackVault** (your data is never affected):

```bash
docker compose down
```

**To start it again after stopping:**

```bash
docker compose up -d
```

**To update to the latest version:**

Windows — double-click `update.bat`

Mac / Linux:

```bash
./update.sh
```

Updating to the release that made `BLACKVAULT_PUBLIC_URL` required? Run `git pull` first, then
the update script — see [Updating without losing data](#updating-without-losing-data).

---

## Troubleshooting

### 🟡 `docker compose ps` says the container is `unhealthy`

BlackVault reports itself unhealthy when its database does not answer, because the app cannot
work without it. Ask the app directly:

```bash
curl -s http://127.0.0.1:3000/api/health
```

`{"status":"ok","database":"ok",...}` means everything is up. `{"status":"error","database":
"unreachable",...}` (HTTP 503) means the app is running but cannot reach its database. On
PostgreSQL, check that the database container is up (`docker compose ps`) and see why it is not:

```bash
docker compose logs db
```

The reason the app could not connect is in its own log, with the details omitted from the
response above:

```bash
docker compose logs blackvault
```

The container returns to `healthy` on its own within about 30 seconds of the database coming
back — no restart needed.

---

### ❌ Container exits immediately / keeps restarting

Check the log:

```bash
docker compose logs blackvault
```

If it ends with `[startup] BLACKVAULT_PUBLIC_URL is not set...`, `.env` is missing the
public URL that's now required (see **Running behind a reverse proxy** above). Run
`./update.sh` (or double-click `update.bat` on Windows) — it will ask for it and add it to
`.env`. This is also what you see if your first update to this release ran your old
`update.sh` without a `git pull` first: that update already pulled the new script, so running
`./update.sh` again asks for the URL and brings BlackVault back. Re-running `install.sh` / `install.bat` on an existing install won't help here: it
sees your existing `.env` and says "already configured" without prompting for anything.

---

### ❌ Connection reset / `curl: (56)`

If BlackVault (or your reverse proxy talking to it) gets `curl: (56) Connection reset by
peer` — or, through Docker Desktop / OrbStack's port forwarder, `curl: (52) Empty reply`
— direct access is off and the address you're connecting from isn't in
`BLACKVAULT_TRUSTED_PROXIES`. See **Trusted proxies** under
**Running behind a reverse proxy** above for how to find the right address to add, or use
the break-glass `BLACKVAULT_ALLOW_DIRECT_ACCESS=true` if you just need it working now.

### ❌ Error: "unable to open database file"

This is the most common issue on first launch. It means Docker couldn't create the data folders automatically. Fix it by creating them manually, then restarting.

**Windows — open Command Prompt in the project folder and run these one at a time:**

```cmd
mkdir data\db
```

```cmd
mkdir data\uploads
```

```cmd
docker compose down
```

```cmd
docker compose up -d
```

**Mac / Linux — run these one at a time in Terminal:**

```bash
mkdir -p ./data/db ./data/uploads
docker compose down
docker compose up -d
```

**If the error still appears, check these:**

- Open the `.env` file in the project folder (any text editor). It should contain:
  ```
  DATA_DIR=./data
  PORT=3000
  ```
  If it's missing or blank, paste those two lines in and save.

- **Windows only:** Open Docker Desktop → **Settings → Resources → File Sharing** → make sure the drive your project is on (usually `C:`) is checked → click **Apply & Restart**, then try again.

- **Linux only:** Run this to fix folder permissions:
  ```bash
  sudo chown -R 1001:1001 ./data/db ./data/uploads
  ```
  Do **not** run it on the whole `./data` folder: `data/postgres` belongs to the PostgreSQL
  container, and PostgreSQL refuses to start if it is re-owned.

---

### ❌ Windows: `install.sh` won't run / told to install Git Bash

`install.sh` is a Mac/Linux script — it does not work on Windows natively. **Use `install.bat` instead.**

1. Open the project folder in File Explorer
2. Double-click `install.bat`

You do not need Git Bash or WSL. `install.bat` does the exact same thing.

---

### ❌ "Docker is not recognized" / Docker not found

Docker Desktop must be **open and running** before any Docker command will work.

1. Open Docker Desktop from your Start Menu or Applications folder
2. Wait until the whale 🐳 icon appears in your system tray (Windows) or menu bar (Mac)
3. Re-run the installer

---

### ❌ Port 3000 is already in use

Open the `.env` file in the project folder in any text editor. Find this line:

```
PORT=3000
```

Change it to:

```
PORT=3001
```

Save the file, then run:

```bash
docker compose down
docker compose up -d
```

---

### ❌ App loads but shows no data after updating

**Nothing is lost.** If you installed BlackVault before PostgreSQL support (or chose SQLite), your
data is in `data/db/vault.db`. If `.env` was switched to PostgreSQL by hand (for example by adding
`COMPOSE_PROFILES=postgres` or `BLACKVAULT_DB_PROVIDER=postgres`) without running the migration, BlackVault
starts on a **new, empty PostgreSQL database** instead. `vault.db` is not touched.

BlackVault checks for exactly this at startup. The container log (`docker compose logs blackvault`)
shows a `WARNING: BlackVault is running on PostgreSQL, but a SQLite database with data exists`
banner when **all three** are true: it is running on PostgreSQL, `vault.db` exists and is not empty,
and there is no `data/db/.migrated` file. The migration tool writes `.migrated` only after a
verified copy, so a correctly migrated install never shows the banner. Its `vault.db` is the
rollback copy.

To get back to your data:

1. Stop BlackVault:
   ```bash
   docker compose down
   ```
2. Open `.env`. Delete the `COMPOSE_PROFILES=postgres`, `BLACKVAULT_DB_PROVIDER=postgres` and
   `BLACKVAULT_DATABASE_URL=postgresql://...` lines (or set `BLACKVAULT_DB_PROVIDER=sqlite` and
   remove the other two). `BLACKVAULT_POSTGRES_PASSWORD` can stay.
3. Start BlackVault on SQLite:
   ```bash
   docker compose up -d --remove-orphans
   ```

Your records are back. The empty `data/postgres` folder can be left alone or deleted. To move to
PostgreSQL for real, follow **"Moving from SQLite to PostgreSQL"** below.

---

### ❌ The app loads but shows no data / database looks empty

Your data is still there — BlackVault is probably pointing at a different folder. **Do not reinstall.**

See **"If two data directories exist"** in the Data & Backups section below.

---

### ❌ App won't load after starting

Check the logs for a specific error message:

```bash
docker compose logs -f
```

Still stuck? Open a [GitHub issue](https://github.com/doomcrewinc/BlackVaultArmory/issues) and paste the log output.

---

### 🔑 I'm the only admin and I forgot my password

Run this inside the container (see **[Users and sign-in](#users-and-sign-in)** below for
details):

```bash
docker compose exec -u nextjs blackvault node scripts/admin-reset-link.mjs <username>
```

It prints a one-time password reset link, valid 24 hours. If that admin account was disabled
or demoted, add `--promote` to also restore admin access:

```bash
docker compose exec -u nextjs blackvault node scripts/admin-reset-link.mjs <username> --promote
```

---

### 🔑 Where is the setup token?

```bash
docker compose logs blackvault | grep "Setup token"
```

Windows:

```cmd
docker compose logs blackvault | findstr /c:"Setup token"
```

This only prints something while no admin account exists yet — once the first admin is
created, `/setup` stops working and no more tokens are logged.

---

### Known issue: PostgreSQL on Windows is untested

The PostgreSQL database keeps its files in `data\postgres`, a folder on your Windows drive that
Docker Desktop shares into the database container. This has **not been tested yet**. PostgreSQL is
strict about who owns its data folder and how files are flushed to disk, and Windows folders shared
into Linux containers do not always behave the way it expects. Possible symptoms:
`blackvault-db` keeps restarting, or its log (`docker compose logs db`) mentions *permissions*,
*ownership* or *could not fsync*.

If you see that, or you just want the proven option on Windows, use SQLite: delete `.env` and the
empty `data\postgres` folder, run `install.bat` again, and type `2` at the database question.
SQLite on Windows works the way it always has. Please report what you see in a
[GitHub issue](https://github.com/doomcrewinc/BlackVaultArmory/issues).

---

### Known limitation: searching for `%` or `_` on SQLite

On the SQLite database, a search term containing `%` or `_` in the global search and in the kit
item picker may show a few extra near-matches (for example `AB_12` also finds `AB-12`), and a term
made only of those characters matches everything. The audit log search is exact on both databases.
PostgreSQL matches `%` and `_` literally everywhere.

---

## Users and sign-in

BlackVault requires an account. The first time you open it — a fresh install, or right after
updating to the release that added this — every page sends you to `/setup` to create the
first admin.

### Finding your setup token

`install.sh` / `install.bat` and `update.sh` / `update.bat` print it automatically in a boxed
block once the container is healthy. If you need it again, get it straight from the
container log:

```bash
docker compose logs blackvault | grep "Setup token"
```

Windows:

```cmd
docker compose logs blackvault | findstr /c:"Setup token"
```

Then open `<your public URL>/setup` (e.g. `http://localhost:3000/setup`), enter the token,
and choose a username and password — you're the first admin. A fresh token is printed every
time BlackVault starts while no admin exists yet, so only the most recent line in the log is
valid. Once an admin exists, `/setup` returns 404 and no more tokens are printed.

> 💡 Re-running `install.sh` / `install.bat` on an existing install won't show you the token —
> it sees your `.env` already exists and changes nothing. Use the log command above instead.

### Inviting people

Admins invite other household members from **Users** in the sidebar (`/admin/users`) →
**Invite someone**. You get a link and a QR code that work once and expire after 7 days. The
person who opens it picks their own username and password — you never see or choose it for
them. Pick their role when you create the invite:

- **Admin** — manages users, settings, backup/restore, and the Mobile Access switch below.
- **User** — full access to the inventory (firearms, accessories, range sessions, exports),
  but the admin-only areas are off limits.

A plain user who opens an admin-only page sees a "Restricted — admins only" page naming the
current admins, so they know who to ask.

### Resetting a forgotten password

An admin issues a one-time password reset link for anyone from **Users** in the sidebar, the
same way as an invite. It expires after 24 hours.

### Your account

Every signed-in user has an **/account** page: change your display name and password, see
your active sessions (device and last-seen time) with a button to end any of them, or log out
everywhere at once.

### Audit log

Every create, edit and delete of inventory (firearms, accessories, ammo, gear, supplies, kits,
builds, documents, maintenance and battery logs, range sessions, drills, round-count logs) and
app settings, plus security events (sign-ins, invites, role changes, enable/disable, password
resets, the direct-access toggle, backups, restores), is recorded permanently — admin only, from
**Audit log** in the sidebar (`/admin/audit`, next to **Users**) or the **History** section on
any item's own detail page. Filter by user, action, item type and date, search by item name, and
export the current filter as CSV.

Entries are kept forever: nothing in the app can edit or delete one, not even an admin, and
disabling or renaming a user afterward does not change what an existing entry says they did.
Serial numbers, password hashes, token hashes and API keys are never stored in an entry — an
entry shows "[redacted]" instead.

The audit log is **not** included in a backup, and restoring one leaves existing entries
untouched — a restore adds a single new entry (who restored it and how many rows per table)
rather than one entry per restored row.

### Mobile Access is now an admin-only switch

Settings → **Mobile Access (Local Network)** has an on/off switch for direct access, with a
confirmation step either way and a plain-HTTP warning before turning it on. Only admins can
change it; a plain user sees the same section read-only. See **Mobile Access (Same Network)**
below for what direct access does.

### Recovery: locked out as the only admin

If the only admin forgets their password, or their account gets disabled or demoted somehow,
run this inside the container:

```bash
docker compose exec -u nextjs blackvault node scripts/admin-reset-link.mjs <username>
```

It prints a one-time reset link, valid 24 hours. Add `--promote` to also make that user an
active admin again (clearing any disabled state):

```bash
docker compose exec -u nextjs blackvault node scripts/admin-reset-link.mjs <username> --promote
```

Anyone who can run this already has shell on the Docker host, and therefore the database — it
doesn't open up anything that wasn't already reachable.

---

## Mobile Access (Same Network)

You can open BlackVault on your phone as long as it's on the same Wi-Fi as your computer —
**if direct access is on.** This is a stored setting, off by default from a fresh install.
`install.sh` / `install.bat` ask about it on a fresh install, and `update.sh` / `update.bat`
ask once, on the first update to this release; after that, re-running them does not change
it. To force it **on** regardless of the stored setting, set `BLACKVAULT_ALLOW_DIRECT_ACCESS=true`
in `.env` and restart (`docker compose up -d`). Admins can also turn it on or off from Settings
→ **Mobile Access (Local Network)** (see **Users and sign-in** above) — the switch is locked
when `BLACKVAULT_ALLOW_DIRECT_ACCESS` forces it on. Settings → **Mobile Access (Local
Network)** always shows whether it's on or off.

1. Open BlackVault in your browser and go to **Settings**
2. Look at **Mobile Access (Local Network)** — it shows a QR code and, below it, whether
   direct access is on or off
3. Scan the QR code with your phone

**With direct access on,** the QR code and the Mobile URL box open
`http://<your computer's IP>:<port>` — the Settings page detects your local IP for you.

**With direct access off** (the default), every non-proxy connection is reset, so the QR
code instead opens your **public URL** (`BLACKVAULT_PUBLIC_URL`). Put BlackVault behind a
reverse proxy for it to work from your phone in this mode; see **Running behind a reverse
proxy** below, including the warning about who should be able to reach that address.

To enter a LAN address manually (direct access on): run `ipconfig` on Windows or `ip addr`
on Mac/Linux to find your IP, then open `http://YOUR_IP:3000` on your phone.

---

## Running behind a reverse proxy

> ⚠️ **A reverse proxy gives you HTTPS, not a second login.** BlackVault has user accounts,
> but no two-factor authentication — anyone who can reach the proxy's address can attempt to
> sign in. Only make it reachable from networks you trust (your home network or a VPN), or
> put an authenticating proxy / IP allowlist in front of it as well. Do not expose it to the
> open internet. See [Notes](#notes).

BlackVault requires a **public URL** — the one address people use to reach it, normally
your reverse proxy's HTTPS address (e.g. `https://vault.example.com`). Set it as
`BLACKVAULT_PUBLIC_URL` in `.env`; `install.sh` / `install.bat` and `update.sh` /
`update.bat` prompt for it. Without it, the container logs
`[startup] BLACKVAULT_PUBLIC_URL is not set...` and exits — it will not start.

A request for the wrong host gets redirected to your public URL; a cross-origin write
(a `POST`/`PUT`/`PATCH`/`DELETE` whose origin doesn't match) is rejected with 403.

### Trusted proxies

`BLACKVAULT_TRUSTED_PROXIES` is a comma-separated list of the addresses your reverse proxy
connects **from** — IPs, CIDR ranges (`172.28.0.0/16`) or host names. With direct access
off, a connection from anything else is **reset** (curl reports `(56) Connection reset by
peer`; through Docker Desktop / OrbStack's port forwarder it may show `(52) Empty reply`)
before BlackVault even looks at the request.

**Finding the right value:** try to reach BlackVault through your proxy once, then check
the container's log for the address it was rejected from:

```bash
docker compose logs blackvault | grep rejected
```

You'll see a line like `[gate] rejected 172.28.0.4 (not a trusted proxy; direct access
off)` — that's the address to add to `BLACKVAULT_TRUSTED_PROXIES`.

**A pitfall:** if your proxy runs outside Docker and dials the host's own IP and published
port (rather than joining BlackVault's Docker network), BlackVault sees the connection
arriving from the Docker bridge gateway, not your proxy's real address. Trusting that
address trusts **every** container on the host, not just your proxy — run your proxy on
the same Docker network as BlackVault instead, so its real container IP shows up in the
rejected-connection log.

**Docker Desktop / OrbStack:** the gate logs that peer addresses are unreliable there, so
trusted-proxy matching may not tell your proxy apart from other clients. This is a logged
warning only; it doesn't change behavior.

A `BLACKVAULT_TRUSTED_PROXIES` entry with a `/0` prefix (e.g. `0.0.0.0/0`) trusts every
address and logs a loud warning — it disables connection resets entirely. Don't use it
outside of temporary debugging.

### Break-glass: allow direct access anyway

If your proxy isn't set up yet, or you're testing without one, add this to `.env` and
restart:

```
BLACKVAULT_ALLOW_DIRECT_ACCESS=true
```

```bash
docker compose up -d
```

This forces direct access on regardless of the stored setting. Settings → Mobile Access
will say direct access is on and forced by `BLACKVAULT_ALLOW_DIRECT_ACCESS`; remove the
line and restart to go back to the stored setting.

### Upload size

If file or image uploads fail behind your proxy but work at `http://localhost:<port>`,
check your proxy's upload size limit (for nginx, `client_max_body_size`) — reverse
proxies default to a much smaller limit than BlackVault's own.

BlackVault itself caps a request body (this is what the sealed-backup restore upload
uses) at **64 MB**. Set your reverse proxy's own upload limit to at least that — for
example `client_max_body_size 64m;` in nginx / Nginx Proxy Manager, or
`request_body { max_size 64MB }` in Caddy. This matters even though BlackVault has its
own cap: Next.js buffers an incoming request body in memory *before* it ever checks that
cap, so an unauthenticated request with no size limit at all in front of it can still
force the server to hold a very large body in memory. Your reverse proxy's limit is the
real protection against that; BlackVault's own 64 MB figure only bounds how large a
legitimate restore upload may be (roughly 37,000 firearms with notes, sealed).

---

## Field Encryption

Serial numbers and NFA paperwork are encrypted at rest. Signed-in users see them exactly
as before; anyone who only has the disk, the Docker volume, a database dump or a plain
backup file cannot read them.

### What is encrypted

- **Firearm** and **Accessory**: `serialNumber`, `nfaControlNumber`, `nfaRegisteredTo`,
  `nfaTransferMethod`, `nfaApprovalDate`, `nfaTaxPaid`.
- **Gear**: `serialNumber`.
- Nothing else — NFA class, prices, notes and everything else stay plain text.

A serial number can only be looked up by **exact match**. Encrypted fields cannot be
searched, sorted, filtered or partially matched (no "contains", no case-insensitive
match) — that would require decrypting every row to compare it.

### The key — BACK UP THE KEY

The encryption key normally lives in a file, `secrets/blackvault_encryption_key`, next
to `docker-compose.yml`. `install.sh` / `install.bat` create it the first time you
install. It is mounted into the container **read-only**; on startup the container copies
it into an in-memory, non-executable tmpfs at `/run/secrets`, readable only by the `nextjs`
user (uid 1001) the app runs as — the key file on your host disk keeps its normal
ownership and permissions the whole time.

The alternative is the environment variable `BLACKVAULT_ENCRYPTION_KEY` (64 hex
characters) in `.env`. If both the key file and the environment variable are set to
**different** values, BlackVault refuses to start.

When the key is in `BLACKVAULT_ENCRYPTION_KEY` (a non-empty line in `.env`, or exported
in the shell / console that runs the script), `install.sh` / `install.bat` and
`update.sh` / `update.bat` see it and do **not** create a key file — a second, different
key would make BlackVault refuse to start. Key rotation (below) works only on the key
file: with `BLACKVAULT_ENCRYPTION_KEY` set, `rotate-key.sh` / `rotate-key.bat` refuse
before stopping anything. To rotate, first move the key into the file: put the same 64
hex characters in `secrets/blackvault_encryption_key` (mode 600, folder mode 700), delete
the `BLACKVAULT_ENCRYPTION_KEY` line from `.env` (and unset it in your shell), and start
BlackVault once to check it.

BlackVault also refuses to start if the key is missing, wrong for the database it is
opening, or the database's key check cannot be verified at all. There is no recovery
from a lost key other than restoring it from a backup of the key file itself, or
restoring a sealed backup (below), which uses its own passphrase instead.

> ⚠️ **BACK UP THE KEY.** Without `secrets/blackvault_encryption_key` (or whatever you
> set `BLACKVAULT_ENCRYPTION_KEY` to), your serial numbers and NFA records cannot be
> recovered. Keep a copy somewhere other than the server it protects.

### Sealed backups

A backup downloaded from **Settings → Backup** is sealed with a passphrase **you**
choose (at least 12 characters) — not the server's encryption key. That means a sealed
backup can be restored onto a different install with a different encryption key,
as long as you remember the passphrase. A wrong passphrase, or a damaged file, changes
nothing.

An older, unsealed (plain JSON) backup from before this release still restores — you'll
see a warning that the file is not encrypted first.

Restoring a backup is capped at 64 MB (see **Upload size** above for why, and how to
also set a matching limit on your reverse proxy). That is comfortably enough for a very
large inventory (around 37,000 firearms with notes); a household with more than that
would need a command-line restore path, which does not exist yet.

### Rotation

`rotate-key.sh` (Mac/Linux) and `rotate-key.bat` (Windows), next to `docker-compose.yml`,
generate a brand-new key and re-encrypt every value under it:

1. The app is **stopped first** — SQLite needs that for a consistent copy.
2. The database is snapshotted.
3. A new key is generated, and the rotation runs inside the container in one
   database transaction.
4. On success the old key is kept, never deleted, renamed to
   `secrets/blackvault_encryption_key.old-<timestamp>`. **Keep that file** for as long as
   you keep the pre-rotation snapshot the script just took — only the old key opens it.
5. The app restarts on the new key.

The wrappers **never delete a key file.** If a rotation run is interrupted or its result
is ambiguous, the script asks the database itself which key it is actually encrypted
with before touching anything, and prints exact recovery commands rather than guessing.
An unused new key that was generated but never used is renamed to
`secrets/blackvault_encryption_key.new.unused-<timestamp>` — safe to delete once
BlackVault has run normally again on the old key. If a `secrets/blackvault_encryption_key.new`
file is already sitting there from an earlier, unfinished rotation, the script refuses to
run at all until you move it out of `secrets/` by hand — it may be the only remaining copy
of the key the database is actually encrypted with.

Any recovery text the scripts print is meant to be followed exactly, in order; it names
the current state of each key file precisely because that state determines which command
is safe to run next.

### Upgrading to this release

**PostgreSQL users: take your own copy BEFORE starting the new version.** The app cannot
dump its own PostgreSQL server, so unlike SQLite it does not take a snapshot of existing
data before encrypting it — it only logs a warning, by which point the data is already
encrypted. Run this yourself first, with the OLD version still running:

```bash
mkdir -p backups && (umask 077 && docker compose exec -T db pg_dump -U blackvault -d blackvault > backups/blackvault-pre-encryption.sql)
```

(`mkdir -p backups` is needed: versions before this one never create a `backups/` folder,
and the dump is written readable by you only, like the update scripts' own snapshots.)

The update scripts (`update.sh` / `update.bat`) also snapshot your database into
`backups/` before starting the new image — new in this release, not something earlier
versions did. On top of that, BlackVault's own first start after this upgrade takes
**its own** snapshot too (`pre-encryption-<timestamp>.db`, next to `vault.db`, SQLite
only) just before it encrypts your existing data, in case the update script that ran was
an older copy that predates this feature. **All of these snapshots are plain text.**
Delete them once you've confirmed BlackVault is working normally. On Linux, the app's own
snapshot is owned by uid 1001 (the container's user), so deleting it needs `sudo`.

**Mac/Linux: run `./update.sh` twice** for this specific upgrade. The copy of
`update.sh` you already have pulls the new code, and then keeps running — bash does not
reload a script out from under itself — so the rest of that same run is still the *old*
code: it builds and starts the new image with no encryption key. The new image then exits
immediately on `KEY_MISSING` and Docker's `restart: unless-stopped` puts it in a restart
loop. Run `./update.sh` again (or `git pull && ./update.sh` if you'd rather not wait) and
this second run is the new script end to end: it creates the key, takes its snapshot, and
starts normally. This is not a Linux-specific quirk — macOS runs the exact same
`./update.sh` and hits the exact same restart loop. Windows is not affected: `update.bat`
resumes execution *inside the newly-pulled file* immediately after its own `git pull`
line, so even a Windows user's very first run is effectively the new script and creates
the key and the snapshot in one pass.

**If `git pull` refuses, saying `install.bat` or `update.bat` would be overwritten:**
some existing clones have those two files marked as locally modified purely because of
line endings, which blocks the very first pull into this release. Run the one-time
recovery for your platform, from the BlackVault folder.

<!-- readme-recovery-posix:start -->
Mac/Linux (bash or zsh) — backs up and restores any existing `.git/info/attributes`
instead of assuming there isn't one, and copes with one that has no trailing newline:

```bash
ATTRS=$(git rev-parse --git-path info/attributes)
[ -f "$ATTRS" ] && cp -p "$ATTRS" "$ATTRS.bak"
printf '\ninstall.bat -text\nupdate.bat -text\n' >> "$ATTRS"
sleep 1
git update-index -q --refresh
if [ -f "$ATTRS.bak" ]; then mv "$ATTRS.bak" "$ATTRS"; else rm -f "$ATTRS"; fi
git pull
./update.sh
```
<!-- readme-recovery-posix:end -->

<!-- readme-recovery-windows:start -->
Windows — save the following as `recovery.cmd` in the BlackVault folder (next to
`docker-compose.yml`) and run it:

```cmd
for /f "usebackq delims=" %%P in (`git rev-parse --git-path info/attributes`) do set "ATTRS=%%P"
set "ATTRS=%ATTRS:/=\%"
if exist "%ATTRS%" copy /y "%ATTRS%" "%ATTRS%.bak" >nul
(echo.&echo install.bat -text&echo update.bat -text)>>"%ATTRS%"
ping -n 2 127.0.0.1 >nul
git update-index -q --refresh
if exist "%ATTRS%.bak" (move /y "%ATTRS%.bak" "%ATTRS%" >nul) else (del /f /q "%ATTRS%")
git pull
update.bat
```
<!-- readme-recovery-windows:end -->

(`git checkout -- install.bat update.bat` does **not** fix this — it rewrites the same
bytes Git already has, so Git still reports them modified. The commands above instead
make Git re-check the two files byte-for-byte against what's already committed.)

### What encryption at rest does not erase

- **Leftover copies of the old values.** Rewriting a row leaves its old bytes in the
  database's free space. So right after it encrypts your existing data — and after every key
  rotation — BlackVault compacts the database: `VACUUM` on SQLite (it needs free disk space
  about the size of the database, briefly), `VACUUM FULL` + `ANALYZE` on PostgreSQL, including
  PostgreSQL's statistics table. If that compaction fails, BlackVault logs a
  `[encryption] WARNING: could not compact the database…` line, **still starts** (your data is
  already encrypted), and tries again on every start until it succeeds.
- What no compaction can reach: **PostgreSQL's write-ahead log** (`pg_wal/` in the
  PostgreSQL data folder) keeps old values until PostgreSQL recycles those files, and **free
  blocks of the filesystem** can still hold deleted files — an old SQLite journal, the copy
  `VACUUM` replaced, PostgreSQL's pre-`VACUUM FULL` table files — until they are overwritten.
  Only an encrypted disk or filesystem under the data folder protects against someone reading
  those raw blocks.
- **Server-side backups written by earlier versions are plain text.** If you had a backup
  destination folder set in Settings, earlier versions wrote unencrypted
  `blackvault-backup-<timestamp>.json` files there (the setting is a path inside the
  container: `/app/data/backups`, for example, is `data/db/backups` on the host). This release
  writes only sealed `….sealed.json` files. Take a sealed backup, then delete the old
  `.json` ones.
- **The pre-upgrade snapshots** (above) are plain text until you delete them.
- **A key kept in `BLACKVAULT_ENCRYPTION_KEY`** cannot be rotated by the scripts; move it into
  the key file first (see **The key** above).

### Admin commands now need `-u nextjs`

The container's entrypoint drops from root to the `nextjs` user before the app itself
starts — but `docker compose exec` runs a new command in the container directly,
bypassing that entrypoint, and now defaults to **root**. Running an admin command as root
is not itself a security problem (root can read everything `nextjs` can, including the
key), but it can leave root-owned files on the data volume — for example a SQLite journal
file the app itself then cannot clean up as `nextjs`. Admin commands like the
password-reset link (see **Users and sign-in** above) should add `-u nextjs` explicitly
to avoid that, even though the specific command below never reads the encryption key:

```bash
docker compose exec -u nextjs blackvault node scripts/admin-reset-link.mjs <username>
```

---

## Encrypted Files

Uploaded photos and documents are encrypted at rest too. Signed-in users see and download
them exactly as before; anyone who only has the disk, the uploads folder or a copy of it
cannot open them.

### What is encrypted

- **Every uploaded photo and document.** Each one is stored as an encrypted `BVF1` file
  (AES-256-GCM, one file at a time) under a file key that is derived from the same key as
  **Field Encryption** above. There is no second key to keep — but **BACK UP THE KEY** now
  protects your photos and documents as well as your serial numbers.
- **Documents now live in the uploads folder:** `<DATA_DIR>/uploads/documents/` on the host
  (`/app/uploads/documents` in the container), next to your photos. Document links
  (`/api/files/documents/<name>`) are unchanged, so nothing in the database is rewritten.
- On the first start after the upgrade, BlackVault encrypts every existing plain file in the
  uploads folder in place, once. It leaves alone hidden files and anything inside a hidden
  folder, `.tmp` and `.rot` work files, and symbolic links (a linked file is logged and
  skipped; a linked **folder** stops the start — replace it with a real folder).
- **No browser caching.** Photos and documents are sent with `Cache-Control: private,
  no-store`, so the browser keeps no copy and photos reload on every visit.

### Before upgrading to this release: rescue your documents (Linux, Mac and Windows)

> ⚠️ **Do this BEFORE you run `update.sh` / `update.bat` (or `git pull`).** Before this
> release, uploaded **documents** (not photos) were written inside the container itself, at
> `/app/storage/uploads/documents`, which is not on any volume. Recreating the container —
> which every update does — deletes them. Copy them out while the old container still exists.

In each command below, replace `<DATA_DIR>` with your data folder (`./data` unless you changed
`DATA_DIR` in `.env`).

**Linux.** Check whether you have any, with the old version still running:

```bash
sudo docker exec blackvault ls -la /app/storage/uploads/documents
```

If it says `No such file or directory`, or lists no files, there is nothing to rescue — skip
to the update. If it lists files, copy them onto the volume and give the uploads folder to the
app's user (uid 1001):

```bash
sudo docker cp blackvault:/app/storage/uploads/documents <DATA_DIR>/uploads/
sudo chown -R 1001:1001 <DATA_DIR>/uploads
```

`docker cp` gives the copies to the user who ran it; the app runs as uid 1001 and must own the
documents to encrypt them, and the uploads folder itself to write its snapshot there. This
rescue is proven on Linux in CI.

**Mac (Docker Desktop or OrbStack).** The same steps, with no `sudo` and **no `chown`**:

```bash
docker exec blackvault ls -la /app/storage/uploads/documents
docker cp blackvault:/app/storage/uploads/documents <DATA_DIR>/uploads/
```

Docker Desktop and OrbStack read and write the files in your data folder as your own Mac user,
so the copies are already usable by the app. A `chown` to 1001 would hand them to a user other
than the one Docker writes as, and the app could then probably no longer encrypt them. This
rescue is tested on OrbStack (the documents were encrypted and open after the update); it has
not been tested on Docker Desktop yet, so there verify after the update that your documents open.

**Windows (Docker Desktop).** In PowerShell or Command Prompt, with no `sudo` and no `chown`:

```
docker exec blackvault ls -la /app/storage/uploads/documents
docker cp blackvault:/app/storage/uploads/documents <DATA_DIR>\uploads\
```

This has not been tested yet; verify after the update that your documents open.

Then update as usual: the first start encrypts the rescued documents in place.

If you already updated once since you uploaded a document, its file is probably gone; see
**Missing documents** below.

### Missing documents

On every start, BlackVault checks that each uploaded document in the database still has its
file in `<DATA_DIR>/uploads/documents/`. Each one that does not is logged as one line:

```
[files] Missing document file: id=<id> name="<name>" item=firearm <id> file=/app/uploads/documents/<file>
```

Find them with `docker compose logs blackvault | grep "Missing document file"`. BlackVault
**still starts**; the document entry stays, and opening it returns *File not found*.

They are also recorded in the `FILES_ENCRYPTED` entry of the **Audit log** (actor `system`):
`changes.missing` lists `{ id, name }` for the first 200, and `changes.missingTotal` has the full
count. That entry is written on the first start after the upgrade, and again on any later start
that encrypts or moves files — so a start that changes nothing logs the missing documents but
adds no audit entry.

If you still have a missing file, put it back at the `file=` path (owned by uid 1001 on Linux)
and restart: BlackVault encrypts it on that start.

### Snapshots of the uploads folder

Two kinds of copy are taken before your files change:

- **`backups/uploads-<timestamp>/`** — taken by `update.sh` and `rotate-key.sh` before the new
  version starts or the key changes. On Mac/Linux the copy runs **inside a one-off container**
  of the BlackVault image, as the app's user: the encrypted files are mode 600 and owned by
  uid 1001, so your own user cannot read them. The snapshot is owned by uid 1001 too (folders
  mode 700, files mode 600), so deleting it on Linux needs `sudo rm -r backups/uploads-<timestamp>`.
  On Mac (OrbStack), the snapshot shows as owned by your own user and needs no `sudo`.
  On Windows, `update.bat` / `rotate-key.bat` copy on the host and restrict the folder to your
  user account. If the copy fails, the update stops and the new version is not started.
- **`<DATA_DIR>/uploads/.pre-encryption-<timestamp>/`** — taken by BlackVault itself on the
  first start that finds plain files, before it encrypts anything. It is skipped when the update
  script's snapshot already covers that start (the log then says *The update script already
  saved a snapshot of the uploads folder*), except for documents the app moves from the old
  in-container folder, which it always copies here first. It is owned by uid 1001: delete it
  with `sudo rm -r`. If it cannot be written — a full disk, for example — BlackVault refuses to
  start before encrypting anything, and says how much space it needs.

`backups/uploads-*` needs free disk space equal to the size of the uploads folder.
`.pre-encryption-*` needs space only for the files that are still plain text: on the first
upgrade that is roughly the whole folder, on later starts much less. **Both are plain text:**
`.pre-encryption-*` always; `backups/uploads-*` only when it was taken before the first
encryption — later ones copy files that are already encrypted (and need the key to open). Every
update takes another `backups/uploads-*` copy, so delete old ones once BlackVault is confirmed
working.

Neither snapshot copies symbolic links. Both skip `.tmp` and `.rot` work files, and the update
snapshot skips `.pre-encryption-*` folders, on Windows too.

### Rotation covers files

`rotate-key.sh` / `rotate-key.bat` (see **Rotation** above) now re-encrypt every uploaded file
too, around the same single database transaction:

1. **Stage.** Before the transaction, every file under the old key is re-encrypted under the
   new key into `<name>.rot`, next to the original. Originals are not touched.
2. **Database.** The transaction runs as before. If it does not commit, every `.rot` is
   deleted and nothing else changes.
3. **Finalise.** Only after the commit is each `.rot` renamed over its original.

If a rotation is interrupted after the commit, the next start on the new key finishes it:
startup renames each `.rot` under the current key into place, after checking that it decrypts.
A `.rot` under any other key is staging that never committed and is deleted — unless its
original is missing, in which case it is kept and a warning is logged, since it may be the only
copy. Startup then refuses to start if any file is still under a key other than the current
one, naming the file and its key id.

The wrapper's probe (which key does the database answer to?) prints a second line,
`FILES old=<n> new=<n> rot=<n>` (the `rot` count can include stale `.rot` files left over from
an earlier interrupted rotation; startup tidies those up); the first line, `OLD` / `NEW` / `NEITHER`, is unchanged. On a
`NEW` answer the wrapper says how many `.rot` files are staged and restarts BlackVault, whose
startup puts them in place.

When the rotation itself fails:

- **It refused up front** (the rotation command exits 3): an uploaded file is under neither key,
  has a damaged header, sits behind a symlinked folder, or a `.rot` from an earlier run is under
  the old key. Nothing changed. The wrapper sets the unused new key aside, does **not** restart
  BlackVault, and the message above it names the file.
- **It failed before the commit** (exit 1) — a full disk while staging, for example: every
  staged `.rot` is deleted, the probe answers `OLD`, and BlackVault restarts on the old key.

### Files encrypted with a different key

Every uploaded file opens only with the key that encrypted it. This happens when files from
another key end up in `<DATA_DIR>/uploads`:

- uploads copied from another machine, or from another BlackVault install, whose key you did
  not bring along (see **Moving to a new machine**);
- an old `backups/uploads-<timestamp>/` restored after a key rotation. A snapshot that
  `rotate-key` takes is under the **old** key: keep it together with
  `secrets/blackvault_encryption_key.old-<timestamp>`, the old key the wrapper set aside.

**BlackVault then refuses to start — the whole app, not just those files.** The log names the
first such file and its key id (`… is encrypted with key <id>, not the current key <id>`).
Restarting, or running the rotation again, does not help: the database is already bound to the
current key, and the rotation only accepts files under the current or the new key.

To recover, pick one:

- **Move the files aside.** Move every file the log names out of `<DATA_DIR>/uploads` (on
  Linux with `sudo`: they belong to uid 1001) and start again; repeat until it starts. Keep
  them: they open only with the key that encrypted them.
- **On a new install that holds no data yet**, use the original key instead:
  1. Stop BlackVault (see *Stopping and Starting*).
  2. Put the original install's key in `secrets/blackvault_encryption_key`. Keep the new
     install's key file somewhere safe until BlackVault starts.
  3. Delete the database the new install just created, and **only** if it holds nothing you
     need: `<DATA_DIR>/db/vault.db` on SQLite, or the `<DATA_DIR>/postgres` folder on PostgreSQL (with
     `sudo` on Linux).
  4. Start BlackVault. It binds the fresh database to the original key and the files open.
  5. Restore your backup (**Settings → Backup**). If you want a new key, rotate afterwards
     (see **Rotation**).

- **Re-encrypt them, if you still have the key that encrypted them** — for example
  `secrets/blackvault_encryption_key.old-<timestamp>` after a rotation, or the key file of the
  machine the folder came from. Run, from the BlackVault folder:

  ```bash
  ./reencrypt-files.sh --from-key-file <path to the old key file>
  ```

  **Windows:**

  ```bat
  reencrypt-files.bat --from-key-file <path to the old key file>
  ```

  What it does:

  1. It stops BlackVault.
  2. In a one-off container, every file under `uploads/images` and `uploads/documents` that is
     encrypted with the old key is decrypted with it, encrypted with the current key, and
     replaced in one step. Files already under the current key are skipped, so running it twice
     is safe. Files that are not encrypted are left as they are.
  3. Files under any **other** key are left as they are too, each with a `WARNING:` line.
     BlackVault still refuses to start while one of those is in the folder: move it out, or run
     the tool again with the key that encrypted it.
  4. It starts BlackVault again **only if it was running** when you ran the tool. The last line
     says whether it was started; if not, start it with `docker compose up -d`.

  **It takes no snapshot.** The files are rewritten in place, and the tool keeps no copy of the
  uploads folder. If you want a way back, copy `<DATA_DIR>/uploads` somewhere else first (on Linux
  with `sudo`: the files belong to uid 1001).

  **It only looks under `uploads/images` and `uploads/documents`**, where BlackVault itself puts
  files. A file under the old key that was placed anywhere else in the uploads folder is not
  converted, and BlackVault will still refuse to start on it: move it out.

  The old key file is only read: the tool never deletes, moves or changes a key file, and it
  deletes no uploaded file. The key is handed to the program on its standard input, never on a
  command line or in an environment variable.

  If it stops part-way (a full disk, a closed terminal), every file is whole, under the old key
  or the current one. Run it again: it continues with the files still under the old key.
  **After an interrupted run BlackVault stays stopped**, even if it was running before.

  Exit codes:

  | Code | Meaning |
  |---|---|
  | 0 | At least one file was under the old key, and all of them were re-encrypted. |
  | 3 | Nothing was changed: no file is under the old key (a second run answers this too), or the old key file is missing, empty, not a key, or is this install's current key. |
  | 1 | Failed; the lines above the last one say why, and whether running it again will continue. Also: the tool finished — whether it re-encrypted files or found nothing to do — but BlackVault was running before and could not be started again (the last line says so). |

  **Keep the old key file until BlackVault has started and your photos and documents open.**

Without the key that encrypted them, those files cannot be recovered.

### Known limitations of file encryption

- **Plaintext traces stay on disk.** The bytes of the original files may remain in free blocks
  of the filesystem after they are encrypted. BlackVault cannot wipe them reliably; only an
  encrypted disk under the data folder protects against that.
- **A plain file that happens to start with the four bytes `BVF1`** is treated as encrypted and is
  never encrypted. Its "header" is almost never a valid one, so BlackVault then refuses to start
  and names the file as damaged: move it out of the uploads folder and start again.
- **The JSON backup does not hold files.** The download in **Settings → Backup** still holds
  only file paths. A **full backup** holds the files themselves (see **Full backups**). If you
  copy `<DATA_DIR>/uploads` yourself instead — on Linux with `sudo`, since the files belong to
  uid 1001 — keep the key with it: the copy cannot be read without it, and a BlackVault started
  with a different key refuses to start on those files.
- **No per-item access control.** Any signed-in user can open any photo or document, as before.
- **PostgreSQL: the app keeps running while the update copies the uploads folder.** An upload
  made during that copy makes the snapshot's file count disagree, and the update stops before
  starting the new version (it fails safe). Run the update again.
- **The first upgrade can take minutes** with many files: every file is copied, then encrypted
  and synced to disk one at a time. Progress is logged every 250 files
  (`[files] snapshot 250/…`, `[files] encrypted 250/…`).
- **Docker Desktop on Mac:** the in-container uploads snapshot is proven on Linux and on
  OrbStack, not yet on Docker Desktop. (Windows copies on the host instead.)

---

## Data & Backups

### Where your data lives

BlackVault stores everything in a `data` folder inside the project directory by default:

```
data/
├── postgres/           ← your database, if you use PostgreSQL (the default)
├── db/
│   └── vault.db        ← your database, if you use SQLite
└── uploads/
    └── ...             ← uploaded images and documents
```

With PostgreSQL, the database password lives in `.env` (`BLACKVAULT_POSTGRES_PASSWORD`). Back up `.env`
together with the `data` folder.

You can change this by editing `DATA_DIR` in the `.env` file before first run.

---

### Backing up your data

**Everything in one file:** a **full backup** holds the records *and* the uploaded photos and
documents, and restores onto any machine. See **Full backups** below.

**Records only, works for both databases, safe while running:** in BlackVault go to
**Settings → Backup** and save a backup. It downloads a JSON file with every record. It does not
hold your images and documents: keep it together with a copy of `data/uploads`, `.env` and the
encryption key file — the uploaded files are encrypted and cannot be read without that key (see
**Encrypted Files** above).

This backup does **not** include accounts (users, passwords, sessions or invite/reset links)
— only inventory data. Restoring a backup never touches accounts either way, so restoring an
old one can't lock anyone out or bring back a since-disabled user.

**Copying the `data` folder:** only do this with BlackVault **stopped**. On PostgreSQL,
copying `data/postgres` while the database is running can produce a copy that will not start.

**Windows:** stop BlackVault (see *Stopping and Starting* above), then copy the `data` folder
and `.env` to another drive or location in File Explorer.

**Mac / Linux, SQLite:**

```bash
docker compose down
sudo cp -a ./data ~/blackvault-backup-$(date +%Y%m%d)
cp .env ~/blackvault-backup-$(date +%Y%m%d)/
docker compose up -d
```

**Mac / Linux, PostgreSQL:**

```bash
docker compose down
sudo cp -a ./data ~/blackvault-backup-$(date +%Y%m%d)
cp .env ~/blackvault-backup-$(date +%Y%m%d)/
docker compose up -d
```

On Linux, `data/postgres` is owned by the database container, so a plain `cp -r` fails with
*permission denied*; `sudo cp -a` copies it and keeps its ownership, which PostgreSQL needs.
The same goes for `data/uploads` on both databases: since this release its files are mode 600
and owned by the app's user (uid 1001), which is why the SQLite commands use `sudo cp -a` too.

---

### Full backups (records, photos and documents)

A **full backup** is one file, `blackvault-full-<date>-<time>.bvb`, holding every inventory record
**and** every uploaded photo and document, sealed with a passphrase you choose. That file and its
passphrase rebuild the whole install, on this machine or another one — including one with a
**different** encryption key: the files are stored decrypted inside the sealed archive, so a full
backup does not depend on `secrets/blackvault_encryption_key`.

Like the JSON backup above, it does **not** include accounts, settings or the audit log.

**Without the passphrase a full backup cannot be opened, by anyone.** It must be at least 12
characters. BlackVault never stores it.

#### Where full backups are kept

BlackVault writes them into its **backup folder**: `<DATA_DIR>/backups` (by default
`./data/backups`). To use another disk or a NAS mount, set `BLACKVAULT_BACKUP_DIR` in `.env` and
run `docker compose up -d`:

```
BLACKVAULT_BACKUP_DIR=/mnt/nas/blackvault-backups
```

- The files are mode 600 and belong to the app's user (uid 1001), in a folder that is mode 700. On
  Linux, list or copy them with `sudo`.
- The date and time in the file name are **UTC**, not your local time.
- **BlackVault never copies a backup anywhere else.** A backup that sits on the same disk as the
  data protects against a mistake, not against losing the disk: copy the `.bvb` files off this
  machine yourself.
- This is not the `backups/` folder next to `docker-compose.yml`. That one holds the plain
  snapshots that `update`, `rotate-key` and `restore` take before they change anything.

#### From the browser

**Settings → Backup → Full Backup (database + files)**, admins only. Type the passphrase twice and
press **Start Full Backup**.

- The backup runs on the server and keeps running if you close the page. The file is saved in the
  backup folder; it is **not** downloaded.
- The progress bar has two phases, **Writing the archive** and then **Verifying the archive**
  (the whole file is read back and checked before it gets its final name), each with
  `<n> of <m> files`.
- **Backup complete** shows the file name, the number of files and their size, in binary units
  (1 KiB = 1024 bytes, 1 MiB = 1024 KiB, 1 GiB = 1024 MiB).
- **Backup finished, but it is INCOMPLETE** means some uploaded files could not be read (a damaged
  file, a file name a backup cannot hold). They are listed, each with the reason, and they are
  **not** in the backup. Fix or remove them and make another backup.
- Files deleted while the backup ran are listed separately. That is normal on a running install.
- Only one full backup runs at a time. The button never deletes an older backup.

#### From the command line

From the BlackVault folder:

```bash
./backup.sh
```

**Windows:**

```bat
backup.bat
```

It asks for the passphrase twice, without showing it, and works whether BlackVault is running or
stopped. On success it prints one line:

```
BLACKVAULT_FULL_BACKUP_OK file=blackvault-full-20261003-031500.bvb files=412 bytes=5368709120 archive_bytes=5369123456 skipped=0 unreadable=0
```

`unreadable` above 0 means the backup is **incomplete**: each file left out has a `WARNING:` line
above it. Look at `WARNING:` lines even when the command succeeded.

| Option | What it does |
|---|---|
| `--passphrase-file <path>` | Reads the passphrase from a file instead of asking. The file's content is the passphrase, minus one line ending at the very end (and a UTF-8 byte order mark at the very start, if the editor wrote one). The file must be saved as UTF-8 text: see [the passphrase file](#a-nightly-backup-with-cron) below. The passphrase is never put on a command line or into an environment variable. |
| `--keep <n>` | After the new backup has been written **and verified**, deletes the oldest full backups beyond the newest `<n>`. Default 7. If the backup fails, nothing is deleted. If the new backup is **incomplete** (`unreadable` above 0), nothing is deleted either: an older backup may be the only one that still holds the file. It prints `WARNING: old backups were kept because this backup is incomplete`, and the folder grows until the file is repaired or removed. Only files named exactly `blackvault-full-<date>-<time>.bvb` count: a copy you renamed is never deleted. The deleting happens inside the container, because on Linux the files belong to uid 1001. |
| `--verify <file>` | Checks one backup: decrypts the whole archive and compares every file with its checksum. Writes nothing. `<file>` is a file name in the backup folder, or a path to a file in that folder. Asks for the passphrase once. |

| Exit code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Failed. One line says why. Nothing was deleted, and no half-written backup is left. |
| 2 | Another full backup is already running. |

Without `--passphrase-file` and without a terminal (cron, Task Scheduler) it stops at once with
exit 1 instead of waiting for someone to type.

There is no time limit by default. Set the environment variable `BLACKVAULT_BACKUP_TIMEOUT` to a
number of seconds to stop waiting after that long.

#### A nightly backup with cron

```
30 3 * * * cd /home/you/BlackVaultArmory && ./backup.sh --passphrase-file /home/you/.blackvault-backup-passphrase --keep 14 >> /home/you/blackvault-backup.log 2>&1
```

The passphrase file:

- Create it with `chmod 600`, readable only by the user the cron job runs as.
- **Do not keep it in the backup folder, in `data/`, or anywhere that is copied along with the
  backups.** Whoever has a backup file and the passphrase file can read everything in it.
- A scheduled backup needs the file on the machine when it runs. If you can, keep it off the
  BlackVault host otherwise — for example on a mount that is only there while the backup runs —
  and run backups you start yourself without a file at all.
- **Keep a second copy of the passphrase somewhere else** (a password manager). If the file is
  lost with the machine, the backups you copied off-site cannot be opened.
- **Save it as UTF-8 text**, the passphrase on one line. A backup made from the file then opens
  with the same passphrase typed at the prompt. A file in another encoding (UTF-16, for example)
  is refused with `the passphrase is not UTF-8 text`, before anything is done.
- **Windows:** do not create it with `>` or `Out-File` in Windows PowerShell 5.1; they write
  UTF-16. Use Notepad (**Save as**, Encoding **UTF-8**), or in PowerShell:

  ```powershell
  [IO.File]::WriteAllText("$env:USERPROFILE\blackvault-passphrase.txt", (Read-Host "Passphrase"))
  ```

Check the log, or the exit code, now and then: a cron job that has been failing for a month is
not a backup.

#### Backup folder on a NAS

- **If the share is not mounted, the backups go to the local disk.** Docker creates a missing
  folder for a bind mount. When `/mnt/nas` is not mounted at the moment BlackVault starts, Docker
  creates `/mnt/nas/blackvault-backups` on the local disk and every backup lands there, without an
  error. Check where the files really are after the first backup, and after a reboot.
- **Shares that refuse `chown`** (NFS with root squash, SMB). At start BlackVault tries to give
  the backup folder to uid 1001 with mode 700. When the share refuses, it leaves the folder's mode
  alone and prints a `[entrypoint] WARNING:` line in `docker compose logs blackvault`. If the app
  can write there anyway, backups work; who else can read the folder is then decided by the share,
  not by BlackVault. If it cannot, BlackVault still starts, and the button and `backup.sh` fail
  with a message that names the folder: make it writable by uid 1001.
- **Shares without hard links.** A finished backup gets its final name with a hard link, which
  cannot replace an existing file. Where the share has no hard links BlackVault renames instead.
  The only difference: two backups running at once and finishing in the same second could then
  replace one another, and the lock normally prevents two from running.
- **FAT and exFAT disks, and shares where the app does not own its files.** If the folder is
  mounted for another user (`uid=0`, say) but everyone may write, BlackVault can create the
  backup but cannot set its mode to 600. The backup is still made, verified and usable; a
  `WARNING:` says that who else can read the file is decided by the mount options. Mounting
  the disk for the app's user (`uid=1001,gid=1001,fmask=0177,dmask=0077`) avoids the warning.
  **On such a folder anyone who can read the disk or the share can copy the backup file.** Its
  header (the salt and the key-derivation settings) is not secret, so the copy can be attacked
  by guessing passphrases at leisure: the passphrase is the only protection. Choose a long one.
  If BlackVault can neither set the lock file's time nor rewrite it there, a `WARNING:` says
  that another backup or restore may not see this one as running: do not start a second one
  while a long backup or restore runs on that folder.

---

### Restoring a full backup

A full restore is done from the command line, with BlackVault stopped. (The browser's
**Restore** in **Settings → Backup** is still there, for the small JSON backups that hold records
only.)

**It replaces everything a backup holds:** every inventory record and every uploaded photo and
document. Accounts, settings and the audit log are not in a backup and are kept as they are.

1. Put the `.bvb` file into the backup folder: `<DATA_DIR>/backups`, or the folder
   `BLACKVAULT_BACKUP_DIR` names if you set it. On Linux, with the default folder:

   ```bash
   sudo install -o 1001 -g 1001 -m 600 /path/to/blackvault-full-20261003-031500.bvb ./data/backups/
   ```

2. From the BlackVault folder:

   ```bash
   ./restore.sh blackvault-full-20261003-031500.bvb
   ```

   **Windows:**

   ```bat
   restore.bat blackvault-full-20261003-031500.bvb
   ```

It asks for the passphrase once (`--passphrase-file <path>` works as in `backup.sh`). What it then
does, in this order:

1. **Checks the backup**, in a one-off container: a full decrypt, every file against its
   checksum. A wrong passphrase or a damaged or cut-off file stops here. Nothing was changed and
   BlackVault was not stopped.
2. **Asks you to type `RESTORE`.** `--yes` skips the question. Without a terminal there is nobody
   to ask, so `--yes` is then required; without it the script stops before anything is checked.
3. **Stops BlackVault and takes a snapshot** of the database and the uploads folder into
   `backups/` (next to `docker-compose.yml`). If the snapshot fails, BlackVault is started again
   and nothing was changed. If a full backup is running when the restore gets here (the
   **Settings** button, `backup.sh`, a scheduled backup), the restore stops instead, before
   BlackVault is stopped: `ERROR: a full backup is running`. Nothing was changed; run the restore
   again when the backup has finished.
4. **Restores**, in a one-off container. The backup's files are written, encrypted with **this**
   install's key, into `uploads/.restore-<time>/`. The database records are replaced in one
   transaction. Then the current `images/` and `documents/` folders are moved into
   `uploads/.pre-restore-<time>/` and the restored ones take their place.
5. **Starts BlackVault.** The restore is recorded in the audit log.

BlackVault is stopped from step 3 until step 5.

**Restoring onto a different key** needs nothing extra. A new install has its own key; the
restore encrypts the files and the serial numbers with it. You do not need the old machine's key
file.

**If step 4 fails, the install is put back automatically**, BlackVault is started again and the
script exits 1. The uploads are always put back and compared with the snapshot. The database is
put back from the snapshot only if the restore had reached its database step; otherwise it was
never touched and is left alone. If the rollback itself fails, BlackVault is **not** started and
the script says what to do.

**The recovery file.** Just before step 4 the script prints, and writes to
`backups/restore-<time>-RECOVERY.txt`, where the snapshot is and the exact commands that put it
back by hand. It is deleted when the restore has succeeded or the automatic rollback has worked.
If you find one, either the script did not end by itself (it was interrupted, the terminal was
closed, the machine restarted) or the automatic rollback failed, which the script says before it
exits. Either way BlackVault is stopped and the install may be half restored. Read the file and
follow it. **While one exists, a new restore refuses to start.**

**BlackVault does not start on a half-restored install.** A restore that reached its database
step leaves a marker, `uploads/.restore-<time>.db-started`, until it has finished or been put
back. While a marker exists BlackVault exits at startup with a message that names it. If
`backups/restore-<time>-RECOVERY.txt` exists, follow it: it ends by removing the marker, either
after putting the install back or, when the restore itself had finished and only the marker could
not be removed, as its one step. If no such file is there, the marker alone does not say whether
the install is whole: delete the marker folder (on Linux with `sudo`) only if the restore script
had reported the restore as complete or as put back. Otherwise do not start on that install:
restore a full backup; the restore script prints the command that removes the marker first.

The restore script follows the same rule. It removes its own marker before it starts BlackVault,
and if it cannot, it does not start BlackVault, exits 1 and prints the command that removes the
marker. Markers left by earlier restores stop a new restore before anything is checked, with one
command that removes them; so does an uploads folder it cannot check for them.

**`uploads/.pre-restore-<time>/`** holds the photos and documents that were there before the
restore, every file, including ones the backup does not have. BlackVault never deletes it, and it
uses as much disk as those files did. Once you have checked the restored install, delete it, and
the snapshot in `backups/` (on Linux with `sudo`).

| Exit code | Meaning |
|---|---|
| 0 | Restored. |
| 1 | Failed. The last lines say which of five it was: nothing was changed; or the install was put back and BlackVault was started again; or the install was put back (or nothing was changed, or the restore itself had finished) but BlackVault **could not be started** — the output says so: look at `docker compose logs blackvault` and start it by hand with `docker compose up -d`; or the restore had finished (or the install was put back) but the restore's marker could not be removed — then BlackVault was **not started**: run the command the last line prints, then `docker compose up -d`; or the rollback failed, or how far the restore got could not be found out, or the script was interrupted during the restore — then BlackVault is **stopped** and the install may be half restored: follow the RECOVERY file. |

---

### Known limitations of full backups

- **A backup is a point in time.** It holds the records as they were when it read them. A file
  uploaded while it runs is not in it; a file deleted while it runs is listed as skipped.
- **No incremental backups.** Every backup is a complete copy. Manage the space with `--keep`.
- **Every backup is read twice.** The archive is written, then read back in full and checked,
  before it gets its final name, so a backup takes roughly twice as long as writing it alone. A
  file in the backup folder named `blackvault-full-….bvb` has therefore been verified once.
- **The passphrase is needed for every run.** A scheduled backup needs a passphrase file; see
  above for where to keep it.
- **Full restore is command-line only.**
- **A damaged upload does not fail the backup.** A file that cannot be read or decrypted is left
  out, loudly (`WARNING:`, `unreadable=` in the result line, the red box in Settings), so that one
  bad file does not block every backup of everything else. Such a backup is incomplete.
- **Files with names a restore would refuse are left out the same way:** hidden files and
  folders, `*.tmp` and `*.rot`, names with control characters, and one of two names that differ
  only in upper/lower case or Unicode form (`A.jpg` and `a.jpg`), and paths too long for the
  archive (a file name over 100 bytes, or the folders in front of it over 155). The names BlackVault gives its
  own uploads are not like that; this is about files placed in the uploads folder by hand. Only `uploads/images` and
  `uploads/documents` are backed up.
- **"Already running" can outlast a crash.** The lock is a file in the backup folder that a
  running backup refreshes every 30 seconds. If a backup is killed (a crash, a restart of the
  machine), the next one can answer "already running" for up to 5 minutes although nothing runs.
  The lock only prevents two backups from loading the machine at once; a backup's correctness
  does not depend on it.
- **Windows: `restore.bat` cannot catch Ctrl-C or a closed window.** `restore.sh` stops the
  restore container and shows the recovery text when it is interrupted; on Windows the recovery
  file is all there is. Do not interrupt a restore.
- **Windows: the typed prompts are not covered by automated tests.** `backup.bat` and
  `restore.bat` are tested with `--passphrase-file` and `--yes` only, and against a stand-in for
  Docker; typing the passphrase and `RESTORE` at a console is not.
- **Recovering files that are under another key needs that key.** See **Files encrypted with a
  different key**.

---

### Updating without losing data

> ⚠️ **From this release, `BLACKVAULT_PUBLIC_URL` is required.** For this one update, run
> `git pull` first and then `./update.sh` (Windows: `git pull`, then `update.bat`) — the new
> script asks for it. Pull first because the `update.sh` you already have predates the
> question, and it keeps running its old self after pulling, so it would restart a container
> that refuses to start. Updating any other way (e.g.
> `git pull && docker compose up -d --build`) without adding it to `.env` leaves a
> container that refuses to start.

> ⚠️ **BlackVault now requires an account.** After updating, every page redirects to
> `/setup` until you create the first admin — see **[Users and sign-in](#users-and-sign-in)**
> above. **For this one update**, the copy of `update.sh` / `update.bat` you already have
> predates the step that prints the setup token, so it won't show it to you. Get it from the
> log instead:
> ```bash
> docker compose logs blackvault | grep "Setup token"
> ```
> Windows: `docker compose logs blackvault | findstr /c:"Setup token"`. After this one update,
> the new script prints it automatically at every future update or install. Re-running the
> installer on an existing install won't show it either — it sees your `.env` already exists
> and prompts for nothing; use the log command above. Your inventory data is unchanged; only
> accounts are new.

An update never deletes anything in your data folder. (The first start of this release does
encrypt the uploaded files in it, in place — see **Encrypted Files** above, and rescue your
documents first.)

**Windows:** Double-click `update.bat` (for the update to this release: run `git pull` in the
BlackVault folder first, see above)

**Mac / Linux:**

```bash
./update.sh
```

For the update to this release only:

```bash
git pull
./update.sh
```

---

### Moving from SQLite to PostgreSQL

A one-way, verified copy: every table is copied, then every row is compared. **Your `vault.db` is
never modified or deleted.** It stays on disk as your rollback. Uploaded images and documents stay
where they are. Mac / Linux, run from the BlackVault folder. You need
[Node.js](https://nodejs.org/) 20.12 or newer for the copy step — Node 24 LTS is what BlackVault
ships and tests on, and Node 20 is past end of life.

When the copy is verified, the tool finishes the switch for you:
- it writes `data/db/.migrated`, a small record of what was copied, so BlackVault knows the
  `vault.db` still on disk is your rollback copy and not data you are missing;
- it switches `.env` to PostgreSQL. It saves the old one as `.env.pre-migration` first and
  changes only the four database lines.

If anything fails, nothing is switched, and BlackVault stays on SQLite.

**Step 1: Bring your SQLite install up to the current version first.** The copy tool checks
that `vault.db` has every current migration and stops with an error if it does not. Update, then
open BlackVault once and confirm your records are there:

```bash
./update.sh
```

(`update.sh` keeps a SQLite install on SQLite.)

**Step 2: Back up first.** In BlackVault go to **Settings → Backup** and save a backup, then
also copy the whole `data` folder and `.env` (see *Backing up your data* above).

**Step 3: Stop BlackVault:**

```bash
docker compose down
```

**Step 4: Give the new database a password.** This adds one line to `.env` and changes nothing
else. BlackVault keeps using SQLite until the copy is verified:

```bash
grep -q '^BLACKVAULT_POSTGRES_PASSWORD=.' .env ||
  printf '\nBLACKVAULT_POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
```

(The leading newline keeps it on its own line even if `.env` does not end with one. A blank line
in `.env` is harmless.)

**Step 5: Start only the database.** It is published on this machine only (127.0.0.1:55432)
for the copy:

```bash
docker compose -f docker-compose.yml -f docker-compose.migrate.yml up -d --wait db
```

**Step 6: Prepare the copy tool.** This installs dependencies and creates the empty tables:

```bash
npm ci && npm run db:generate
PW="$(grep '^BLACKVAULT_POSTGRES_PASSWORD=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r"')"
DATABASE_URL="postgresql://blackvault:$PW@127.0.0.1:55432/blackvault" \
  npx prisma migrate deploy --schema prisma/postgres/schema.prisma
```

(`tr` drops a Windows line ending or quotes around the value. `DATABASE_URL` here is Prisma's
own setting for this one command, not a `.env` line.)

**Step 7: Dry run.** It prints how many rows each table has. Nothing is written, not even `.env`:

```bash
npm run migrate:to-postgres -- --dry-run
```

It reads `DATA_DIR` and `BLACKVAULT_POSTGRES_PASSWORD` from `.env`, so it finds your `vault.db`
and the database from Step 5 without any other settings. (To copy somewhere else, give it
`POSTGRES_URL=... npm run migrate:to-postgres`, and `SQLITE_URL=file:...` for another source.
These are arguments for that one command, not `.env` settings. A `DATABASE_URL` in your shell is
ignored.) The first lines say whether `.env` will be
switched after the copy. It will be if the copy goes into this install's own database.

**Step 8: Real run.** It copies everything and then verifies it. It must end with
`VERIFIED: all 23 models match (<N> rows). The source SQLite database was not modified.`, followed by `Wrote .../data/db/.migrated` and
`Switched /your/path/.env to PostgreSQL (backup: /your/path/.env.pre-migration):` and the new
lines it wrote (the password is shown as `****`). If it reports a mismatch, the copy is rolled back,
`.env` is left alone, and you are still on SQLite. Stop there, and open an issue.

```bash
npm run migrate:to-postgres
```

**Step 9: Start BlackVault on PostgreSQL:**

```bash
docker compose up -d --build
```

This also closes the temporary database port from Step 5. Check that your records are there.

If the tool says it **could not** switch `.env` (for example because `data/db` is owned by the
container on Linux), it leaves no `.migrated` behind and prints the exact lines to add to `.env`
and the `.migrated` file to create. Add the lines first, then create `.migrated`, then run
Step 9.

Running the tool again on a migrated install is refused, because `data/db/.migrated` exists.
`--force` overrides that. Only use it if you know why.

**Rolling back:** run `docker compose down`, then put the old `.env` back with
`cp .env.pre-migration .env`, and run `docker compose up -d --remove-orphans`. Your `vault.db` is
exactly as you left it, but anything added while on PostgreSQL is not in it. Delete
`data/db/.migrated` too, so a later migration is not refused.

---

### Moving to a new machine

**Step 1 —** Stop BlackVault on the old machine (see *Stopping and Starting* above), then copy
your `data` folder **and `.env`** to the new machine (USB drive, network share, etc.). On Linux
with PostgreSQL, use `sudo cp -a` (see *Backing up your data*): `data/postgres` is owned by the
database container. Alternatively, save an in-app backup (**Settings → Backup**) and restore it
on the new machine after installing, copying `data/uploads` across for your images and
documents. Copy `secrets/blackvault_encryption_key` across too, into the new folder's
`secrets/` before running the installer (an existing key file is kept as it is):
the uploaded files are encrypted with it, and BlackVault refuses to start on files encrypted
with a different key.

**Or move with a full backup, and no key file:** make a full backup on the old machine, install
BlackVault on the new one and let it start once, then copy the `.bvb` file into the new
machine's backup folder and run `./restore.sh` (see **Restoring a full backup**). The new
install keeps its own key. Accounts and settings are not in a backup: set them up again.

**Step 2 —** Download and extract BlackVault on the new machine

**Step 3 —** Run the installer (`install.bat` or `install.sh`) — when it asks where your data is, point it at the folder you copied

---

### If two data directories exist

This can happen if the installer was run from different locations, or if `docker compose up` was run manually at some point. **No data was deleted** — both databases still exist.

**Step 1 —** Download [DB Browser for SQLite](https://sqlitebrowser.org/) (free) and open each `vault.db` file to see which one has your records.

**Step 2 —** Open `.env` in the project folder and set `DATA_DIR` to the correct path:

```
DATA_DIR=C:\Users\yourname\BlackVault\data
```

**Step 3 —** Restart:

```bash
docker compose down
```

```bash
docker compose up -d
```

---

## Notes

- All data is stored locally on your machine — nothing leaves your network
- No cloud connection is required or used
- BlackVault has real user accounts (admin-invited, no self-registration or email) but no
  two-factor authentication — keep it off the open internet unless it's behind an
  authenticating reverse proxy or a VPN (see [Running behind a reverse proxy](#running-behind-a-reverse-proxy))
- Intended for private, local use only — do not expose it to the public internet

---

## Local Development

Run a local copy without Docker:

```bash
./dev.sh
```

It installs dependencies, writes a local `.env`, generates the Prisma client, applies every
migration, and starts the dev server on http://localhost:3000. The local `.env` uses
`DATABASE_URL` (Prisma's name); Docker installs use `BLACKVAULT_DATABASE_URL`, so the two never
mix. `./dev.sh` refuses to add to a `.env` that has a `DATA_DIR` line, because that is a Docker
install's `.env`: use a separate clone for development.

```bash
./dev.sh --fresh     # rebuild the local database from the full migration history, then seed
./dev.sh --studio    # browse the local database in Prisma Studio
./dev.sh --help      # all options
```

The local database is applied with `prisma migrate deploy` — the same path production uses. Don't
use `prisma db push`: it syncs the schema without recording migrations, and the next schema change
will then demand a database reset. If `./dev.sh` reports a migration error on an old local
database, run `./dev.sh --fresh`.

## License

MIT License. See [LICENSE](LICENSE) for details.
