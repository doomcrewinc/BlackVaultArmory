# Follow-up Fixes Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the small, verified leftovers from specs 2a, 2b, 3a, 3c and the item-categories epic in one branch, without changing any feature's design.

**Architecture:** Seven independent groups of bounded fixes to existing code. Each group is one task with its own tests and review. No new subsystem, no schema change, no new dependency.

**Tech Stack:** Next.js 16, Prisma 5.22 (SQLite `connection_limit=1` / PostgreSQL 17), Vitest 2, Bash and Windows batch, Docker Compose, GitHub Actions (Linux Docker job, Windows harness).

**Spec:** There is no spec file. The approved design is the in-chat list of 2026-10-03, verified against `develop` at `8b6bc82`. Evidence for every item (file and line) is in the "Verified state" table at the end of this plan. Background: `docs/superpowers/specs/2026-10-02-full-backups-design.md` (restore and backup behaviour), `2026-09-27-accounts-design.md` (setup token), `2026-09-29-audit-log-design.md` (audit search and export).

## Global Constraints

- Branch `fix/followups-batch` off `develop`. PR with `gh pr create --repo doomcrewinc/BlackVaultArmory --base develop`. Never merge.
- No behaviour change beyond what a task states. No new dependency. No schema change.
- Crypto code lives only in `src/lib/encryption/core.mjs`. Routes do uploads I/O through `src/lib/files/storage.ts`.
- Env keys use the `BLACKVAULT_` prefix. The wrappers never assign `DATA_DIR`, `PORT` or `COMPOSE_*`.
- A secret (passphrase, key) never appears in argv, an environment, a log or an error message.
- `.bat` files stay CRLF (`.gitattributes`); `git diff --stat` on a `.bat` shows only intended lines. Stage explicit paths; never `git add -A`.
- The files under `scripts/fixtures/` are frozen copies of old releases. Do not edit them.
- Do not edit `backup.bat`/`restore.bat`'s shared PowerShell launch line unless a task says so; a test pins the two copies identical.
- Wrap every docker command in `timeout`. Never touch the `certwarden` container, `prisma/prisma/dev.db`, or the repo's own `data/` and `uploads/` folders.
- TDD: failing test, see it fail, fix, see it pass. For each new guard, an executed injection proof (remove the guard, the new test fails, restore byte-identical).
- Comments describe the code as it is. No task numbers, review labels or "fix round" in shipped source.

## Review Focus

1. **An install that is mid-recovery is started by hand.** With a leftover restore marker the app must refuse to start and name the RECOVERY file, but a marker from a restore that was rolled back and cleared must not block. Test owner: Task 3.
2. **`.env` written by hand.** `export KEY=value`, quoted values, spaces around `=`, a commented-out duplicate above the real line. The installers must read the same value Compose would. Test owner: Task 4.
3. **A container that is `unhealthy` or `starting`.** The installers must not report success. Test owner: Task 4.
4. **Audit search for a literal `%` or `_`.** It must match only rows containing that character, on SQLite and PostgreSQL. Test owner: Task 5.
5. **A large audit log exported.** Memory must not grow with the row count. Test owner: Task 5.

---

### Task 1: Backup records are read in one transaction

**Files:** Modify `src/lib/backup/records.ts`; test in `src/lib/backup/full-backup.real-db.test.ts` or a new `src/lib/backup/records.real-db.test.ts`.

**Interfaces:** Produces the same exported function and return shape as today (the JSON backup route and the full-backup engine both call it). No caller changes.

- [ ] Write a failing real-database test (SQLite `connection_limit=1`; PostgreSQL when `ENCRYPTION_REAL_DB_PG_URL` is set): while the records are being collected, a second writer inserts a parent row and a child row that references it. The collected set must contain both or neither. Drive the interleaving deterministically (a hook between two table reads), not with timing.
- [ ] Run it and confirm it fails with the child present and the parent absent.
- [ ] Read every backup model inside one `prisma.$transaction`. On PostgreSQL use isolation level `RepeatableRead`. On SQLite a transaction already gives one consistent view; keep the reads sequential, since a second query path inside a transaction deadlocks with `connection_limit=1`.
- [ ] Confirm the test passes, the JSON backup route's tests and the full-backup tests still pass, and the actor for audit purposes is still resolved before the transaction opens.
- [ ] Injection: remove the transaction wrapper, the new test fails; restore.
- [ ] Commit: `fix(backup): read the backup records in one transaction`.

