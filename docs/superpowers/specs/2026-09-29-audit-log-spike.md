# Audit Log — Spike: request context and transaction joining

**Date:** 2026-09-29
**Status:** Done — GATE PASSED (candidate A is atomic and deadlock-free on SQLite `connection_limit=1` and PostgreSQL 17)
**For:** `docs/superpowers/specs/2026-09-29-audit-log-design.md`, section "Capture mechanics"
**Versions:** `prisma` / `@prisma/client` 5.22.0, Next.js 16.1.6, Node 24.19.0

All probe code was scratch and has been deleted; the method is described for each probe so it can be
rebuilt. Raw output is copied verbatim (long Prisma messages and row JSON trimmed with `...`).

## Summary

| Question | Answer |
|---|---|
| `cookies()` / `headers()` readable inside a `$allOperations` hook, write directly in a route handler | ✅ yes |
| … inside a `prisma.$transaction(async tx => …)` callback | ✅ yes (readable) — but see next row |
| `getCurrentUser()` called inside the hook while an interactive tx is open (SQLite limit 1) | ❌ blocks until the tx's 5 s timeout, then P2028 — its session lookup needs the one connection the tx holds |
| Is `getCurrentUser()` (React `cache`) memoised per request in a route handler? | ❌ no — a call made before the tx did not prevent the in-tx call from hitting the DB (probe R5) |
| `cookies()` / `headers()` in `instrumentation.register()` | throws `` `cookies` was called outside a request scope`` → maps to `system` ✅ |
| What does `query(args)` do inside an interactive tx? | runs on the tx connection (rolled back with it) ✅ |
| Naive audit write via the base client from the hook | ❌ deadlock-until-timeout (SQLite / PG pool 1), non-atomic always |
| Hook opens `base.$transaction(async tx => query(args) …)` | ❌ `query(args)` is NOT on the new tx; deadlock-until-timeout at pool 1, non-atomic at pool 5 |
| Documented batch form `base.$transaction([query(args), auditInsert])` | ✅ atomic for single ops outside a tx; ❌ inside a caller's itx (ignores it — documented limitation) |
| **Candidate A** — AsyncLocalStorage tx context + wrapped `$transaction` + re-dispatch | ✅ atomic commit, atomic rollback, no deadlock, concurrency-safe, on both providers |

## Docs consulted (context7, library `/prisma/web`)

- **"Transactions in query extensions"** (blog `client-extensions-preview`, RLS example): a query hook may
  put `query(args)` into a batch transaction —
  `const [, result] = await prisma.$transaction([prisma.$executeRaw\`SELECT set_config(...)\`, query(args)])`.
  Probed as candidate B.
