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
docker compose exec blackvault node scripts/admin-reset-link.mjs <username>
```

It prints a one-time password reset link, valid 24 hours. If that admin account was disabled
or demoted, add `--promote` to also restore admin access:

```bash
docker compose exec blackvault node scripts/admin-reset-link.mjs <username> --promote
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

### Mobile Access is now an admin-only switch

Settings → **Mobile Access (Local Network)** has an on/off switch for direct access, with a
confirmation step either way and a plain-HTTP warning before turning it on. Only admins can
change it; a plain user sees the same section read-only. See **Mobile Access (Same Network)**
below for what direct access does.

### Recovery: locked out as the only admin

If the only admin forgets their password, or their account gets disabled or demoted somehow,
run this inside the container:

```bash
docker compose exec blackvault node scripts/admin-reset-link.mjs <username>
```

It prints a one-time reset link, valid 24 hours. Add `--promote` to also make that user an
active admin again (clearing any disabled state):

```bash
docker compose exec blackvault node scripts/admin-reset-link.mjs <username> --promote
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

**Easiest, works for both databases, safe while running:** in BlackVault go to
**Settings → Backup** and save a backup. It downloads a JSON file with every record. Keep it
together with a copy of `data/uploads` (your images and documents) and `.env`.

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
cp -r ./data ~/blackvault-backup-$(date +%Y%m%d)
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

Your data folder is never touched during an update.

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
on the new machine after installing, copying `data/uploads` across for your images.

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