### Task 2: Restore wrapper hardening

**Files:** Modify `restore.sh`, `restore.bat`, `scripts/db-snapshot.sh`; tests in `scripts/full-restore-wrapper.test.ts` and the Windows harness `scripts/ci/windows/Test-WindowsInstallers.ps1`.

- [ ] **Lock before stop.** `restore.sh` stops the app at `restore.sh:429` without looking at the full-backup lock, so a button backup in progress is killed and the restore then fails "already running" after a long snapshot. Before `compose stop`, ask the running app container whether a full backup holds the lock (the lock file is `/app/backups/.full-backup.lock`; reuse the engine's own liveness rule through the bundled CLI or `snapshot-restore.sh`-style one-off, do not re-implement staleness in shell). If one is running: exit 1 before anything is stopped, with a message that says a backup is running and to retry when it finishes. Test with the docker stub: lock held, exit 1, no `stop` call.
- [ ] **RECOVERY file reaches the disk.** After writing `restore-<stamp>-RECOVERY.txt` (`restore.sh:463`), flush it and its folder to disk in a way that works on Linux and macOS (bash 3.2). Test statically that the flush follows the write.
- [ ] **PostgreSQL manual commands carry a state test.** In the recovery text of `restore.sh` and `restore.bat`, the PostgreSQL rollback chain is guarded only by a sentence. Prefix the chain with a command that runs `snapshot-restore.sh state` and continues only when it prints `started`, so pasting the chain after a finished restore changes nothing. Extend the existing "run the printed commands exactly as printed" test with a PostgreSQL stub case in each state.
- [ ] **`restore.bat` handoff write.** The `ready=1` append (`restore.bat:400-402`) is not checked. Verify the line is in the handoff file (`findstr`) before the child exits 0; if it is not, exit non-zero before the restore runs and say so. Add a harness scenario that makes the append fail.
- [ ] **macOS wording.** `scripts/db-snapshot.sh` prints "delete it with sudo" on macOS. Print the `sudo` form only on Linux. Test with a stubbed `uname`.
- [ ] Injection proofs for the lock check and the handoff check. `bash -n restore.sh`. Commit per fix.

### Task 3: Startup guard, backup-folder warning, image user

**Files:** Modify `src/lib/files/startup.ts` (or the startup module that already refuses on a bad key, whichever owns "refuse to start"), `scripts/docker-entrypoint.sh`, `Dockerfile`; tests beside each, plus `scripts/docker-entrypoint-backups.test.ts`.

- [ ] **Refuse to start on a leftover restore marker.** A restore engine that died leaves `uploads/.restore-<stamp>.db-started`. Today nothing stops `docker compose up -d` on that half-restored install. At startup, if any such marker exists under the uploads root, refuse to start with a message that names the marker, says a restore did not finish, and points at `backups/restore-<stamp>-RECOVERY.txt` on the host and at README "Restoring a full backup". Use the same refusal mechanism and exit behaviour as the existing encryption-key refusals. The one-off containers the restore and rollback use must still run: they do not go through app startup, so confirm that and add a test that the rollback path is unaffected.
- [ ] Tests (real filesystem): marker present, startup refuses with the stamp in the message; no marker, startup proceeds; a `.restore-<stamp>` staging folder without a marker does not refuse. Injection: remove the check, the first test fails.
- [ ] **Warn when `/app/backups` is not a mount.** In the entrypoint, after preparing the folder, if `/app/backups` is not a mount point, log one warning that full backups will be lost when the container is recreated and name `BLACKVAULT_BACKUP_DIR`. Never fail startup for it. Test with the existing entrypoint stub harness.
- [ ] **Image user group.** `Dockerfile:64-65` creates `nextjs` without the `nodejs` group, so `exec -u nextjs` runs as `nogroup`. Create the user with primary group `nodejs` (gid 1001). Check nothing else in the Dockerfile or entrypoint depends on the old group. Extend the Linux Docker CI script with one assertion: `id nextjs` inside the image shows gid 1001.
- [ ] README: one sentence under "Restoring a full backup" about the refusal. Commit per fix.

### Task 4: Installer fixes

**Files:** Modify `scripts/compose-provider.sh`, `install.sh`, `update.sh`, `install.bat`, `update.bat`, `scripts/setup-token.sh`; tests in `scripts/compose-provider.test.ts`, `scripts/setup-token.test.ts`, `scripts/installers-encryption.test.ts`, and the Windows harness.

- [ ] **`.env` forms.** `env_value` (`scripts/compose-provider.sh:18-22`) uses `grep "^KEY="`, so `export KEY=value` is missed. Make it read what Compose would: optional leading `export`, optional spaces around `=`, one layer of matching single or double quotes removed, the last assignment wins, commented lines ignored. Table-driven test over those forms (Review Focus 2). Mirror the rule in the batch twin if one exists; say so if none does.
- [ ] **`healthy` matches `unhealthy`.** `install.sh:256`, `update.sh:300` (`grep -q "healthy"`), `install.bat:330`, `update.bat:295` (`findstr /i "healthy"`). Match the exact status word. Tests: stub status `unhealthy` and `starting`, the installer does not report success (Review Focus 3). Windows harness scenarios for both `.bat` files.
- [ ] **Stale setup token.** `scripts/setup-token.sh` prints the last `[auth] Setup token:` log line even when an admin already exists (a no-op update keeps the container and its old log). Find a signal the app already exposes that an admin exists; if none exists, have the app log a line when the first admin is created and have the script show a token only when no such line follows it. Test both orders of log lines.
- [ ] **`;` in the typed port.** `install.bat:585`, `update.bat:518` use `for /f "delims=..."` with the default `eol=;`, so a value starting with `;` skips the character check. Reject `;` anywhere in the value, as `backup.bat` does. Harness scenarios. `rotate-key.bat` runs the pattern only on script-generated hex; leave it and note why in the report.
- [ ] Injection proofs for the `healthy` match and the `;` guard. Commit per fix.

### Task 5: Audit search and export

**Files:** Modify `src/lib/db/text-search.ts`, `src/lib/audit/query.ts`, the audit CSV export route and `src/lib/audit/csv.ts`; tests in `src/lib/audit/query.real-db.test.ts`, `src/lib/audit/csv.test.ts`, the export route's test.

- [ ] **Wildcards.** First find out, with a failing real-database test on SQLite and PostgreSQL, whether a search for a literal `%` or `_` matches rows that do not contain it (Review Focus 4). If Prisma already escapes them, keep the test as a pin, change nothing, and record that. If not, escape `%`, `_` and the escape character in `containsInsensitive` for both providers and check every other caller of the helper.
- [ ] **Streaming export.** The CSV export collects every row into one array and one string. Page through the rows with a stable order and a cursor, and stream the response body, keeping the formula-guard in `csvCell`, the redaction rules and the admin check exactly as they are. Test: an export of several thousand seeded rows yields the same bytes as the old implementation for a small fixture, and the route never holds more than one page (assert on the page size requested from the database, not on timing) (Review Focus 5).
- [ ] Commit per fix.

### Task 6: Small UI gaps

**Files:** Modify `src/app/gear/page.tsx`, `src/app/prep/page.tsx`, the export renderers under `src/app/api/exports/` or `src/lib/exports/` that list firearms, `src/components/settings/FullBackupPanel.tsx`; component and route tests beside each.

- [ ] **`/gear` counts.** `/prep` shows per-category counts through `fetchCategoryCounts`; `/gear` shows none. Show the counts on `/gear` the same way, reusing the same loader.
- [ ] **`/prep` flash of `0`.** `prep/page.tsx:11,41` renders `0` before the fetch returns. Render no number until the counts have loaded. Component test for the loading state on both pages.
- [ ] **`mgRegistry` in exports.** The field is stored and shown on the detail page but reaches no export. Add it to the firearm exports that already carry the NFA class column, with a header that matches the detail page's label. Update the export tests.
- [ ] **Backup panel units.** `FullBackupPanel.tsx` divides by 1024 and labels the result MB/GB. Label them MiB/GiB. Update the component test.
- [ ] Check each page at 390 px width in the component test where the existing tests do. Commit per fix.

### Task 7: Docs, comments and CLAUDE.md

**Files:** Modify `README.md`, `CLAUDE.md`, shipped source files that carry process comments; no behaviour change.

- [ ] **README.** Restore step 1 shows a copy command for Linux only: add the macOS and Windows forms. The passphrase-file PowerShell example (`README.md:1414`) uses `Read-Host` in the clear: use `-AsSecureString` and convert, and say the example is not exercised in CI. The "run `update.sh` twice" sentence (`README.md:860`): `update.sh:190-209` now re-executes itself after a pull, so say that only the first upgrade from a release older than that change needs a second run. Record the file and line that backs each sentence.
- [ ] **Process comments.** Remove references to the build process from shipped, non-test source: task numbers, "fix round", review labels (`I1`, `M3`, `R24`), "controller ruling". Keep the technical content of each comment; rewrite it to state what the code does and why. Find them with `ug -n "Task [0-9]|fix round|controller|review [A-Z][0-9]|\bR[0-9]{1,2}\b" --include='*.ts' --include='*.mjs' --include='*.sh' --include='*.bat' --include='Dockerfile'` excluding `*.test.*`, `docs/` and `scripts/fixtures/`, and judge each hit: a ruling number in a comment goes, a spec section reference may stay. `.bat` edits stay CRLF.
- [ ] **CLAUDE.md.** The root file is the finished V1 task brief. Replace it with a short accurate project guide: what the app is, how to run and test it (`npm run dev`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build:scripts`, `npm run db:deploy`), the two database providers, where specs and plans live, the branching rule (`develop` is the default branch, feature branches `feat/` `fix/` `chore/` `docs/`, PRs with `--repo doomcrewinc/BlackVaultArmory --base develop`), the `.bat` CRLF rule, and the standing rules from this plan's Global Constraints that apply to all work. Verify every command against `package.json` before writing it.
- [ ] Run lint, typecheck and the static tests that pin script text. Commit per part.

---

## Verified state (develop at `8b6bc82`, 2026-10-03)

| Item | Evidence |
|---|---|
| Backup records not in one transaction | `src/lib/backup/records.ts:28-35` |
| Restore stops the app without a lock check | `restore.sh:429` |
| RECOVERY file not flushed | `restore.sh:463` |
| PostgreSQL manual rollback guarded by text | `restore.sh:333-349`, `restore.bat:599-609` |
| `restore.bat` handoff write unchecked | `restore.bat:400-402` |
| No startup guard for a restore marker | marker referenced only in `full-restore.ts`, `scripts/entry/full-restore.ts`, `snapshot-restore.sh` |
| No warning when `/app/backups` is not a mount | `scripts/docker-entrypoint.sh:91-110` |
| `nextjs` without the `nodejs` group | `Dockerfile:64-65` |
| `export KEY=` missed | `scripts/compose-provider.sh:18-22` |
| `healthy` matches `unhealthy` | `install.sh:256`, `update.sh:300`, `install.bat:330`, `update.bat:295` |
| Stale setup token | `scripts/setup-token.sh:15-26`, `update.sh:325` |
| `;` in the typed port | `install.bat:585`, `update.bat:518` |
| LIKE wildcards passed raw | `src/lib/db/text-search.ts`, used by `src/lib/audit/query.ts:3` |
| `/gear` has no counts; `/prep` flashes `0` | `src/app/gear/page.tsx`, `src/app/prep/page.tsx:11,41` |
| `mgRegistry` in no export | only `api/firearms` routes and `app/vault/[id]/page.tsx:251` |
| Panel units | `src/components/settings/FullBackupPanel.tsx` |
| README items | `README.md:860`, `README.md:1414`, restore step 1 |

Left out on purpose: two-factor login (its own feature), `restore.bat` asking a container for the restore state (not a contained change), manual checks (rich PDF in Firefox, the Windows console checklist), and the 16 baselined TypeScript errors (they belong to the Dependabot work).