- **Documented limitation** (docs `orm/.../client-extensions/shared-extensions`, GitHub prisma#20678):
  *"Client extensions that reference a PrismaClient and call a client-level method (like `$queryRaw`)
  will ignore the current transaction if triggered inside an interactive or batched transaction. They
  open a new connection instead."* This is exactly what N1, N2 and "B inside caller tx" show.
- No documented way for a query hook to obtain the surrounding interactive-transaction client. The
  runtime passes an undocumented `__internalParams` (`transaction: {kind: "itx" | "batch", …}`) to the
  hook (`node_modules/@prisma/client/runtime/library.js`, function `La`); **not used** — candidate A
  needs no Prisma internals.

## Probe method (transaction joining)

A vitest file (scratch) against:
- **SQLite:** temp DB migrated with `prisma migrate deploy --schema prisma/sqlite/schema.prisma`, client
  `.prisma/client-sqlite` with `datasourceUrl: file:<tmp>/t.db?connection_limit=1`.
- **PostgreSQL:** `docker run -d --rm --name bv-spike-pg -e POSTGRES_PASSWORD=scratch -p 55433:5432
  postgres:17-alpine`, migrated with `prisma migrate deploy --schema prisma/postgres/schema.prisma`,
  client `@prisma/client`, run at `connection_limit=1` and `connection_limit=5`. Container removed after.
- `AuditEvent` does not exist yet: a throwaway table created with raw SQL,
  `"SpikeAudit"(id INTEGER PRIMARY KEY AUTOINCREMENT | SERIAL, model TEXT NOT NULL, op TEXT NOT NULL,
  note TEXT NOT NULL)`, written with `client.$executeRaw`. Passing `note = NULL` injects an
  audit-insert failure (NOT NULL violation) to test that the change rolls back with it.
- The write target is the real `Supply` model. Every Prisma call was raced against a 15 s timer.
- Output format: `r` = outcome of the call (`ok`, `ms`, error code + last message line), `after` =
  committed row counts `{supply, audit}` read afterwards.

## Probes — transaction joining

### P1 — `query(args)` inside a caller's interactive tx (pass-through hook)
Hook `({args, query}) => query(args)`; `ext.$transaction(async tx => { await tx.supply.create(...); throw })`.
```
PROBE[sqlite limit=1]   P1 throw-after-create {"r":{"ok":false,"ms":3,"err":" boom"},"after":{"supply":0,"audit":0}}
PROBE[postgres limit=1] P1 throw-after-create {"r":{"ok":false,"ms":6,"err":" boom"},"after":{"supply":0,"audit":0}}
PROBE[postgres limit=5] P1 throw-after-create {"r":{"ok":false,"ms":2,"err":" boom"},"after":{"supply":0,"audit":0}}
```
**Verdict ✅** `query(args)` for an operation issued on the tx client runs on the tx connection.

### N1 — naive: hook writes the audit row with `base.$executeRaw` after `query(args)`, inside a caller itx
```
PROBE[sqlite limit=1]   N1 in-tx {"r":{"ok":false,"ms":5005,"err":"P2028 Transaction API error: Transaction already closed: A commit cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5005 ms passed ..."},"after":{"supply":0,"audit":1}}
PROBE[postgres limit=1] N1 in-tx {"r":{"ok":false,"ms":5015,"err":"P2028 ... expired transaction. The timeout for this transaction was 5000 ms ..."},"after":{"supply":0,"audit":1}}
PROBE[postgres limit=5] N1 in-tx {"r":{"ok":true,"ms":14},"after":{"supply":1,"audit":1}}
```
**Verdict ❌** Pool 1: blocks until the tx times out; the change is lost and the audit row commits alone.
Pool 5: no block, but the audit row is on another connection — not atomic.

### N2 — naive: hook wraps a single op as `base.$transaction(async tx => { r = await query(args); await audit(tx) })`
```
PROBE[sqlite limit=1]   N2 single-op {"r1":{"ok":false,"ms":5012,"err":"P2028 Invalid `prisma.$executeRaw()` invocation: | Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction ..."},"after":{"supply":1,"audit":0}}
PROBE[sqlite limit=1]   N2 single-op audit-fails (atomic iff supply=0) {"r2":{"ok":false,"ms":5008,"err":"P2028 ..."},"after":{"supply":1,"audit":0}}
PROBE[postgres limit=1] N2 single-op {"r1":{"ok":false,"ms":5014,"err":"P2028 ..."},"after":{"supply":1,"audit":0}}
PROBE[postgres limit=1] N2 single-op audit-fails {"r2":{"ok":false,"ms":5020,"err":"P2028 ..."},"after":{"supply":1,"audit":0}}
PROBE[postgres limit=5] N2 single-op {"r1":{"ok":true,"ms":13,...},"after":{"supply":1,"audit":1}}
PROBE[postgres limit=5] N2 single-op audit-fails (atomic iff supply=0) {"r2":{"ok":false,"ms":15,"err":"P2010 ... Code: `23502`. Message: `Failing row contains (67, Supply, create, null).`"},"after":{"supply":1,"audit":0}}
```
**Verdict ❌** `query(args)` is bound to the original (non-tx) call, so it does not join a transaction
opened inside the hook. Pool 1: waits for the connection the new tx holds → tx expires. Pool 5: change
commits even when the audit insert fails.

### B — documented batch form `base.$transaction([query(args), base.$executeRaw\`INSERT …\`])`
```
PROBE[sqlite limit=1]   B single-op {"r":{"ok":true,"ms":2,...},"after":{"supply":1,"audit":1}}
PROBE[sqlite limit=1]   B single-op audit-fails (atomic iff supply=0) {"rf":{"ok":false,"ms":2,"err":"P2010 ... Code: `1299`. Message: `NOT NULL constraint failed: SpikeAudit.note`"},"after":{"supply":0,"audit":0}}
PROBE[sqlite limit=1]   B inside caller tx that throws (atomic iff 0/0) {"ri":{"ok":false,"ms":5005,"err":" boom"},"after":{"supply":1,"audit":1}}
PROBE[postgres limit=1] B single-op {"r":{"ok":true,"ms":7,...},"after":{"supply":1,"audit":1}}
PROBE[postgres limit=1] B single-op audit-fails {"rf":{"ok":false,"ms":12,"err":"P2010 ... `23502` ..."},"after":{"supply":0,"audit":0}}
PROBE[postgres limit=1] B inside caller tx that throws {"ri":{"ok":false,"ms":5016,"err":" boom"},"after":{"supply":1,"audit":1}}
PROBE[postgres limit=5] B single-op {"r":{"ok":true,"ms":7,...},"after":{"supply":1,"audit":1}}
PROBE[postgres limit=5] B single-op audit-fails {"rf":{"ok":false,"ms":4,"err":"P2010 ... `23502` ..."},"after":{"supply":0,"audit":0}}
PROBE[postgres limit=5] B inside caller tx that throws {"ri":{"ok":false,"ms":7,"err":" boom"},"after":{"supply":1,"audit":1}}
```
**Verdict ❌ as a whole.** Atomic for single ops, but inside a caller's interactive tx the batch ignores
it (documented limitation #20678): pool 1 blocks 5 s, and in every configuration the change and its
audit row are committed even though the caller's transaction threw. Also cannot read "before" data
inside the same transaction.

### A — AsyncLocalStorage tx context + wrapped `$transaction` + re-dispatch

Shape probed (the Decision section below is the build spec):
- `als = new AsyncLocalStorage<{ tx, inner? }>()`.
- The exported client is a `Proxy` over `base.$extends(...)` whose `$transaction` is replaced:
  - callback form: if a store with `tx` is already active → call the callback with that `tx`
    (flatten); else `rawTx(tx => als.run({ tx }, async () => await fn(tx)), opts)`.
  - array form: converted to an interactive tx that awaits each item in order inside the store.
- Hook for audited writes:
  - `store.inner` set → this call is on the tx connection: `r = await query(args)`, write the audit
    row with `store.tx`, return `r` (inside `als.run({...store, inner:false})`).
  - `store.tx` set, not inner (caller used `tx.x.op` or, by mistake, the outer `prisma.x.op`) →
    `als.run({...store, inner:true}, async () => await store.tx[delegate][op](args))`.
  - no store (single op outside a tx) → `wrappedTx(async tx => als.run({tx, inner:true}, async () => await tx[delegate][op](args)))`.

**First run: OOM (infinite recursion).** Cause: Prisma promises are lazy. `als.run(store, () => tx.x.op(args))`
returns the un-started `PrismaPromise`; it executes on `.then`, after `als.run` has returned, so the
re-dispatched hook runs *outside* the store and re-dispatches forever. **Fix (load-bearing):** always
`als.run(store, async () => await tx.x.op(args))`.

After the fix, SQLite `connection_limit=1`:
```
A1 single create (expect 1/1)                                      ok 2ms       {"supply":1,"audit":1}
A2 single create, audit insert fails (expect err, 0/0)             P2010 NOT NULL constraint failed: SpikeAudit.note   {"supply":0,"audit":0}
A3 itx two creates commit (expect 2/2)                             ok 1ms       {"supply":2,"audit":2}
A4 itx creates then throw (expect err, 0/0)                        " boom" 1ms  {"supply":0,"audit":0}
A5 itx using OUTER client by mistake then throw (0/0, no deadlock) " boom" 1ms  {"supply":0,"audit":0}
A6 array form commit (expect 2/2)                                  ok 1ms       {"supply":2,"audit":2}
A7 array form, audit fails (expect err, 0/0)                       P2010        {"supply":0,"audit":0}
A8 nested $transaction inside itx then throw (expect err, 0/0)     " boom" 0ms  {"supply":0,"audit":0}
A9 update/upsert/updateMany/delete/deleteMany in itx               ok 4ms       {"supply":1,"audit":6}
A10 5 single ops + tx(commit) + tx(throw) in parallel              {"statuses":["fulfilled"x6,"rejected"],"notes":["good:2","single:5"]}  {"supply":7,"audit":7}
A11 read inside itx via tx sees uncommitted row                    "count-inside=1" then {"supply":0,"audit":0}
A12 30 parallel single creates                                     0 rejected   {"supply":30,"audit":30}
A13 itx holding 3s + concurrent single op (default maxWait 2s)     ["ok","P2028 Transaction API error: Unable to start a transaction in the given time."]
A13b same, auto-wrap passes {maxWait:10000,timeout:10000}          ["ok","ok"]  {"supply":2,"audit":2}
A13-baseline NO extension, plain single op behind a 3s itx         ["ok","ok"]  {"supply":2,"audit":0}
```
PostgreSQL 17, `connection_limit=1` and `=5`: every A-row identical to SQLite (A1–A12 as expected, same
counts, A10 notes `["good:2","single:5"]`), except A13 at pool 5 is `["ok","ok"]` (a free connection).
Both vitest runs: `Tests 5 passed (5)`. Raw lines (row JSON in `v` trimmed to `...`):
```
PROBE[postgres limit=1] A A1 single create (expect 1/1) {"r":{"ok":true,"ms":9,"v":"{\"id\":\"cmund322v000daf617jpjv72x\",\"name\":\"a1\",..."},"after":{"ok":true,"ms":2,"v":"{\"supply\":1,\"audit\":1}"}}
PROBE[postgres limit=1] A A2 single create, audit insert fails (expect err, 0/0) {"r":{"ok":false,"ms":8,"err":"P2010 Invalid `prisma.$executeRaw()` invocation: | Raw query failed. Code: `23502`. Message: `Failing row contains (6, Supply, create, null).`"},"after":{"ok":true,"ms":2,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=1] A A3 itx two creates commit (expect 2/2) {"r":{"ok":true,"ms":6},"after":{"ok":true,"ms":2,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=1] A A4 itx creates then throw (expect err, 0/0) {"r":{"ok":false,"ms":7,"err":" boom"},"after":{"ok":true,"ms":1,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=1] A A5 itx using OUTER client by mistake then throw (expect err, 0/0, no deadlock) {"r":{"ok":false,"ms":2,"err":" boom"},"after":{"ok":true,"ms":1,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=1] A A6 array form commit (expect 2/2) {"r":{"ok":true,"ms":7,"v":"[{\"id\":\"cmund324e000paf61p8iybm8m\",\"name\":\"a6a\",..."},"after":{"ok":true,"ms":2,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=1] A A7 array form, audit fails (expect err, 0/0) {"r":{"ok":false,"ms":4,"err":"P2010 Invalid `prisma.$executeRaw()` invocation: | Raw query failed. Code: `23502`. Message: `Failing row contains (14, Supply, create, null).`"},"after":{"ok":true,"ms":2,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=1] A A8 nested $transaction inside itx then throw (expect err, 0/0) {"r":{"ok":false,"ms":4,"err":" boom"},"after":{"ok":true,"ms":1,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=1] A A9 update/upsert/updateMany/delete/deleteMany in itx (expect 1 supply, audit 1+5=6) {"r":{"ok":true,"ms":22},"after":{"ok":true,"ms":3,"v":"{\"supply\":1,\"audit\":6}"}}
PROBE[postgres limit=1] A A10 concurrency: 5 single ops + tx(commit) + tx(throw) in parallel (expect supply 7, audit 7) {"r":{"ok":true,"ms":157,"v":"{\"statuses\":[\"fulfilled\",\"fulfilled\",\"fulfilled\",\"fulfilled\",\"fulfilled\",\"fulfilled\",\"rejected\"],\"notes\":[\"good:2\",\"single:5\"]}"},"after":{"ok":true,"ms":2,"v":"{\"supply\":7,\"audit\":7}"}}
PROBE[postgres limit=1] A A11 read inside itx via tx (hook pass-through) sees uncommitted row (expect 1) {"r":{"ok":false,"ms":7,"err":" count-inside=1"},"after":{"ok":true,"ms":2,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=1] A A12 30 parallel single creates (expect 30/30) {"r":{"ok":true,"ms":197,"v":"[]"},"after":{"ok":true,"ms":3,"v":"{\"supply\":30,\"audit\":30}"}}
PROBE[postgres limit=1] A A13 itx holding 3s + concurrent single op (default maxWait 2s) {"r":{"ok":true,"ms":3019,"v":"[\"ok\",\"P2028 Transaction API error: Unable to start a transaction in the given time.\"]"},"after":{"ok":true,"ms":3,"v":"{\"supply\":1,\"audit\":1}"}}
PROBE[postgres limit=1] A A13b same, auto-wrap with maxWait 10s (expect both ok) {"r":{"ok":true,"ms":3031,"v":"[\"ok\",\"ok\"]"},"after":{"ok":true,"ms":2,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=1] A A13-baseline NO extension: itx holding 3s + concurrent plain single op {"r":{"ok":true,"ms":3019,"v":"[\"ok\",\"ok\"]"},"after":{"ok":true,"ms":2,"v":"{\"supply\":2,\"audit\":0}"}}
PROBE[postgres limit=5] A A1 single create (expect 1/1) {"r":{"ok":true,"ms":7,"v":"{\"id\":\"cmund3sjl000d678td3vlpd02\",\"name\":\"a1\",..."},"after":{"ok":true,"ms":2,"v":"{\"supply\":1,\"audit\":1}"}}
PROBE[postgres limit=5] A A2 single create, audit insert fails (expect err, 0/0) {"r":{"ok":false,"ms":5,"err":"P2010 Invalid `prisma.$executeRaw()` invocation: | Raw query failed. Code: `23502`. Message: `Failing row contains (72, Supply, create, null).`"},"after":{"ok":true,"ms":2,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=5] A A3 itx two creates commit (expect 2/2) {"r":{"ok":true,"ms":10},"after":{"ok":true,"ms":3,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=5] A A4 itx creates then throw (expect err, 0/0) {"r":{"ok":false,"ms":8,"err":" boom"},"after":{"ok":true,"ms":1,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=5] A A5 itx using OUTER client by mistake then throw (expect err, 0/0, no deadlock) {"r":{"ok":false,"ms":4,"err":" boom"},"after":{"ok":true,"ms":1,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=5] A A6 array form commit (expect 2/2) {"r":{"ok":true,"ms":7,"v":"[{\"id\":\"cmund3sl7000p678tzmb5q8v6\",\"name\":\"a6a\",..."},"after":{"ok":true,"ms":1,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=5] A A7 array form, audit fails (expect err, 0/0) {"r":{"ok":false,"ms":4,"err":"P2010 Invalid `prisma.$executeRaw()` invocation: | Raw query failed. Code: `23502`. Message: `Failing row contains (80, Supply, create, null).`"},"after":{"ok":true,"ms":2,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=5] A A8 nested $transaction inside itx then throw (expect err, 0/0) {"r":{"ok":false,"ms":8,"err":" boom"},"after":{"ok":true,"ms":3,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=5] A A9 update/upsert/updateMany/delete/deleteMany in itx (expect 1 supply, audit 1+5=6) {"r":{"ok":true,"ms":33},"after":{"ok":true,"ms":2,"v":"{\"supply\":1,\"audit\":6}"}}
PROBE[postgres limit=5] A A10 concurrency: 5 single ops + tx(commit) + tx(throw) in parallel (expect supply 7, audit 7) {"r":{"ok":true,"ms":64,"v":"{\"statuses\":[\"fulfilled\",\"fulfilled\",\"fulfilled\",\"fulfilled\",\"fulfilled\",\"fulfilled\",\"rejected\"],\"notes\":[\"good:2\",\"single:5\"]}"},"after":{"ok":true,"ms":3,"v":"{\"supply\":7,\"audit\":7}"}}
PROBE[postgres limit=5] A A11 read inside itx via tx (hook pass-through) sees uncommitted row (expect 1) {"r":{"ok":false,"ms":4,"err":" count-inside=1"},"after":{"ok":true,"ms":1,"v":"{\"supply\":0,\"audit\":0}"}}
PROBE[postgres limit=5] A A12 30 parallel single creates (expect 30/30) {"r":{"ok":true,"ms":31,"v":"[]"},"after":{"ok":true,"ms":1,"v":"{\"supply\":30,\"audit\":30}"}}
PROBE[postgres limit=5] A A13 itx holding 3s + concurrent single op (default maxWait 2s) {"r":{"ok":true,"ms":3008,"v":"[\"ok\",\"ok\"]"},"after":{"ok":true,"ms":4,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=5] A A13b same, auto-wrap with maxWait 10s (expect both ok) {"r":{"ok":true,"ms":3117,"v":"[\"ok\",\"ok\"]"},"after":{"ok":true,"ms":3,"v":"{\"supply\":2,\"audit\":2}"}}
PROBE[postgres limit=5] A A13-baseline NO extension: itx holding 3s + concurrent plain single op {"r":{"ok":true,"ms":3013,"v":"[\"ok\",\"ok\"]"},"after":{"ok":true,"ms":3,"v":"{\"supply\":2,\"audit\":0}"}}
```

**Verdict ✅** on both providers: the change and its audit row commit together and roll back together
(including when the audit insert itself fails, A2/A7); no deadlock in any shape (single op, itx,
outer client used inside a callback, nested `$transaction`, array form, 30-way concurrency); concurrent
transactions keep separate ALS stores (A10: the labels of the committed tx and the single ops are
right, the failing tx left nothing).
**⚠️** An auto-wrapped single write is now an interactive tx and inherits Prisma's `maxWait` of 2 s
(A13), whereas today a plain write behind a busy SQLite connection waits for the pool timeout (10 s)
and succeeds (A13-baseline). The wrapper must pass `maxWait: 10_000` (A13b).

## Probes — request context (real Next server)

**Method:** `npm run build` (exit 0; `BUILD_DATABASE_URL` pointed at a scratch file), then
`next start -H 127.0.0.1 -p 3517` in the background with `DB_PROVIDER=sqlite`,
`DATABASE_URL=file:<scratch>/run.db?connection_limit=1`, `PUBLIC_URL=http://localhost:3517`. The DB was a
fresh `prisma migrate deploy` of the SQLite schema (not a copy of the dev DB); user `alice`
(displayName "Alice A") and a `Session` row with `tokenHash = sha256(token)` were inserted directly.
Requests sent `Cookie: bv_session=<token>`, `User-Agent: spike-ua`, `X-Forwarded-For: 10.9.8.7`.
Scratch route: `src/app/api/spike-probe/route.ts` (**deviation:** not `api/__spike__/` — Next treats
`_`-prefixed folders as private, non-routable). Scratch module `src/__spike__/ext.ts`; a temporary
block at the end of `register()` in `src/instrumentation.ts`. All removed/restored afterwards.

The candidate-A variant here resolves the actor **before** opening any transaction
(`resolveActor()`: `await headers()` → throws ⇒ `system`; else `getCurrentUser()` ⇒ user or
`anonymous`) and carries it in the ALS store; the audit row's note is `"<actorName> ip=<x-forwarded-for>"`.

```
R1 instrumentation.register:
SPIKE-STARTUP {"ctx":{"where":"instrumentation.register","cookieErr":"Error: `cookies` was called outside a request scope. Read more: https://nextjs.org/docs/messages/next-dynamic-api-wrong-context","headersErr":"Error: `headers` was called outside a request scope. ...","userErr":"Error: `cookies` was called outside a request scope. ..."},"actor":{"kind":"system","name":"system","ip":null},"audit":[{"note":"system ip=null"}]}

R2 handler         {"where":"route-handler-body","cookie":"present","ua":"spike-ua","xff":"10.9.8.7"}
R3 detached        {"where":"setTimeout-inside-request","cookie":"present","ua":"spike-ua","xff":"1..."}   (context propagates into timers)
R4 naive-direct    ms 2   hookEvents [{"where":"naive-hook:create","cookie":"present","ua":"spike-ua","xff":"10.9.8.7","user":"alice","userMs":1}]
R5 naive-tx-cold   ms 5008 "P2028 Transaction API error: Transaction already closed: A query cannot be executed on an expired transaction ..."   hookEvents [{"where":"naive-hook:create","cookie":"present","ua":"spike-ua","xff":"10.9.8.7","user":"alice","userMs":5004}]
R5 naive-tx-warm   (getCurrentUser() awaited in the handler first) ms 5007 same P2028, hookEvents [... "user":"alice","userMs":5004]
R6 A-direct        ms 4  ok  lastAudit "Alice A (@alice) ip=10.9.8.7"
R7 A-tx            ms 2  ok  2 new audit rows "Alice A (@alice) ip=10.9.8.7"
R8 A-tx-throw      ms 1  " boom"  supply count unchanged (5), no new audit rows
R9 A-array         ms 1  ok  2 new audit rows with alice
R10 no cookie      HTTP 401 (proxy) — the `anonymous` path is unreachable through the proxy
```
**Verdicts:**
- ✅ `cookies()` and `headers()` are readable inside the extension hook, both for a direct write and
  inside a `$transaction` callback (R4, R5), and in timers started by the request (R3).
- ✅ In `instrumentation.register()` both throw "called outside a request scope" → `system` (R1). The
  audited write at startup succeeded and was attributed to `system`.
- ❌ **Resolving the actor inside an open transaction deadlocks-until-timeout on SQLite** (R5): the
  session lookup in `getCurrentUser()` goes through the base client and needs the single connection.
- ❌ **The spec's "memoised per request" is false in route handlers** (R5 warm: a prior call did not
  prevent the DB hit; React `cache()` only memoises during a React server render — I'm ~85% sure that is
  the mechanism; the observed behaviour is certain).
- ✅ Resolving the actor **before** the transaction and carrying it in the store works (R6–R9).

## Decision

### Mechanism
**Candidate A.** Atomicity: every audited write runs on an interactive-transaction client held in an
`AsyncLocalStorage` store; the audit row is written with that same client. Actor: resolved **once per
request** (memoised, ruling B5), always **before** a transaction opens, stored in the ALS store, never
looked up inside a transaction.

### Files and signatures (Task 4)

`src/lib/audit/context.ts`
```ts
export type Actor =
  | { kind: "user"; userId: string; name: string; ip: string | null }   // name = "<displayName> (@<username>)"
  | { kind: "anonymous"; name: "anonymous"; ip: string | null }
  | { kind: "system"; name: "system"; ip: null };
export type AuditStore = { tx?: Prisma.TransactionClient; actor?: Actor; inner?: boolean; suppress?: boolean };
export const auditStorage: AsyncLocalStorage<AuditStore>;
/** Restore: row auditing off for everything inside fn (the flag is copied into the tx store). */
export function runWithRowAuditSuppressed<T>(fn: () => Promise<T>): Promise<T>;
```

`src/lib/audit/actor.ts`
```ts
export async function resolveActor(): Promise<Actor>;
```
- `let h; try { h = await headers(); } catch { return SYSTEM; }` — any throw from `headers()` (outside a
  request: startup jobs, migrator, recovery command, tests) → `system`.
- `const user = await getCurrentUser();` (validateSession already catches DB errors → null) → user or
  `anonymous`.
- `ip`: `getClientIpFromHeaders(h)` — new export in `src/lib/server/client-ip.ts`
  (`(headers: Pick<Headers,"get">, env = process.env) => string | null`); `getClientIp(request)` delegates
  to it. Same trusted-proxy/last-XFF rule.
- **Never called while a transaction is open.**
- **Memoised once per request (controller ruling B5).** `getCurrentUser` is not memoised in route
  handlers (R5 warm), so `resolveActor` memoises itself: a module-level
  `WeakMap<object, Promise<Actor>>` keyed on the object returned by `await headers()` (store the
  promise, so concurrent writes in one request share one lookup), or an equivalent ALS request store
  seeded on first use. **Unverified:** that `await headers()` returns the same object for every call
  within one request — Task 4 must prove the memo with a real-server test (count session lookups for a
  request that makes several audited writes); if identity does not hold, use the ALS alternative.
  `system` (no request) is not memoised — nothing to look up.

`src/lib/audit/extension.ts`
```ts
export function withAudit<C extends PrismaClient>(base: C): C;   // returns the Proxy below
```
- `const ext = base.$extends({ query: { $allModels: { $allOperations } } })`;
  `const rawTx = ext.$transaction.bind(ext)`.
- **Wrapped `$transaction(arg, opts?)`:**
  1. `const outer = auditStorage.getStore();`
  2. If `outer?.tx`: callback form → `return arg(outer.tx)` (flatten nested, A8); array form → await each
     item in order and return the array.
  3. Else: `const actor = outer?.actor ?? await resolveActor();` (before the tx), then
     `return rawTx(tx => auditStorage.run({ tx, actor, suppress: outer?.suppress }, async () => await run(tx)), { maxWait: 10_000, timeout: 10_000, ...opts })`
     where `run` is the callback, or for the array form `async () => { const out = []; for (const p of arg) out.push(await p); return out; }`.
     Caller's `opts` win (restore passes `timeout: 30000`).
     **Note:** these defaults apply to *every* transaction through the app client, not only the
     auto-wrapped single writes — existing callback transactions (redeem, setup, builds, firearms,
     finalize, admins, date-migration) change from Prisma's `maxWait 2 s / timeout 5 s` to
     `10 s / 10 s`. That is intended (A13/A13b), but it is a behaviour change: a stuck transaction now
     holds the SQLite connection up to 10 s instead of 5 s.
- **The exported client** = `new Proxy(ext, { get: (t, p) => p === "$transaction" ? wrappedTx : Reflect.get(t, p) })`.
- **`$allOperations({ model, operation, args, query })`:**
  - not an audited model (global-constraints list) or not a write op → `return query(args)`.
  - `store?.suppress` → `return query(args)` (still on the tx when inside one, per P1).
  - `store?.inner` → `return auditStorage.run({ ...store, inner: false }, async () => { before-reads via store.tx; const r = await query(args); diff; await store.tx.auditEvent.create(...); return r; })`.
  - `store?.tx` → `return auditStorage.run({ ...store, inner: true }, async () => await store.tx[delegate(model)][operation](args))`.
  - no store → `return wrappedTx(async () => { const s = auditStorage.getStore()!; return auditStorage.run({ ...s, inner: true }, async () => await s.tx![delegate(model)][operation](args)); })`.
  - `delegate(model)` = model name with the first letter lower-cased.
  - Every `auditStorage.run` callback must be `async () => await …` (lazy PrismaPromise — see the OOM).
- `AuditEvent` is excluded, so `store.tx.auditEvent.create` passes straight through.

`src/lib/prisma.ts`: build the raw client as today, then `export const prisma = withAudit(raw)`; cache the
wrapped client on `globalForPrisma`. Scripts/migrator that construct their own `PrismaClient` are
unaffected.

`recordEvent(tx | null, …)` (security events): with `tx` → write with it; with `null` → use the store's
`tx` if one is active, else a direct `auditEvent.create` (a single insert is atomic on its own); actor
from the store if present, else `await resolveActor()` — which is safe only because no tx is open on
that path.

### Restore: suppression covers the whole handler

`POST /api/backup/restore` does two things that write audited rows:
1. the restore `$transaction` (`src/app/api/backup/restore/route.ts:150`), `deleteMany`/`createMany` on
   every model;
2. **after and outside** that transaction, `runConfiguredDateMigration("restore")` (same file, line
   177), which normalises legacy date-only values with one `client.$transaction` per row
   (`src/lib/date-migration.ts:226`, `updateMany` on audited models).

Wrapping only (1) would still produce one UPDATE entry per normalised restored row, attributed to the
admin, each paying its own transaction and actor lookup. **Decision:** the restore handler runs its
body from the start of the restore transaction through the post-restore date migration inside one
`runWithRowAuditSuppressed(async () => { … })`, then writes exactly **one** `RESTORE` event (actor,
backup file name, per-model row counts). The suppress flag lives in the outer ALS store and the wrapped
`$transaction` copies it into each tx store, so the per-row date-migration transactions are suppressed
too. The startup date migration (`register()`) is **not** suppressed — its rows are logged as `system`.

### Cascades, nested and explicit child writes (controller ruling B4)

The query hook sees only **top-level** operations: one call per `prisma.x.op(...)`. Prisma does not call
it for rows written through nested `create`/`connect`, and the database — not Prisma — removes rows
with `onDelete: Cascade`. Therefore:
- **Explicit child writes a route makes itself** (e.g. `accessory.deleteMany` or `buildSlot.updateMany`
  before deleting the parent firearm) are top-level operations and are logged as their **own** entries.
- **The parent DELETE snapshot's `_children`** counts only rows the database removes by
  `onDelete: Cascade`. They are counted (`_count` on the `findUnique`, or a count query per cascading
  relation) **before** the delete, inside the same transaction (`store.tx`), so the counts match what
  the delete removes. Rows a route already deleted explicitly are then gone and are not double-counted.
- **Nested `create` / `connect` children** are recorded inside the parent CREATE's `changes`, not as
  separate entries (spec, "Operations" table).

### Rules for code that uses the audited client

1. **Never detach a write from a transaction callback.** A write started in the callback but not awaited
   (fire-and-forget, or scheduled to run after commit) still carries the tx store; it re-dispatches on
   a closed transaction → P2028. Await every write inside the callback; do post-commit work after
   `$transaction` resolves.
2. **Nested `$transaction` is flattened** into the open one (A8). The inner call's `opts` (timeout,
   isolation level) are ignored, and an inner call whose error is caught by the outer callback does
   **not** roll back only the inner writes — nothing is rolled back until the outer transaction fails.
   No current call site nests transactions.
3. **Inside a callback, use `tx` for reads and for writes on excluded models.** The hook re-dispatches
   only audited writes; a read, or a write on an excluded model (User, Session, AuthToken, …), made
   through the outer `prisma` still runs outside the transaction and blocks at `connection_limit=1`
   (pre-existing behaviour).
4. **Route tests that `vi.mock("@/lib/prisma")` bypass the extension entirely.** They cannot prove
   anything about auditing; Task 4 needs real-DB tests (temp SQLite, pattern
   `src/lib/auth/redeem.real-db.test.ts`) for the extension and for the routes below.

### Task 4 must pin with a test
- Single audited write outside a tx: change + audit commit; an audit-insert failure rolls the change back.
- Interactive tx: commit together; a throw rolls back both; outer-client audited write inside the
  callback joins the tx (no deadlock at `connection_limit=1`).
- Array-form `$transaction`: converted, atomic.
- Nested `$transaction` flattens (A8).
- Actor: resolved before any tx; `system` outside a request (instrumentation/date migration); memoised
  once per request (real server, count session lookups).
- `maxWait`/`timeout` defaults: a single write queued behind a 3 s transaction succeeds (A13b).
- **Restore:** a restore whose backup contains legacy date-only values (so the post-restore date
  migration normalises rows) produces exactly one `RESTORE` event and **no** row-level entries.
- Cascades: deleting a firearm with cascading children → one DELETE with `_children` counts; explicit
  child `deleteMany` in the same route → its own entries.

### Unverified here (Task 4 must check)
- TypeScript: the extended client's type vs `PrismaClient` / `Prisma.TransactionClient` annotations
  (e.g. `consumeToken(…, tx: Prisma.TransactionClient)` in `src/lib/auth/tokens.ts`). Not probed.
- Array-form items that are raw queries (`prisma.$executeRaw` inside `prisma.$transaction([...])`) would
  run outside the converted tx and deadlock at pool 1. **No current call site does this** (all four
  array sites contain only model operations — checked below). Not probed.
- A read made through the outer `prisma` inside a callback still runs outside the tx (pre-existing
  behaviour; blocks at pool 1). The hook could re-dispatch reads the same way; not probed.

### Every current `prisma.$transaction` call site (`grep -rn '\$transaction' src scripts prisma`, non-test)

Plus every script that constructs or imports a Prisma client (`grep -ln "lib/prisma\|@prisma/client" scripts/*`), and the
post-restore date migration, which reaches line 226 from inside a request.

| Site | Form | Works unchanged? |
|---|---|---|
| `src/app/api/accessories/[id]/rounds/route.ts:42` | array: `accessory.update`, `roundCountLog.create` | ✅ converted to itx by the wrapper (A6/A7/R9) |
| `src/app/api/accessories/[id]/battery-log/route.ts:60` | array: `batteryChangeLog.create`, `accessory.update` | ✅ same |
| `src/app/api/builds/[id]/activate/route.ts:18` | array: `build.updateMany`, `build.update` (with include) | ✅ same |
| `src/app/api/ammo/[id]/transactions/route.ts:89` | array: `ammoStock.update`, `ammoTransaction.create` | ✅ same |
| `src/app/api/auth/redeem/route.ts:46`, `:72` | callback, User/AuthToken/Session (excluded) | ✅ pass-through inside the wrapped tx; add `recordEvent(tx, …)` |
| `src/app/api/auth/setup/route.ts:42` | callback, excluded models | ✅ same |
| `src/app/api/builds/[id]/route.ts:126` | callback | ✅ (A3/A4/R7/R8) |
| `src/app/api/firearms/[id]/route.ts:309` | callback | ✅ |
| `src/app/api/range/sessions/[id]/finalize/route.ts:20` | callback | ✅ |
| `src/app/api/backup/restore/route.ts:150` | callback, `{ timeout: 30000 }`, `deleteMany`/`createMany` on every model | ⚠️ works, but **must** run inside `runWithRowAuditSuppressed` (together with line 177, next row) or every restored row is audited; then one `RESTORE` event |
| `src/app/api/backup/restore/route.ts:177` → `src/lib/date-migration.ts:226` | `runConfiguredDateMigration("restore")`, after and outside the restore tx, one callback tx per normalised row | ⚠️ inside the restore request: **must** be inside the same `runWithRowAuditSuppressed` — otherwise one UPDATE per normalised row attributed to the admin |
| `src/lib/auth/admins.ts:69` | callback, User/AuthToken (excluded) | ✅; add `recordEvent(tx, …)` |
| `src/lib/date-migration.ts:226` (startup) | callback via `client = prisma as unknown as Client`, `updateMany` on audited models, from `register()` | ✅ actor `system` (R1); logged, not suppressed |
| `scripts/admin-reset-link.mjs:116` | constructs its own `PrismaClient` (no `$transaction`) | ✅ not the app client; unaffected (and not audited) |
| `scripts/decrypt-serials.ts:2` | imports the **app** client (`../src/lib/prisma`), no `$transaction`; `firearm.update` per row | ⚠️ goes through the extension: each update becomes an auto-wrapped tx logged as `system` (serial redacted). Unverified: `headers()` throwing under plain ts-node (expected → `system`) |
| `scripts/reset-db.ts:2` | imports the **app** client, no `$transaction`; `deleteMany` on every table | ⚠️ goes through the extension: would read and log every deleted row as `system`. Task 4 must decide (suppress, or leave logged) and say whether the script touches `AuditEvent` (global constraint: no code path deletes audit entries) |
| `src/lib/db/sqlite-to-postgres.ts:205` | `target.$transaction` on the migrator's own client | ✅ not the app client; unaffected |
| `src/lib/db/fake-db.ts:64` | in-memory fake for tests | ✅ unaffected |

## Gate

Candidate A gives atomic same-transaction audit writes on SQLite (`connection_limit=1`) and PostgreSQL
(pool 1 and 5) without deadlock. **PASSED** — Task 4 may build on the Decision above.
