# Public URL, Origin Enforcement and Direct-Access Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a configured public URL, redirect and origin-check every request against it, and reset TCP connections that bypass the reverse proxy when direct access is off.

**Architecture:** Two layers. A plain-JS TCP gate (`gate/`) owns port 3000 in the container, resets untrusted peers, and pipes the rest to Next on `127.0.0.1:3001`. Inside Next, `src/proxy.ts` calls a pure `decideRequest()` that redirects wrong hosts (307), rejects cross-origin writes (403), and passes everything else. Configuration is four `BLACKVAULT_*` env vars plus one nullable `AppSettings` column seeded at first boot.

**Tech Stack:** Next.js 16.1.6 (`proxy.ts`, Node runtime), Prisma (SQLite + PostgreSQL), Node 24 `node:net` (`BlockList`, `resetAndDestroy`), vitest, bash, cmd.exe batch, PowerShell (Windows CI harness).

**Spec:** `docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md`

## Global Constraints

- Host `.env` keys: `BLACKVAULT_PUBLIC_URL`, `BLACKVAULT_TRUSTED_PROXIES`, `BLACKVAULT_ALLOW_DIRECT_ACCESS`, `BLACKVAULT_DIRECT_ACCESS_INITIAL`. Container keys: `PUBLIC_URL`, `TRUSTED_PROXIES`, `ALLOW_DIRECT_ACCESS`, `DIRECT_ACCESS_INITIAL`.
- Compose interpolation is always `${VAR:-}`, never `${VAR:?}`.
- Only the exact string `true` in `ALLOW_DIRECT_ACCESS` has effect. Only `on` (case-insensitive, trimmed) in `DIRECT_ACCESS_INITIAL` seeds `true`.
- Redirect status is **307**. Never 301/308.
- Cross-origin write rejection is **403** with body `{ "error": "Cross-origin request rejected" }`.
- No response ever carries an `Access-Control-Allow-*` header.
- `/api/health` is exempt from the redirect.
- `next build` must succeed with `PUBLIC_URL` unset (CI builds without it).
- PostgreSQL `prisma/postgres/migrations/0_init` is FROZEN. The Postgres change is its own timestamped migration.
- Edit only `prisma/schema.base.prisma`; regenerate with `npm run gen:schemas`; regenerate clients with `npm run db:generate` (never a single `prisma generate`).
- Do NOT revive the shared-password code in `/api/session/unlock`. Only change the cookie helper signature.
- `update.bat`: every new line goes BELOW the colon-only landing pad (currently lines 50-56). `scripts/update-bat-landing-pad.test.ts` must stay green.
- `.sh` and `.bat` installers change in lockstep.
- Prove every guard by injection: break it, watch its named test fail, restore, confirm the file is byte-identical (`git diff --exit-code <file>`).
- Branch: `feat/public-url-direct-access` off `develop`. PRs: `gh pr create --repo doomcrewinc/BlackVaultArmory --base develop`.
- Tests: the user's global rule is "NEVER run tests without explicit permission". This plan's execution is that permission for `npm test`, `npx vitest run <file>`, `npm run typecheck`, `npm run lint`, `npm run build`, and local Docker builds/runs. Nothing touches the `dashboard` host.

## Review Focus

1. **Open redirect via path** — a request for `//evil.com/x` on the wrong host must redirect to `https://vault.example.com//evil.com/x`, never to `evil.com`. Pinned in Task 4.
2. **Proxy forwards an explicit default port** — `Host: vault.example.com:443` under HTTPS must match the public host, not redirect to itself forever. Pinned in Task 4.
3. **Dual-stack peer addresses** — `::ffff:10.10.10.3` must match a trusted `10.10.10.3` / `10.10.10.0/24`. Pinned in Task 6.
4. **Database unavailable at request time** — the direct-access reader must fall back to the last known value (else `false`) and never throw into `proxy.ts`. Pinned in Task 2.
5. **Existing `.env` edited on Windows (CRLF) or holding a value with `/`, `:` or `&`** — rewriting one key must leave every other line byte-identical and must not interpret the value. Pinned in Task 10.

---

### Task 1: Public URL parser

**Files:**
- Create: `src/lib/server/public-url.ts`
- Test: `src/lib/server/public-url.test.ts`

**Interfaces:**
- Produces:
  - `class PublicUrlError extends Error`
  - `type PublicUrl = { origin: string; host: string; protocol: "http:" | "https:" }`
  - `parsePublicUrl(raw: string | undefined): PublicUrl` — throws `PublicUrlError`
  - `getPublicUrl(): PublicUrl` — parses `process.env.PUBLIC_URL` once, memoised
  - `resetPublicUrlCacheForTests(): void`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parsePublicUrl, PublicUrlError } from "./public-url";

describe("parsePublicUrl", () => {
  it.each([
    ["https://vault.example.com", "https://vault.example.com", "vault.example.com"],
    ["https://vault.example.com/", "https://vault.example.com", "vault.example.com"],
    ["https://Vault.Example.COM:443/", "https://vault.example.com", "vault.example.com"],
    ["http://localhost:3000", "http://localhost:3000", "localhost:3000"],
    ["http://vault.lan:80", "http://vault.lan", "vault.lan"],
    ["https://vault.example.com:8443", "https://vault.example.com:8443", "vault.example.com:8443"],
    ["  https://vault.example.com  ", "https://vault.example.com", "vault.example.com"],
  ])("%s -> origin %s, host %s", (raw, origin, host) => {
    const parsed = parsePublicUrl(raw);
    expect(parsed.origin).toBe(origin);
    expect(parsed.host).toBe(host);
  });

  it.each([
    [undefined, /not set/],
    ["", /not set/],
    ["   ", /not set/],
    ["vault.example.com", /not a valid URL/],
    ["ftp://vault.example.com", /http or https/],
    ["https://vault.example.com/vault", /path/],
    ["https://vault.example.com/?x=1", /query/],
    ["https://vault.example.com/?", /query/],
    ["https://vault.example.com/#top", /fragment/],
    ["https://vault.example.com#", /fragment/],
    ["https://user:pw@vault.example.com", /username or password/],
  ])("rejects %s", (raw, message) => {
    expect(() => parsePublicUrl(raw)).toThrow(PublicUrlError);
    expect(() => parsePublicUrl(raw)).toThrow(message);
  });

  it("names the variable and gives an example in every error", () => {
    try {
      parsePublicUrl("ftp://x");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain("BLACKVAULT_PUBLIC_URL");
      expect(String(error)).toContain("https://vault.example.com");
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/server/public-url.test.ts`
Expected: FAIL — `Failed to resolve import "./public-url"`.

- [ ] **Step 3: Implement**

```ts
/**
 * The one address people use to reach BlackVault, normally a reverse proxy's
 * HTTPS origin. Set as BLACKVAULT_PUBLIC_URL in the host .env; compose passes it
 * to the container as PUBLIC_URL. See
 * docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md.
 */

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

export type PublicUrl = { origin: string; host: string; protocol: "http:" | "https:" };

const EXAMPLE = "https://vault.example.com";

function fail(problem: string): never {
  throw new PublicUrlError(
    `BLACKVAULT_PUBLIC_URL ${problem}. Set it to the address people open BlackVault at, e.g. ${EXAMPLE}`,
  );
}

export function parsePublicUrl(raw: string | undefined): PublicUrl {
  const value = raw?.trim() ?? "";
  if (value === "") fail("is not set");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`is not a valid URL ("${value}")`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") fail("must use http or https");
  if (url.username || url.password) fail("must not contain a username or password");
  if (url.pathname !== "/") fail("must not have a path (sub-path hosting is not supported)");
  // URL drops an empty "?" or "#", so check the raw text as well.
  if (url.search || value.includes("?")) fail("must not have a query string");
  if (url.hash || value.includes("#")) fail("must not have a fragment");

  // URL already lowercases the host and drops a default port.
  return { origin: url.origin, host: url.host, protocol: url.protocol };
}

let cached: PublicUrl | null = null;

export function getPublicUrl(): PublicUrl {
  cached ??= parsePublicUrl(process.env.PUBLIC_URL);
  return cached;
}

export function resetPublicUrlCacheForTests(): void {
  cached = null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/server/public-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove by injection**

Delete the `value.includes("?")` clause → the `/?` case must FAIL. Restore, `git diff --exit-code src/lib/server/public-url.ts` after re-running green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/public-url.ts src/lib/server/public-url.test.ts
git commit -m "feat: parse and validate BLACKVAULT_PUBLIC_URL"
```

---

### Task 2: `allowDirectAccess` setting — schema, seed, cached reader

**Files:**
- Modify: `prisma/schema.base.prisma` (model `AppSettings`, ~line 449)
- Generated: `prisma/sqlite/schema.prisma`, `prisma/postgres/schema.prisma`
- Create: `prisma/sqlite/migrations/<UTC-timestamp>_add_allow_direct_access/migration.sql`
- Create: `prisma/postgres/migrations/<same-timestamp>_add_allow_direct_access/migration.sql`
- Create: `src/lib/server/direct-access.ts`
- Test: `src/lib/server/direct-access.test.ts`

**Interfaces:**
- Produces:
  - `type DirectAccessState = { allowed: boolean; source: "env" | "setting" }`
  - `envForcesDirectAccess(env?: NodeJS.ProcessEnv): boolean`
  - `seedDirectAccessSetting(env?: NodeJS.ProcessEnv): Promise<void>`
  - `readStoredDirectAccess(now?: number): Promise<boolean>` — never throws
  - `getDirectAccessState(env?: NodeJS.ProcessEnv): Promise<DirectAccessState>` — never throws
  - `resetDirectAccessCacheForTests(): void`

- [ ] **Step 1: Schema**

In `prisma/schema.base.prisma`, inside `model AppSettings`, after `timezone String?`:

```prisma
  // Whether http://<ip>:<port> (bypassing the reverse proxy) is served.
  // null = never decided: the first boot seeds it from DIRECT_ACCESS_INITIAL
  // (installers write it) and a fresh install lands on false. See
  // docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md.
  allowDirectAccess       Boolean?
```

Run: `npm run gen:schemas && npm run db:generate`

- [ ] **Step 2: SQLite migration**

```bash
NAME=$(date -u +%Y%m%d%H%M%S)_add_allow_direct_access
echo "$NAME"   # keep it: the Postgres twin uses the same name
mkdir -p prisma/sqlite/migrations/$NAME
npx prisma migrate diff \
  --from-migrations prisma/sqlite/migrations \
  --to-schema-datamodel prisma/sqlite/schema.prisma \
  --shadow-database-url "file:$(mktemp -d)/shadow.db" \
  --script > prisma/sqlite/migrations/$NAME/migration.sql
cat prisma/sqlite/migrations/$NAME/migration.sql
```

Expected content: one `ALTER TABLE "AppSettings" ADD COLUMN "allowDirectAccess" BOOLEAN;`. Anything else means the schema had drifted — stop and report.

- [ ] **Step 3: PostgreSQL migration (0_init is frozen)**

```bash
docker run -d --rm --name bv-pg-shadow -e POSTGRES_PASSWORD=scratch -p 55432:5432 postgres:17-alpine
until docker exec bv-pg-shadow pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker exec bv-pg-shadow createdb -U postgres blackvault_shadow
mkdir -p prisma/postgres/migrations/$NAME
npx prisma migrate diff \
  --from-migrations prisma/postgres/migrations \
  --to-schema-datamodel prisma/postgres/schema.prisma \
  --shadow-database-url "postgresql://postgres:scratch@127.0.0.1:55432/blackvault_shadow" \
  --script > prisma/postgres/migrations/$NAME/migration.sql
cat prisma/postgres/migrations/$NAME/migration.sql
SHADOW_DATABASE_URL=postgresql://postgres:scratch@127.0.0.1:55432/blackvault_shadow npm run db:check-drift
docker stop bv-pg-shadow
```

Expected: `ALTER TABLE "AppSettings" ADD COLUMN "allowDirectAccess" BOOLEAN;` and a drift check passing for BOTH providers. `git diff --exit-code prisma/postgres/migrations/0_init` must be clean.

- [ ] **Step 4: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    appSettings: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, create: mocks.create },
  },
}));

import {
  envForcesDirectAccess,
  getDirectAccessState,
  readStoredDirectAccess,
  resetDirectAccessCacheForTests,
  seedDirectAccessSetting,
} from "./direct-access";

beforeEach(() => {
  vi.clearAllMocks();
  resetDirectAccessCacheForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("envForcesDirectAccess", () => {
  it.each([
    ["true", true],
    ["TRUE", false],
    ["1", false],
    ["yes", false],
    [" true", false],
    [undefined, false],
  ])("ALLOW_DIRECT_ACCESS=%s -> %s", (value, expected) => {
    expect(envForcesDirectAccess({ ALLOW_DIRECT_ACCESS: value } as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("seedDirectAccessSetting", () => {
  it.each([
    ["on", true],
    [" ON ", true],
    ["off", false],
    ["", false],
    [undefined, false],
  ])("seed %s writes %s only where the value is still null", async (seed, value) => {
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await seedDirectAccessSetting({ DIRECT_ACCESS_INITIAL: seed } as NodeJS.ProcessEnv);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "singleton", allowDirectAccess: null },
      data: { allowDirectAccess: value },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates the settings row when none exists", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue(null);
    await seedDirectAccessSetting({ DIRECT_ACCESS_INITIAL: "on" } as NodeJS.ProcessEnv);
    expect(mocks.create).toHaveBeenCalledWith({ data: { id: "singleton", allowDirectAccess: true } });
  });

  it("leaves an already-decided row alone", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.findUnique.mockResolvedValue({ id: "singleton" });
    await seedDirectAccessSetting({ DIRECT_ACCESS_INITIAL: "on" } as NodeJS.ProcessEnv);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("readStoredDirectAccess", () => {
  it("treats a missing row or null as false", async () => {
    mocks.findUnique.mockResolvedValue(null);
    expect(await readStoredDirectAccess(0)).toBe(false);
    resetDirectAccessCacheForTests();
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: null });
    expect(await readStoredDirectAccess(0)).toBe(false);
  });

  it("caches for 5 seconds", async () => {
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: true });
    expect(await readStoredDirectAccess(1_000)).toBe(true);
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: false });
    expect(await readStoredDirectAccess(5_999)).toBe(true);
    expect(await readStoredDirectAccess(6_000)).toBe(false);
    expect(mocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("falls back to the last known value when the database fails", async () => {
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: true });
    await readStoredDirectAccess(0);
    mocks.findUnique.mockRejectedValue(new Error("SQLITE_BUSY"));
    expect(await readStoredDirectAccess(10_000)).toBe(true);
  });

  it("falls back to false when the database fails and nothing is known", async () => {
    mocks.findUnique.mockRejectedValue(new Error("SQLITE_BUSY"));
    expect(await readStoredDirectAccess(0)).toBe(false);
  });
});

describe("getDirectAccessState", () => {
  it("env override wins without touching the database", async () => {
    expect(await getDirectAccessState({ ALLOW_DIRECT_ACCESS: "true" } as NodeJS.ProcessEnv)).toEqual({
      allowed: true,
      source: "env",
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("otherwise reports the stored setting", async () => {
    mocks.findUnique.mockResolvedValue({ allowDirectAccess: false });
    expect(await getDirectAccessState({} as NodeJS.ProcessEnv)).toEqual({ allowed: false, source: "setting" });
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx vitest run src/lib/server/direct-access.test.ts`
Expected: FAIL — cannot resolve `./direct-access`.

- [ ] **Step 6: Implement**

```ts
import { prisma } from "@/lib/prisma";

/**
 * Whether BlackVault serves requests that bypass the reverse proxy
 * (http://<ip>:<port>). ALLOW_DIRECT_ACCESS=true is the break-glass override;
 * otherwise AppSettings.allowDirectAccess decides, seeded once at first boot
 * from DIRECT_ACCESS_INITIAL. The TCP gate and proxy.ts both read it, on every
 * connection / request, so it is cached.
 */

export type DirectAccessState = { allowed: boolean; source: "env" | "setting" };

const TTL_MS = 5_000;
let cache: { value: boolean; at: number } | null = null;
let lastKnown: boolean | null = null;

export function envForcesDirectAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_DIRECT_ACCESS === "true";
}

function seedValue(env: NodeJS.ProcessEnv): boolean {
  return env.DIRECT_ACCESS_INITIAL?.trim().toLowerCase() === "on";
}

export async function seedDirectAccessSetting(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const value = seedValue(env);
  // Conditional: only a still-null value is written, so a later decision (the
  // settings UI, spec 2) is never overwritten by a stale seed left in .env.
  const { count } = await prisma.appSettings.updateMany({
    where: { id: "singleton", allowDirectAccess: null },
    data: { allowDirectAccess: value },
  });
  if (count > 0) return;
  const existing = await prisma.appSettings.findUnique({ where: { id: "singleton" }, select: { id: true } });
  if (!existing) await prisma.appSettings.create({ data: { id: "singleton", allowDirectAccess: value } });
}

export async function readStoredDirectAccess(now: number = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  try {
    const row = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { allowDirectAccess: true },
    });
    const value = row?.allowDirectAccess ?? false;
    cache = { value, at: now };
    lastKnown = value;
    return value;
  } catch (error) {
    console.error("[direct-access] settings read failed; using the last known value:", error);
    return lastKnown ?? false;
  }
}

export async function getDirectAccessState(env: NodeJS.ProcessEnv = process.env): Promise<DirectAccessState> {
  if (envForcesDirectAccess(env)) return { allowed: true, source: "env" };
  return { allowed: await readStoredDirectAccess(), source: "setting" };
}

export function resetDirectAccessCacheForTests(): void {
  cache = null;
  lastKnown = null;
}
```

- [ ] **Step 7: Run to verify it passes**

Run: `npx vitest run src/lib/server/direct-access.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Prove by injection**

Change the `where` to `{ id: "singleton" }` (drop `allowDirectAccess: null`) → the seed test must FAIL. Change `lastKnown ?? false` to `false` → the last-known test must FAIL. Restore both; `git diff --exit-code src/lib/server/direct-access.ts`.

- [ ] **Step 9: Commit**

```bash
git add prisma/ src/lib/server/direct-access.ts src/lib/server/direct-access.test.ts
git commit -m "feat: AppSettings.allowDirectAccess with a one-time seed and cached reader"
```

---

### Task 3: Refuse to start without a valid public URL; seed at boot

**Files:**
- Modify: `src/instrumentation.ts`
- Test: `src/instrumentation.test.ts`

**Interfaces:**
- Consumes: `parsePublicUrl`, `PublicUrlError` (Task 1); `seedDirectAccessSetting` (Task 2)

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/date-migration", () => ({ runStartupDateMigration: vi.fn() }));
vi.mock("./lib/db/split-brain-guard", () => ({ runSplitBrainGuard: vi.fn() }));
const seed = vi.hoisted(() => vi.fn());
vi.mock("./lib/server/direct-access", () => ({ seedDirectAccessSetting: seed }));

import { register } from "./instrumentation";

const saved = { ...process.env };

beforeEach(() => {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.NEXT_PHASE;
  vi.spyOn(console, "error").mockImplementation(() => {});
  seed.mockReset();
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe("register", () => {
  it("exits 1 with the variable named when PUBLIC_URL is missing", async () => {
    delete process.env.PUBLIC_URL;
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(vi.mocked(console.error).mock.calls[0][0])).toContain("BLACKVAULT_PUBLIC_URL");
  });

  it("exits 1 when PUBLIC_URL has a path", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com/vault";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not exit during next build", async () => {
    delete process.env.PUBLIC_URL;
    process.env.NEXT_PHASE = "phase-production-build";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("seeds direct access and survives a seed failure", async () => {
    process.env.PUBLIC_URL = "https://vault.example.com";
    seed.mockRejectedValue(new Error("db down"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await expect(register()).resolves.toBeUndefined();
    expect(seed).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/instrumentation.test.ts`
Expected: FAIL — `exit` not called / `seed` not called.

- [ ] **Step 3: Implement**

At the TOP of `register()` in `src/instrumentation.ts`, before the existing `try` blocks:

```ts
  // Deliberately OUTSIDE the never-throw blocks below: those exist so a failed
  // migration cannot block startup, and this check exists to block it. Skipped
  // during `next build`, which CI runs without a public URL.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { parsePublicUrl, PublicUrlError } = await import("./lib/server/public-url");
    try {
      parsePublicUrl(process.env.PUBLIC_URL);
    } catch (error) {
      if (!(error instanceof PublicUrlError)) throw error;
      console.error(`[startup] ${error.message}`);
      process.exit(1);
      return;
    }
  }
```

After the existing split-brain block, add:

```ts
  try {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { seedDirectAccessSetting } = await import("./lib/server/direct-access");
    await seedDirectAccessSetting();
  } catch (error) {
    console.error("[direct-access] startup seed failed; the server will continue:", error);
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/instrumentation.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify against the real server — the unit test mocks `process.exit`, this does not**

```bash
env -u PUBLIC_URL npm run build          # must succeed
env -u PUBLIC_URL PORT=3998 npm start; echo "exit=$?"
```

Expected: build exits 0; `npm start` prints `[startup] BLACKVAULT_PUBLIC_URL is not set...` and `exit=1` within a few seconds.
If the build FAILS because `register()` ran during build with a different `NEXT_PHASE`, print `process.env.NEXT_PHASE` from `register()` during the build, add that phase to the guard, and add a test case for it. If `npm start` does NOT exit, report that — do not paper over it.

- [ ] **Step 6: Commit**

```bash
git add src/instrumentation.ts src/instrumentation.test.ts
git commit -m "feat: refuse to start without a valid public URL; seed direct access at boot"
```

---

### Task 4: `decideRequest` — the pure request gate

**Files:**
- Create: `src/lib/server/request-gate.ts`
- Test: `src/lib/server/request-gate.test.ts`

**Interfaces:**
- Consumes: `PublicUrl` (Task 1)
- Produces:
  - `type GateInput = { method: string; pathname: string; search: string; host: string | null; forwardedHost: string | null; forwardedProto: string | null; origin: string | null; requestProtocol: "http:" | "https:"; publicUrl: PublicUrl; directAccessAllowed: boolean; trustForwardedHeaders: boolean }`
  - `type GateDecision = { kind: "pass" } | { kind: "redirect"; location: string } | { kind: "forbidden"; reason: string }`
  - `decideRequest(input: GateInput): GateDecision`
  - `trustsForwardedHeaders(env?: NodeJS.ProcessEnv): boolean` — true iff `TRUSTED_PROXIES` is non-blank
  - `isSecureRequest(request: Request, env?: NodeJS.ProcessEnv): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parsePublicUrl } from "./public-url";
import { decideRequest, isSecureRequest, trustsForwardedHeaders, type GateInput } from "./request-gate";

const publicUrl = parsePublicUrl("https://vault.example.com");

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    method: "GET",
    pathname: "/vault",
    search: "",
    host: "vault.example.com",
    forwardedHost: null,
    forwardedProto: null,
    origin: null,
    requestProtocol: "http:",
    publicUrl,
    directAccessAllowed: false,
    trustForwardedHeaders: true,
    ...overrides,
  };
}

describe("decideRequest — host routing", () => {
  it("passes the public host", () => {
    expect(decideRequest(input())).toEqual({ kind: "pass" });
  });

  it("matches the host case-insensitively", () => {
    expect(decideRequest(input({ host: "VAULT.Example.com" }))).toEqual({ kind: "pass" });
  });

  it("treats an explicit default port as the public host (no redirect loop)", () => {
    expect(decideRequest(input({ host: "vault.example.com:443", forwardedProto: "https" }))).toEqual({ kind: "pass" });
  });

  it("redirects a LAN IP with 307-style location, keeping path and query", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", pathname: "/vault/abc", search: "?tab=docs" }))).toEqual({
      kind: "redirect",
      location: "https://vault.example.com/vault/abc?tab=docs",
    });
  });

  it("never redirects off the public host for a protocol-relative path", () => {
    const d = decideRequest(input({ host: "10.10.10.3:3000", pathname: "//evil.com/x" }));
    expect(d).toEqual({ kind: "redirect", location: "https://vault.example.com//evil.com/x" });
    if (d.kind === "redirect") expect(new URL(d.location).host).toBe("vault.example.com");
  });

  it.each(["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "localhost"])("passes loopback host %s", (host) => {
    expect(decideRequest(input({ host }))).toEqual({ kind: "pass" });
  });

  it("passes any host when direct access is allowed", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", directAccessAllowed: true }))).toEqual({ kind: "pass" });
  });

  it("exempts /api/health", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", pathname: "/api/health" }))).toEqual({ kind: "pass" });
  });

  it("uses the first X-Forwarded-Host when forwarded headers are trusted", () => {
    expect(decideRequest(input({ host: "10.10.10.3:3000", forwardedHost: "vault.example.com, proxy.lan" }))).toEqual({
      kind: "pass",
    });
  });

  it("ignores X-Forwarded-Host when forwarded headers are not trusted", () => {
    expect(
      decideRequest(input({ host: "10.10.10.3:3000", forwardedHost: "vault.example.com", trustForwardedHeaders: false })),
    ).toMatchObject({ kind: "redirect" });
  });

  it("redirects a request with no Host at all", () => {
    expect(decideRequest(input({ host: null }))).toMatchObject({ kind: "redirect" });
  });
});

describe("decideRequest — origin check", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("rejects a cross-origin %s", (method) => {
    expect(decideRequest(input({ method, origin: "https://evil.example" }))).toEqual({
      kind: "forbidden",
      reason: "Cross-origin request rejected",
    });
  });

  it("rejects Origin: null", () => {
    expect(decideRequest(input({ method: "POST", origin: "null" }))).toMatchObject({ kind: "forbidden" });
  });

  it("passes a same-origin POST via the proxy", () => {
    expect(decideRequest(input({ method: "POST", origin: "https://vault.example.com" }))).toEqual({ kind: "pass" });
  });

  it("passes a POST with no Origin header (not a browser)", () => {
    expect(decideRequest(input({ method: "POST", origin: null }))).toEqual({ kind: "pass" });
  });

  it("does not origin-check GET", () => {
    expect(decideRequest(input({ method: "GET", origin: "https://evil.example" }))).toEqual({ kind: "pass" });
  });

  it("passes a POST from the page's own direct origin when direct access is on", () => {
    expect(
      decideRequest(
        input({ method: "POST", host: "10.10.10.3:3000", origin: "http://10.10.10.3:3000", directAccessAllowed: true }),
      ),
    ).toEqual({ kind: "pass" });
  });

  it("passes a POST from localhost's own origin", () => {
    expect(decideRequest(input({ method: "POST", host: "localhost:3000", origin: "http://localhost:3000" }))).toEqual({
      kind: "pass",
    });
  });

  it("rejects a POST whose origin is a different LAN host", () => {
    expect(
      decideRequest(
        input({ method: "POST", host: "10.10.10.3:3000", origin: "http://10.10.10.9:3000", directAccessAllowed: true }),
      ),
    ).toMatchObject({ kind: "forbidden" });
  });
});

describe("trustsForwardedHeaders", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["   ", false],
    ["10.10.10.3", true],
  ])("TRUSTED_PROXIES=%s -> %s", (value, expected) => {
    expect(trustsForwardedHeaders({ TRUSTED_PROXIES: value } as NodeJS.ProcessEnv)).toBe(expected);
  });
});

describe("isSecureRequest", () => {
  const trusted = { TRUSTED_PROXIES: "10.10.10.3" } as NodeJS.ProcessEnv;
  it("reads X-Forwarded-Proto when trusted", () => {
    const r = new Request("http://127.0.0.1:3001/api/x", { headers: { "x-forwarded-proto": "https" } });
    expect(isSecureRequest(r, trusted)).toBe(true);
  });
  it("ignores X-Forwarded-Proto when untrusted", () => {
    const r = new Request("http://127.0.0.1:3001/api/x", { headers: { "x-forwarded-proto": "https" } });
    expect(isSecureRequest(r, {} as NodeJS.ProcessEnv)).toBe(false);
  });
  it("uses the first value of a list", () => {
    const r = new Request("http://127.0.0.1:3001/api/x", { headers: { "x-forwarded-proto": "http, https" } });
    expect(isSecureRequest(r, trusted)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/server/request-gate.test.ts`
Expected: FAIL — cannot resolve `./request-gate`.

- [ ] **Step 3: Implement**

```ts
import type { PublicUrl } from "./public-url";

/**
 * Per-request policy, kept pure so every branch is testable without a server.
 * src/proxy.ts gathers the input and applies the decision. The TCP gate in
 * gate/ runs first and decides whether the connection may exist at all.
 */

export type GateInput = {
  method: string;
  pathname: string;
  search: string;
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  origin: string | null;
  requestProtocol: "http:" | "https:";
  publicUrl: PublicUrl;
  directAccessAllowed: boolean;
  trustForwardedHeaders: boolean;
};

export type GateDecision =
  | { kind: "pass" }
  | { kind: "redirect"; location: string }
  | { kind: "forbidden"; reason: string };

const PASS: GateDecision = { kind: "pass" };
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_PORT = { "http:": "80", "https:": "443" } as const;

function firstValue(header: string | null): string | null {
  const value = header?.split(",")[0]?.trim().toLowerCase();
  return value ? value : null;
}

function splitHost(host: string): { hostname: string; port: string | null } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host, port: null };
    const rest = host.slice(end + 1);
    return { hostname: host.slice(0, end + 1), port: rest.startsWith(":") ? rest.slice(1) : null };
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? { hostname: host, port: null } : { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

function effectiveProtocol(i: GateInput): "http:" | "https:" {
  if (i.trustForwardedHeaders) {
    const proto = firstValue(i.forwardedProto);
    if (proto === "https") return "https:";
    if (proto === "http") return "http:";
  }
  return i.requestProtocol;
}

/** Host as the browser addressed it, lowercased, default port dropped. */
function effectiveHost(i: GateInput): string | null {
  const raw = (i.trustForwardedHeaders ? firstValue(i.forwardedHost) : null) ?? firstValue(i.host);
  if (!raw) return null;
  const { hostname, port } = splitHost(raw);
  return port === null || port === DEFAULT_PORT[effectiveProtocol(i)] ? hostname : `${hostname}:${port}`;
}

export function decideRequest(i: GateInput): GateDecision {
  if (i.pathname === "/api/health") return PASS;

  const host = effectiveHost(i);
  const isPublic = host === i.publicUrl.host;
  const isLoopback = host !== null && LOOPBACK_HOSTNAMES.has(splitHost(host).hostname);

  if (!isPublic && !isLoopback && !i.directAccessAllowed) {
    // String concatenation, never new URL(path, base): a path of "//evil.com"
    // would make URL resolve to another host.
    return { kind: "redirect", location: `${i.publicUrl.origin}${i.pathname}${i.search}` };
  }

  if (UNSAFE_METHODS.has(i.method.toUpperCase()) && i.origin !== null) {
    const origin = i.origin.trim().toLowerCase();
    const ownOrigin = host === null ? null : `${effectiveProtocol(i)}//${host}`;
    if (origin !== i.publicUrl.origin && origin !== ownOrigin) {
      return { kind: "forbidden", reason: "Cross-origin request rejected" };
    }
  }

  return PASS;
}

export function trustsForwardedHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TRUSTED_PROXIES ?? "").trim() !== "";
}

export function isSecureRequest(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (trustsForwardedHeaders(env)) {
    const proto = firstValue(request.headers.get("x-forwarded-proto"));
    if (proto) return proto === "https";
  }
  return new URL(request.url).protocol === "https:";
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/server/request-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove by injection**

(a) Replace the concatenation with `new URL(i.pathname + i.search, i.publicUrl.origin).toString()` → the `//evil.com` test must FAIL. (b) Remove the default-port drop in `effectiveHost` → the `:443` test must FAIL. (c) Remove `i.origin !== null` → the no-Origin test must FAIL. Restore; `git diff --exit-code src/lib/server/request-gate.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/request-gate.ts src/lib/server/request-gate.test.ts
git commit -m "feat: pure request gate — 307 to the public URL and a cross-origin write check"
```

---

### Task 5: Wire `proxy.ts`, the gate-config route and the cookie helper

**Files:**
- Create: `src/proxy.ts`
- Test: `src/proxy.test.ts`
- Create: `src/app/api/internal/gate-config/route.ts`
- Test: `src/app/api/internal/gate-config/route.test.ts`
- Modify: `src/lib/server/auth.ts:14-35`
- Modify: `src/app/api/session/unlock/route.ts:36`, `src/app/api/session/logout/route.ts:6`

**Interfaces:**
- Consumes: `getPublicUrl` (1), `getDirectAccessState` (2), `decideRequest`, `trustsForwardedHeaders`, `isSecureRequest` (4)
- Produces: `GET /api/internal/gate-config` → `{ allowDirectAccess: boolean }` (Task 7's gate polls it). `getSessionCookieOptions(request: Request)`, `clearSessionCookie(response: NextResponse, request: Request)`.

- [ ] **Step 1: Write the failing tests**

`src/proxy.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({ allowed: false }));
vi.mock("@/lib/server/direct-access", () => ({
  getDirectAccessState: vi.fn(async () => ({ allowed: state.allowed, source: "setting" })),
}));

import { proxy } from "./proxy";
import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";

beforeEach(() => {
  process.env.PUBLIC_URL = "https://vault.example.com";
  process.env.TRUSTED_PROXIES = "10.10.10.3";
  resetPublicUrlCacheForTests();
  state.allowed = false;
});

function req(url: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(url, init);
}

describe("proxy", () => {
  it("307s a LAN host to the public URL", async () => {
    const res = await proxy(req("http://10.10.10.3:3000/vault?x=1", { headers: { host: "10.10.10.3:3000" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://vault.example.com/vault?x=1");
  });

  it("403s a cross-origin POST with the exact JSON body", async () => {
    const res = await proxy(
      req("http://127.0.0.1:3001/api/firearms", {
        method: "POST",
        headers: { host: "vault.example.com", origin: "https://evil.example", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-origin request rejected" });
  });

  it("passes the public host and emits no CORS headers", async () => {
    const res = await proxy(
      req("http://127.0.0.1:3001/vault", {
        headers: { host: "vault.example.com", origin: "https://evil.example", "x-forwarded-proto": "https" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    for (const [name] of res.headers) expect(name.toLowerCase().startsWith("access-control-allow-")).toBe(false);
  });

  it("passes a LAN host when direct access is on", async () => {
    state.allowed = true;
    const res = await proxy(req("http://10.10.10.3:3000/vault", { headers: { host: "10.10.10.3:3000" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
```

`src/app/api/internal/gate-config/route.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/direct-access", () => ({
  getDirectAccessState: vi.fn(async () => ({ allowed: true, source: "env" })),
}));

import { GET } from "./route";

describe("GET /api/internal/gate-config", () => {
  it("returns only the effective boolean", async () => {
    const res = await GET();
    expect(await res.json()).toEqual({ allowDirectAccess: true });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/proxy.test.ts src/app/api/internal/gate-config/route.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/proxy.ts`**

```ts
import { NextResponse, type NextRequest } from "next/server";
import { getPublicUrl } from "@/lib/server/public-url";
import { getDirectAccessState } from "@/lib/server/direct-access";
import { decideRequest, trustsForwardedHeaders } from "@/lib/server/request-gate";

/**
 * Runs on every request (Next 16 proxy, always the Node.js runtime). The TCP
 * gate in gate/ has already decided the connection may exist; this decides
 * what the request may do. Policy lives in request-gate.ts.
 */
export async function proxy(request: NextRequest) {
  const { allowed } = await getDirectAccessState();
  const decision = decideRequest({
    method: request.method,
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    origin: request.headers.get("origin"),
    requestProtocol: request.nextUrl.protocol === "https:" ? "https:" : "http:",
    publicUrl: getPublicUrl(),
    directAccessAllowed: allowed,
    trustForwardedHeaders: trustsForwardedHeaders(),
  });

  if (decision.kind === "redirect") return NextResponse.redirect(decision.location, 307);
  if (decision.kind === "forbidden") return NextResponse.json({ error: decision.reason }, { status: 403 });
  return NextResponse.next();
}
```

- [ ] **Step 4: Implement the internal route**

```ts
import { NextResponse } from "next/server";
import { getDirectAccessState } from "@/lib/server/direct-access";

// Polled every 5s by the TCP gate over 127.0.0.1. Reachable by any peer the
// gate passes; it exposes this one boolean and nothing else, by design.
export const dynamic = "force-dynamic";

export async function GET() {
  const { allowed } = await getDirectAccessState();
  return NextResponse.json({ allowDirectAccess: allowed });
}
```

- [ ] **Step 5: Cookie helper**

In `src/lib/server/auth.ts` add `import { isSecureRequest } from "./request-gate";` and change:

```ts
export function getSessionCookieOptions(request: Request) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Per request: behind the HTTPS proxy this is true; over direct http://ip it
    // must be false or the browser silently discards the cookie.
    secure: isSecureRequest(request),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

export function clearSessionCookie(response: NextResponse, request: Request) {
  response.cookies.set({
    name: SESSION_COOKIE_NAME,
    value: "",
    ...getSessionCookieOptions(request),
    maxAge: 0,
  });
}
```

Update the two callers to pass their `request` (`getSessionCookieOptions(request)` in unlock; `clearSessionCookie(response, request)` in logout — add a `request: Request` parameter to the logout handler if it lacks one). Change nothing else in those routes.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run src/proxy.test.ts src/app/api/internal/gate-config src/app/api/session && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 7: Verify against the built server (proxy bundling + Prisma inside proxy is unproven until run)**

```bash
npm run build
PUBLIC_URL=http://localhost:3998 PORT=3998 npm start & SERVER=$!
until curl -s -o /dev/null http://localhost:3998/api/health; do sleep 1; done
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -H 'Host: 10.1.2.3:3998' http://localhost:3998/vault
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://evil.example' http://localhost:3998/api/settings
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3998/vault
curl -s http://localhost:3998/api/internal/gate-config
kill $SERVER
```

Expected: `307 http://localhost:3998/vault`, `403`, `200`, `{"allowDirectAccess":false}`. A 500 from every route, or a build error mentioning Prisma inside `proxy`, means Prisma cannot load in the proxy bundle — stop and report; do not work around it silently.

- [ ] **Step 8: Commit**

```bash
git add src/proxy.ts src/proxy.test.ts src/app/api/internal src/lib/server/auth.ts src/app/api/session
git commit -m "feat: enforce the public URL and origin in proxy.ts; per-request cookie security"
```

---

### Task 6: Gate core — peer normalisation and trusted-proxy matching

**Files:**
- Create: `gate/gate-core.mjs`
- Test: `gate/gate-core.test.ts`

Plain JavaScript on purpose: the standalone image runs `node` directly and has no TypeScript step. vitest imports `.mjs` natively.

**Interfaces:**
- Produces:
  - `normalizePeer(address: string | undefined): string | null`
  - `isLoopback(ip: string): boolean`
  - `parseTrustedProxies(raw: string | undefined): { ips: string[]; cidrs: { address: string; prefix: number; family: "ipv4" | "ipv6" }[]; hostnames: string[]; invalid: string[] }`
  - `buildMatcher(parsed, resolvedIps: string[]): (ip: string) => boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildMatcher, isLoopback, normalizePeer, parseTrustedProxies } from "./gate-core.mjs";

describe("normalizePeer", () => {
  it.each([
    ["::ffff:10.10.10.3", "10.10.10.3"],
    ["::FFFF:10.10.10.3", "10.10.10.3"],
    ["10.10.10.3", "10.10.10.3"],
    ["::1", "::1"],
    ["fe80::1", "fe80::1"],
    [undefined, null],
    ["", null],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePeer(input)).toBe(expected);
  });
});

describe("isLoopback", () => {
  it.each([
    ["127.0.0.1", true],
    ["127.5.5.5", true],
    ["::1", true],
    ["10.10.10.3", false],
    ["172.31.0.1", false],
  ])("%s -> %s", (ip, expected) => {
    expect(isLoopback(ip)).toBe(expected);
  });
});

describe("parseTrustedProxies", () => {
  it("sorts entries by kind and reports junk", () => {
    expect(parseTrustedProxies(" 10.10.10.3, 172.28.0.0/16 ,caddy, fd00::/8, 10.0.0.0/33, bad host!, ,")).toEqual({
      ips: ["10.10.10.3"],
      cidrs: [
        { address: "172.28.0.0", prefix: 16, family: "ipv4" },
        { address: "fd00::", prefix: 8, family: "ipv6" },
      ],
      hostnames: ["caddy"],
      invalid: ["10.0.0.0/33", "bad host!"],
    });
  });

  it("treats undefined and blank as empty", () => {
    expect(parseTrustedProxies(undefined)).toEqual({ ips: [], cidrs: [], hostnames: [], invalid: [] });
    expect(parseTrustedProxies("  ")).toEqual({ ips: [], cidrs: [], hostnames: [], invalid: [] });
  });
});

describe("buildMatcher", () => {
  const parsed = parseTrustedProxies("10.10.10.3, 172.28.0.0/16, fd00::/8, caddy");

  it("matches exact IPs, CIDR members and resolved host names", () => {
    const match = buildMatcher(parsed, ["172.19.0.7"]);
    expect(match("10.10.10.3")).toBe(true);
    expect(match("172.28.255.254")).toBe(true);
    expect(match("fd00::1234")).toBe(true);
    expect(match("172.19.0.7")).toBe(true);
  });

  it("rejects everything else", () => {
    const match = buildMatcher(parsed, []);
    expect(match("10.10.10.4")).toBe(false);
    expect(match("172.29.0.1")).toBe(false);
    expect(match("172.19.0.7")).toBe(false);
    expect(match("not-an-ip")).toBe(false);
  });

  it("matches a dual-stack peer once normalised", () => {
    expect(buildMatcher(parsed, [])(normalizePeer("::ffff:10.10.10.3")!)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run gate/gate-core.test.ts`
Expected: FAIL — cannot resolve `./gate-core.mjs`.

- [ ] **Step 3: Implement**

```js
// Pure helpers for the TCP gate (gate/gate.mjs). Plain JS: the container runs
// node directly with no TypeScript step. See
// docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md.
import net from "node:net";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/** Strips the IPv4-mapped prefix a dual-stack socket reports. */
export function normalizePeer(address) {
  if (!address) return null;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") && net.isIPv4(lower.slice(7))) return lower.slice(7);
  return lower;
}

export function isLoopback(ip) {
  return ip === "::1" || (net.isIPv4(ip) && ip.startsWith("127."));
}

export function parseTrustedProxies(raw) {
  const result = { ips: [], cidrs: [], hostnames: [], invalid: [] };
  for (const token of (raw ?? "").split(",")) {
    const entry = token.trim();
    if (entry === "") continue;
    if (entry.includes("/")) {
      const [address, prefixText] = entry.split("/");
      const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
      const prefix = /^\d+$/.test(prefixText ?? "") ? Number(prefixText) : NaN;
      const max = family === "ipv4" ? 32 : 128;
      if (family && prefix >= 0 && prefix <= max) result.cidrs.push({ address: address.toLowerCase(), prefix, family });
      else result.invalid.push(entry);
    } else if (net.isIP(entry)) {
      result.ips.push(entry.toLowerCase());
    } else if (HOSTNAME.test(entry)) {
      result.hostnames.push(entry.toLowerCase());
    } else {
      result.invalid.push(entry);
    }
  }
  return result;
}

export function buildMatcher(parsed, resolvedIps) {
  const list = new net.BlockList();
  for (const ip of [...parsed.ips, ...resolvedIps]) {
    const normalised = normalizePeer(ip);
    if (normalised && net.isIP(normalised)) list.addAddress(normalised, net.isIPv4(normalised) ? "ipv4" : "ipv6");
  }
  for (const { address, prefix, family } of parsed.cidrs) list.addSubnet(address, prefix, family);
  return (ip) => {
    const family = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
    return family !== null && list.check(ip, family);
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run gate/gate-core.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove by injection**

Make `normalizePeer` return `lower` unconditionally → the dual-stack test must FAIL. Restore; `git diff --exit-code gate/gate-core.mjs`.

- [ ] **Step 6: Commit**

```bash
git add gate/gate-core.mjs gate/gate-core.test.ts
git commit -m "feat: gate core — peer normalisation and trusted-proxy matching"
```

---

### Task 7: The TCP gate — reset untrusted peers, pipe the rest

**Files:**
- Create: `gate/gate-server.mjs`
- Create: `gate/gate.mjs` (container entry point)
- Test: `gate/gate-server.test.ts`

**Interfaces:**
- Consumes: Task 6 helpers; `GET /api/internal/gate-config` (Task 5)
- Produces:
  - `createGate({ upstreamHost, upstreamPort, isTrusted, getDirectAccess, trustLoopback = true, log = console }) → { server: net.Server, dropUntrusted(): void }`
  - `createDirectAccessTracker(initial: boolean, onTurnedOff: () => void) → { get(): boolean, set(value: boolean): void }`

`trustLoopback` exists only so tests (which always connect from 127.0.0.1) can exercise the untrusted path. Production never sets it.

- [ ] **Step 1: Write the failing test**

```ts
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectAccessTracker, createGate } from "./gate-server.mjs";

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port)));
}

async function echoUpstream(): Promise<number> {
  const upstream = net.createServer((s) => s.pipe(s));
  closers.push(() => upstream.close());
  return listen(upstream);
}

function outcome(port: number, payload = "ping"): Promise<{ data?: string; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(payload));
    socket.once("data", (d) => {
      resolve({ data: d.toString() });
      socket.destroy();
    });
    socket.once("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code }));
  });
}

const quiet = { warn() {}, error() {}, log() {} };

describe("createGate", () => {
  it("resets an untrusted peer with ECONNRESET when direct access is off", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => false, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ error: "ECONNRESET" });
  });

  it("pipes a trusted peer to upstream", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => true, getDirectAccess: () => false, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ data: "ping" });
  });

  it("pipes loopback by default (the healthcheck)", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ data: "ping" });
  });

  it("pipes an untrusted peer when direct access is on", async () => {
    const upstreamPort = await echoUpstream();
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => true, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    expect(await outcome(await listen(gate.server))).toEqual({ data: "ping" });
  });

  it("resets open untrusted connections when direct access turns off", async () => {
    const upstreamPort = await echoUpstream();
    let direct = true;
    const gate = createGate({ upstreamPort, isTrusted: () => false, getDirectAccess: () => direct, trustLoopback: false, log: quiet });
    closers.push(() => gate.server.close());
    const port = await listen(gate.server);

    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    socket.write("hello");
    await new Promise((r) => socket.once("data", r));

    const closed = new Promise<string | undefined>((resolve) =>
      socket.once("error", (e: NodeJS.ErrnoException) => resolve(e.code)),
    );
    direct = false;
    gate.dropUntrusted();
    expect(await closed).toBe("ECONNRESET");
  });

  it("logs a rejected peer once per minute, not per connection", async () => {
    const upstreamPort = await echoUpstream();
    const warnings: string[] = [];
    const gate = createGate({
      upstreamPort,
      isTrusted: () => false,
      getDirectAccess: () => false,
      trustLoopback: false,
      log: { ...quiet, warn: (m: string) => warnings.push(m) },
    });
    closers.push(() => gate.server.close());
    const port = await listen(gate.server);
    await outcome(port);
    await outcome(port);
    expect(warnings).toEqual(["[gate] rejected 127.0.0.1 (not a trusted proxy; direct access off)"]);
  });
});

describe("createDirectAccessTracker", () => {
  it("fires onTurnedOff only on a true -> false transition", () => {
    let fired = 0;
    const t = createDirectAccessTracker(false, () => fired++);
    t.set(false);
    t.set(true);
    t.set(true);
    t.set(false);
    t.set(false);
    expect(fired).toBe(1);
    expect(t.get()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run gate/gate-server.test.ts`
Expected: FAIL — cannot resolve `./gate-server.mjs`.

- [ ] **Step 3: Implement `gate/gate-server.mjs`**

```js
// The TCP gate: decides whether a connection may exist, before any HTTP is
// read. Untrusted peers are reset (the client sees ECONNRESET) when direct
// access is off. Everything else is piped byte-for-byte to Next.
import net from "node:net";
import { isLoopback, normalizePeer } from "./gate-core.mjs";

const LOG_INTERVAL_MS = 60_000;

export function createGate({
  upstreamHost = "127.0.0.1",
  upstreamPort,
  isTrusted,
  getDirectAccess,
  trustLoopback = true,
  log = console,
}) {
  const untrusted = new Set();
  const lastLogged = new Map();

  function logRejected(peer) {
    const now = Date.now();
    const key = peer ?? "unknown";
    if (now - (lastLogged.get(key) ?? -Infinity) < LOG_INTERVAL_MS) return;
    lastLogged.set(key, now);
    log.warn(`[gate] rejected ${key} (not a trusted proxy; direct access off)`);
  }

  const server = net.createServer((client) => {
    const peer = normalizePeer(client.remoteAddress);
    const trusted = peer !== null && ((trustLoopback && isLoopback(peer)) || isTrusted(peer));

    if (!trusted && !getDirectAccess()) {
      logRejected(peer);
      client.resetAndDestroy();
      return;
    }

    const upstream = net.connect(upstreamPort, upstreamHost);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", close);
    upstream.on("close", close);
    client.pipe(upstream);
    upstream.pipe(client);

    if (!trusted) {
      untrusted.add(client);
      client.on("close", () => untrusted.delete(client));
    }
  });

  return {
    server,
    dropUntrusted() {
      for (const socket of untrusted) socket.resetAndDestroy();
      untrusted.clear();
    },
  };
}

export function createDirectAccessTracker(initial, onTurnedOff) {
  let value = initial;
  return {
    get: () => value,
    set(next) {
      const turnedOff = value && !next;
      value = next;
      if (turnedOff) onTurnedOff();
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run gate/gate-server.test.ts`
Expected: PASS. If the reset test sees `undefined` or `EPIPE` instead of `ECONNRESET`, the gate is closing, not resetting — fix the gate, never loosen the assertion.

- [ ] **Step 5: Implement the entry `gate/gate.mjs`**

```js
// Container entry point (Dockerfile CMD). Owns the public port, starts Next's
// standalone server on 127.0.0.1:3001 in this same process, and gates every
// connection. Dev (`npm run dev`) does not use this file.
import dns from "node:dns/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildMatcher, parseTrustedProxies } from "./gate-core.mjs";
import { createDirectAccessTracker, createGate } from "./gate-server.mjs";

const GATE_PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_PORT = 3001;
const POLL_MS = 5_000;
const RESOLVE_MS = 30_000;

const parsed = parseTrustedProxies(process.env.TRUSTED_PROXIES);
for (const entry of parsed.invalid) console.warn(`[gate] ignoring invalid BLACKVAULT_TRUSTED_PROXIES entry: ${entry}`);

const resolved = new Map(); // host name -> last good IPs
let matcher = buildMatcher(parsed, []);

async function resolveHostnames() {
  for (const name of parsed.hostnames) {
    try {
      const addresses = await dns.lookup(name, { all: true });
      resolved.set(name, addresses.map((a) => a.address));
    } catch (error) {
      console.warn(`[gate] could not resolve trusted proxy "${name}"; keeping the last good address: ${error.code ?? error}`);
    }
  }
  matcher = buildMatcher(parsed, [...resolved.values()].flat());
}

await resolveHostnames();
setInterval(resolveHostnames, RESOLVE_MS).unref();

const forced = process.env.ALLOW_DIRECT_ACCESS === "true";
if (parsed.ips.length + parsed.cidrs.length + parsed.hostnames.length === 0 && !forced) {
  console.warn("[gate] BLACKVAULT_TRUSTED_PROXIES is empty: while direct access is off, all non-loopback connections will be reset");
}
try {
  await dns.lookup("host.docker.internal");
  console.warn("[gate] Docker Desktop detected: peer addresses are unreliable here, so trusted-proxy matching may not tell your proxy apart from other clients");
} catch {
  // Not Docker Desktop.
}

let gate;
const tracker = createDirectAccessTracker(forced, () => gate.dropUntrusted());
gate = createGate({
  upstreamPort: UPSTREAM_PORT,
  isTrusted: (ip) => matcher(ip),
  getDirectAccess: () => tracker.get(),
});

setInterval(async () => {
  try {
    const res = await fetch(`http://127.0.0.1:${UPSTREAM_PORT}/api/internal/gate-config`);
    const body = await res.json();
    tracker.set(body.allowDirectAccess === true);
  } catch {
    // Next still starting, or briefly unavailable: keep the current value.
  }
}, POLL_MS).unref();

gate.server.listen(GATE_PORT, () => console.log(`[gate] listening on :${GATE_PORT}, upstream 127.0.0.1:${UPSTREAM_PORT}`));

// Next's standalone server reads PORT and HOSTNAME when it loads.
process.env.PORT = String(UPSTREAM_PORT);
process.env.HOSTNAME = "127.0.0.1";
await import(pathToFileURL(path.resolve(process.cwd(), "server.js")).href);
```

- [ ] **Step 6: Prove by injection**

Replace `client.resetAndDestroy()` with `client.destroy()` → the ECONNRESET test must FAIL. Make `set()` fire on every `false` → the tracker test must FAIL. Restore; `git diff --exit-code gate/gate-server.mjs`.

- [ ] **Step 7: Commit**

```bash
git add gate/
git commit -m "feat: TCP gate — reset untrusted peers, pipe trusted ones to Next"
```

---

### Task 8: Container wiring and a run of the real image

**Files:**
- Modify: `Dockerfile` (runner stage: COPY, CMD)
- Modify: `docker-compose.yml:72-77`, `docker-compose.dev.yml` (blackvault `environment:`)
- Inspect: `docker-compose.migrate.yml` — add the env only if it runs the app server

**Interfaces:**
- Consumes: `gate/gate.mjs` (Task 7)

- [ ] **Step 1: Dockerfile**

After `COPY --from=builder /app/public ./public` add:

```dockerfile
# The TCP gate owns port 3000 and starts Next on 127.0.0.1:3001 in-process.
COPY --from=builder /app/gate ./gate
```

In the `CMD`, replace the final `&& node server.js"]` with `&& node gate/gate.mjs"]`. Leave `ENV PORT=3000` and `ENV HOSTNAME` as they are (the gate reads `PORT` for its own port, then overrides both for Next).

Confirm the builder stage copies `gate/` (check its `COPY . .` or equivalent). If it copies a filtered set, add `gate`. Check `.dockerignore` does not exclude `gate/`.

- [ ] **Step 2: Compose**

In `docker-compose.yml` under the `blackvault` service `environment:`, after `DATABASE_URL`:

```yaml
      # Required: the address people open BlackVault at, normally your reverse
      # proxy's HTTPS URL. The app will not start without it.
      - PUBLIC_URL=${BLACKVAULT_PUBLIC_URL:-}
      # Comma-separated IPs, CIDRs or host names of your reverse proxy.
      - TRUSTED_PROXIES=${BLACKVAULT_TRUSTED_PROXIES:-}
      # Break-glass: "true" serves http://<ip>:<port> whatever the setting says.
      - ALLOW_DIRECT_ACCESS=${BLACKVAULT_ALLOW_DIRECT_ACCESS:-}
      # One-time seed written by the installers; ignored once the setting exists.
      - DIRECT_ACCESS_INITIAL=${BLACKVAULT_DIRECT_ACCESS_INITIAL:-}
```

In `docker-compose.dev.yml`, add `- PUBLIC_URL=${BLACKVAULT_PUBLIC_URL:-http://localhost:3000}` and `- ALLOW_DIRECT_ACCESS=${BLACKVAULT_ALLOW_DIRECT_ACCESS:-true}` (dev compose is a developer tool; open by default).

- [ ] **Step 3: Run the real image — a green build proves nothing here**

```bash
docker build -t bv-gate-test .
docker run --rm -d --name bv-gate-test -p 3997:3000 \
  -e DATABASE_URL=file:/app/data/vault.db -e PUBLIC_URL=https://vault.example.com bv-gate-test
sleep 15
docker logs bv-gate-test 2>&1 | tail -20
docker exec bv-gate-test wget -qO- http://127.0.0.1:3000/api/health; echo " <- healthcheck"
# From another container, straight to the gate: no host port-forwarder in the way.
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' bv-gate-test)
docker run --rm curlimages/curl -sS "http://$IP:3000/" -o /dev/null; echo "curl exit=$? (expect 56 = connection reset)"
# Through the published port. Docker Desktop's forwarder may turn the RST into a
# plain close (curl 52); record which you see — 56 or 52 both mean refused.
curl -sS http://localhost:3997/ -o /dev/null; echo "host curl exit=$?"
docker logs bv-gate-test 2>&1 | grep '\[gate\] rejected'
docker rm -f bv-gate-test

docker run --rm -d --name bv-gate-test -p 3997:3000 -e ALLOW_DIRECT_ACCESS=true \
  -e DATABASE_URL=file:/app/data/vault.db -e PUBLIC_URL=https://vault.example.com bv-gate-test
sleep 15
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3997/api/health
docker rm -f bv-gate-test

docker run --rm --name bv-gate-test -e DATABASE_URL=file:/app/data/vault.db bv-gate-test; echo "exit=$? (expect 1)"
```

Expected, in order: logs show `[gate] listening on :3000` and the empty-trusted-proxies warning; healthcheck prints JSON; `curl exit=56`; a `[gate] rejected <docker gateway IP>` line; then `200`; then the `[startup] BLACKVAULT_PUBLIC_URL is not set` message and `exit=1`. Note: on Docker Desktop (this Mac) the gate also logs the Docker Desktop warning — expected.

Record the actual outputs in the task report.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile docker-compose.yml docker-compose.dev.yml
git commit -m "build: run the TCP gate in front of Next; pass the public-URL settings through compose"
```

---

### Task 9: Mobile Access UI and the LAN banner follow direct access

**Files:**
- Modify: `src/app/api/network/local-access/route.ts`
- Test: `src/app/api/network/local-access/route.test.ts`
- Modify: `src/app/settings/page.tsx:98-124` (fetch + QR), `:494-560` (Mobile Access section)
- Modify: `src/components/dashboard/LanBanner.tsx`
- Test: `src/components/dashboard/LanBanner.test.tsx`

**Interfaces:**
- Consumes: `getDirectAccessState` (2), `getPublicUrl` (1)
- Produces: `/api/network/local-access` response gains `publicUrl: string` and `directAccess: { allowed: boolean; source: "env" | "setting" }`.

- [ ] **Step 1: Write the failing route test**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ allowed: false, source: "setting" as "env" | "setting" }));
vi.mock("@/lib/server/direct-access", () => ({ getDirectAccessState: vi.fn(async () => ({ ...state })) }));
vi.mock("@/lib/network/get-local-ip", () => ({ getLocalIp: () => "10.10.10.3", isDockerEnvironment: () => true }));

import { GET } from "./route";
import { resetPublicUrlCacheForTests } from "@/lib/server/public-url";

beforeEach(() => {
  process.env.PUBLIC_URL = "https://vault.example.com";
  resetPublicUrlCacheForTests();
});

describe("GET /api/network/local-access", () => {
  it("reports the public URL and the direct-access state", async () => {
    state.allowed = true;
    state.source = "env";
    const body = await (await GET()).json();
    expect(body.publicUrl).toBe("https://vault.example.com");
    expect(body.directAccess).toEqual({ allowed: true, source: "env" });
    expect(body.url).toBe("http://10.10.10.3:3000");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/network/local-access/route.test.ts`
Expected: FAIL — `publicUrl` undefined.

- [ ] **Step 3: Implement the route change**

Import `getDirectAccessState` and `getPublicUrl`. At the start of `GET`, compute:

```ts
  const directAccess = await getDirectAccessState();
  const publicUrl = getPublicUrl().origin;
```

and add `publicUrl, directAccess,` to BOTH `NextResponse.json({...})` success bodies and the catch body. Leave every existing field unchanged.

- [ ] **Step 4: Settings page**

Add state: `const [publicUrl, setPublicUrl] = useState("");` and `const [directAccess, setDirectAccess] = useState<{ allowed: boolean; source: "env" | "setting" } | null>(null);`. In the existing `/api/network/local-access` effect's `.then`, add `setPublicUrl(data.publicUrl ?? ""); setDirectAccess(data.directAccess ?? null);`.

Replace the QR effect's URL with the one the spec calls for:

```tsx
  const directAllowed = directAccess?.allowed ?? false;
  const qrTarget = directAllowed ? finalLanUrl : publicUrl;

  useEffect(() => {
    if (qrTarget) {
      import("qrcode").then((QRCode) => {
        QRCode.toDataURL(qrTarget, { width: 160, margin: 2 }).then(setQrDataUrl).catch(() => {});
      });
    } else {
      setQrDataUrl("");
    }
  }, [qrTarget]);
```

In the Mobile Access `SectionCard`, as the first child of `<div className="space-y-4">`:

```tsx
            {directAccess ? (
              <p className="text-xs text-vault-text-muted">
                Direct access: {directAccess.allowed ? "On" : "Off"}{" "}
                {directAccess.source === "env" ? "(forced by BLACKVAULT_ALLOW_DIRECT_ACCESS)" : "(setting)"}.{" "}
                {directAccess.source === "env"
                  ? "Remove BLACKVAULT_ALLOW_DIRECT_ACCESS from .env and restart to use the setting."
                  : "Change it by re-running ./update.sh (update.bat on Windows); an in-app switch arrives with user accounts."}
              </p>
            ) : null}

            {directAllowed ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400">
                ⚠️ Direct access is on. Anyone on your network can reach BlackVault at{" "}
                <span className="font-mono">{finalLanUrl || "http://<ip>:<port>"}</span> without HTTPS. Logins over
                that address are sent unencrypted.
              </div>
            ) : (
              <div className="rounded-lg border border-vault-border bg-vault-bg p-3">
                <p className="text-xs uppercase tracking-widest text-vault-text-faint">BlackVault address</p>
                <p className="mt-1 break-all font-mono text-sm text-vault-text">{publicUrl}</p>
              </div>
            )}
```

Wrap the existing manual-host `FormField`, the Docker notice, the Mobile URL box / error message, and the Copy button block in `{directAllowed ? (<>…</>) : null}` so they render only when direct access is on. The QR `<img>` block stays outside the wrapper (it now shows `qrTarget`).

- [ ] **Step 5: LanBanner — failing test first**

`src/components/dashboard/LanBanner.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanBanner } from "./LanBanner";

function mockFetch(body: object) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => body })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("LanBanner", () => {
  it("shows the LAN URL when direct access is on", async () => {
    mockFetch({ url: "http://10.10.10.3:3000", directAccess: { allowed: true, source: "setting" } });
    render(<LanBanner />);
    await waitFor(() => expect(screen.getByText("http://10.10.10.3:3000")).toBeTruthy());
  });

  it("renders nothing when direct access is off", async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ url: "http://10.10.10.3:3000", directAccess: { allowed: false, source: "setting" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<LanBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
```

Note: jsdom's default `window.location.hostname` is `localhost`, which the banner suppresses. If both tests render nothing for that reason, set the URL before render with `window.history.replaceState({}, "", "http://10.10.10.3:3000/")` — if jsdom refuses a cross-origin replace, configure the file's environment URL with `// @vitest-environment-options {"url":"http://10.10.10.3:3000/"}` on the line after the environment comment.

Run: `npx vitest run src/components/dashboard/LanBanner.test.tsx` — expected: the "off" test FAILS (banner still renders).

- [ ] **Step 6: LanBanner — implement**

In the fetch `.then`, change the condition:

```tsx
        const lanUrl = data?.url as string | null;
        if (lanUrl && data?.directAccess?.allowed === true) {
```

- [ ] **Step 7: Run all of it**

Run: `npx vitest run src/app/api/network src/components/dashboard/LanBanner.test.tsx && npm run typecheck && npm run lint`
Expected: PASS, clean.

- [ ] **Step 8: Browser check**

`PUBLIC_URL=http://localhost:3000 npm run dev`, open `/settings` at 390px width: status line reads "Direct access: Off (setting)", public URL box shown, QR present, no manual-host field. Stop, restart with `ALLOW_DIRECT_ACCESS=true` added: warning box, LAN URL box and manual-host field shown. Screenshot both.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/network src/app/settings/page.tsx src/components/dashboard/LanBanner.tsx src/components/dashboard/LanBanner.test.tsx
git commit -m "feat: Mobile Access and the LAN banner follow the direct-access setting"
```

---

### Task 10: Unix installers, update script and dev.sh

**Files:**
- Create: `scripts/public-url-prompts.sh` (sourced by `install.sh` and `update.sh`)
- Test: `scripts/public-url-prompts.test.ts`
- Modify: `install.sh` (after the Port prompt ~line 118; `.env` heredocs ~180-195; summary ~231)
- Modify: `update.sh` (after the git pull block ~line 103, before "Rebuild"; summary ~137)
- Modify: `dev.sh:124-131`

**Interfaces:**
- Produces (shell functions):
  - `valid_public_url URL` → exit 0/1
  - `set_env_value FILE KEY VALUE` — replaces or appends one key; keeps `FILE.bak`
  - `prompt_public_url [CURRENT]` → prints the chosen URL on stdout; prompts on stderr
  - `prompt_trusted_proxies` → prints the entered list (may be empty)
  - `prompt_yes_no QUESTION DEFAULT(y|n)` → prints `y` or `n`

- [ ] **Step 1: Write the failing test**

```ts
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB = path.join(__dirname, "public-url-prompts.sh");

function bash(script: string, stdin = "", args: string[] = []) {
  const r = spawnSync("bash", ["-c", `. "${LIB}"; ${script}`, "bash", ...args], { encoding: "utf8", input: stdin });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("valid_public_url", () => {
  it.each([
    ["https://vault.example.com", 0],
    ["https://vault.example.com/", 0],
    ["http://localhost:3000", 0],
    ["https://vault.example.com:8443", 0],
    ["vault.example.com", 1],
    ["https://vault.example.com/vault", 1],
    ["https://vault.example.com/?x", 1],
    ["https://vault example.com", 1],
    ["ftp://vault.example.com", 1],
    ["", 1],
  ])("%s -> %i", (url, code) => {
    expect(bash('valid_public_url "$1"', "", [url]).code).toBe(code);
  });
});

describe("set_env_value", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "bv-env-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("replaces one key, keeps every other line byte-identical (CRLF too), writes .bak", () => {
    const file = path.join(dir, ".env");
    const original = "DATA_DIR=/srv/bv\r\nBLACKVAULT_PUBLIC_URL=https://old.example.com\r\nPORT=3000\n";
    fs.writeFileSync(file, original);
    expect(bash('set_env_value "$1" BLACKVAULT_PUBLIC_URL "https://new.example.com:8443"', "", [file]).code).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("DATA_DIR=/srv/bv\r\nPORT=3000\nBLACKVAULT_PUBLIC_URL=https://new.example.com:8443\n");
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(original);
  });

  it("appends when the key is absent and does not interpret & or |", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PORT=3000\n");
    bash('set_env_value "$1" BLACKVAULT_TRUSTED_PROXIES "a&b|c"', "", [file]);
    expect(fs.readFileSync(file, "utf8")).toBe("PORT=3000\nBLACKVAULT_TRUSTED_PROXIES=a&b|c\n");
  });

  it("does not touch a key that merely starts with the same text", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "BLACKVAULT_PUBLIC_URL_OLD=x\n");
    bash('set_env_value "$1" BLACKVAULT_PUBLIC_URL "https://v.example.com"', "", [file]);
    expect(fs.readFileSync(file, "utf8")).toBe("BLACKVAULT_PUBLIC_URL_OLD=x\nBLACKVAULT_PUBLIC_URL=https://v.example.com\n");
  });
});

describe("prompt_public_url", () => {
  it("re-prompts until valid", () => {
    const r = bash("prompt_public_url", "nope\nhttps://vault.example.com/\n");
    expect(r.out.trim()).toBe("https://vault.example.com/");
    expect(r.err).toContain("must start with http:// or https://");
  });

  it("keeps the current value on Enter / y", () => {
    expect(bash('prompt_public_url "$1"', "\n", ["https://cur.example.com"]).out.trim()).toBe("https://cur.example.com");
  });

  it("asks for a new value on n", () => {
    expect(bash('prompt_public_url "$1"', "n\nhttps://new.example.com\n", ["https://cur.example.com"]).out.trim()).toBe(
      "https://new.example.com",
    );
  });
});

describe("prompt_yes_no", () => {
  it.each([
    ["\n", "y", "y"],
    ["\n", "n", "n"],
    ["N\n", "y", "n"],
    ["yes\n", "n", "y"],
    ["maybe\nn\n", "y", "n"],
  ])("input %j default %s -> %s", (stdin, def, expected) => {
    expect(bash('prompt_yes_no "Q?" "$1"', stdin, [def]).out.trim()).toBe(expected);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run scripts/public-url-prompts.test.ts`
Expected: FAIL — `public-url-prompts.sh: No such file`.

- [ ] **Step 3: Implement `scripts/public-url-prompts.sh`**

```bash
# shellcheck shell=bash
# Public-URL and direct-access prompts, sourced by install.sh and update.sh.
# install.bat / update.bat duplicate this logic: change them together.
# Prompts go to stderr so callers can capture the answer from stdout.
# The app validates BLACKVAULT_PUBLIC_URL authoritatively at startup; this is
# a shape check to catch typos before a rebuild.

valid_public_url() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]
}

# set_env_value FILE KEY VALUE — replace or append KEY=VALUE, keep FILE.bak.
# grep -v, not sed: the value is never interpreted, so & | / are safe.
set_env_value() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  cp "$file" "${file}.bak"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

prompt_yes_no() {
  local question="$1" default="$2" hint answer
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while true; do
    read -rp "$question $hint: " answer >&2 || answer=""
    case "$(printf '%s' "${answer:-$default}" | tr '[:upper:]' '[:lower:]')" in
      y|yes) echo y; return ;;
      n|no) echo n; return ;;
      *) echo "  Please answer y or n." >&2 ;;
    esac
  done
}

prompt_public_url() {
  local current="${1:-}" url
  if [ -n "$current" ]; then
    echo "" >&2
    echo "Public URL is: $current" >&2
    if [ "$(prompt_yes_no "Is this still current?" y)" = "y" ]; then
      echo "$current"
      return
    fi
  fi
  echo "" >&2
  echo "Public URL: the address people open BlackVault at, normally your reverse" >&2
  echo "proxy's HTTPS address, e.g. https://vault.example.com" >&2
  while true; do
    read -rp "Public URL: " url >&2 || url=""
    url="$(printf '%s' "$url" | tr -d '[:space:]')"
    if valid_public_url "$url"; then
      echo "$url"
      return
    fi
    echo "  The URL must start with http:// or https:// and have no path, e.g. https://vault.example.com" >&2
  done
}

prompt_trusted_proxies() {
  local proxies
  echo "" >&2
  echo "Trusted proxies: IPs, CIDR ranges or host names your reverse proxy connects" >&2
  echo "from, comma-separated (e.g. 172.28.0.0/16). Leave blank if you have none yet." >&2
  read -rp "Trusted proxies []: " proxies >&2 || proxies=""
  printf '%s\n' "$(printf '%s' "$proxies" | tr -d '[:space:]')"
}
```

Note on `read -rp ... >&2`: bash writes the `-p` prompt to stderr only when input is a terminal. The tests feed stdin from a pipe, so prompts do not appear in `r.err` — only the explicit `echo ... >&2` lines do. That is why the re-prompt test asserts on the error message, not on "Public URL:".

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run scripts/public-url-prompts.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `install.sh`**

After `. scripts/compose-provider.sh` (or wherever install.sh sources it), add `. scripts/public-url-prompts.sh`. After `PORT="${PORT_INPUT:-3000}"`:

```bash
# ── Public URL, trusted proxies, direct access ────────────────
PUBLIC_URL=$(prompt_public_url)
TRUSTED_PROXIES=$(prompt_trusted_proxies)
DIRECT_ACCESS_INITIAL=""
if [ -z "$TRUSTED_PROXIES" ]; then
  echo ""
  echo "No trusted proxy set. With direct access off, every connection to"
  echo "BlackVault would be reset until you configure one."
  if [ "$(prompt_yes_no "Allow direct access until your proxy is set up?" y)" = "y" ]; then
    DIRECT_ACCESS_INITIAL="on"
  fi
fi
```

Append to BOTH `.env` heredocs:

```
BLACKVAULT_PUBLIC_URL=$PUBLIC_URL
BLACKVAULT_TRUSTED_PROXIES=$TRUSTED_PROXIES
BLACKVAULT_DIRECT_ACCESS_INITIAL=$DIRECT_ACCESS_INITIAL
```

Change the summary line to `echo "  URL:         $PUBLIC_URL"` and, when `DIRECT_ACCESS_INITIAL=on`, add `echo "  Direct:      http://<this machine's IP>:$PORT (direct access on)"`.

- [ ] **Step 6: Wire `update.sh`**

Source `scripts/public-url-prompts.sh` next to `compose-provider.sh`. Immediately before `# ── Rebuild and restart`:

```bash
# ── Public URL, trusted proxies, direct access ────────────────
# BLACKVAULT_PUBLIC_URL is required from this release on: the container will
# not start without it.
CURRENT_URL=$(env_value BLACKVAULT_PUBLIC_URL)
NEW_URL=$(prompt_public_url "$CURRENT_URL")
[ "$NEW_URL" = "$CURRENT_URL" ] || set_env_value .env BLACKVAULT_PUBLIC_URL "$NEW_URL"

if ! grep -q '^BLACKVAULT_DIRECT_ACCESS_INITIAL=' .env; then
  echo ""
  echo "This release can refuse connections that bypass your reverse proxy."
  if [ "$(prompt_yes_no "Keep allowing direct access by IP (http://<ip>:<port>)?" y)" = "y" ]; then
    set_env_value .env BLACKVAULT_DIRECT_ACCESS_INITIAL on
  else
    set_env_value .env BLACKVAULT_DIRECT_ACCESS_INITIAL off
  fi
fi

if ! grep -q '^BLACKVAULT_TRUSTED_PROXIES=' .env; then
  set_env_value .env BLACKVAULT_TRUSTED_PROXIES "$(prompt_trusted_proxies)"
fi
```

Change the summary `URL:` line to print `$(env_value BLACKVAULT_PUBLIC_URL)`.

- [ ] **Step 7: `dev.sh`**

In the new-`.env` heredoc add `PUBLIC_URL=http://localhost:$PORT` and `ALLOW_DIRECT_ACCESS=true` (so a phone on the LAN still reaches the dev server). In the `".env already present"` branch, append each key only if missing:

```bash
elif grep -q '^DATABASE_URL=' .env; then
  grep -q '^PUBLIC_URL=' .env || { printf 'PUBLIC_URL=http://localhost:%s\n' "$PORT" >> .env; ok "added PUBLIC_URL to .env"; }
  grep -q '^ALLOW_DIRECT_ACCESS=' .env || { printf 'ALLOW_DIRECT_ACCESS=true\n' >> .env; ok "added ALLOW_DIRECT_ACCESS to .env"; }
  ok ".env already present — leaving the rest alone"
```

- [ ] **Step 8: Exercise the real scripts, not only the helper**

```bash
bash -n install.sh update.sh dev.sh scripts/public-url-prompts.sh
```

That is only a syntax check. The meaningful check: in a scratch clone with a stub `docker` on `PATH` (copy the pattern from `scripts/compose-provider.test.ts`'s `require_compose` tests), run `printf 'https://vault.example.com\n\ny\n' | ./install.sh` and assert the resulting `.env` has the three keys. Add this as a case in `scripts/public-url-prompts.test.ts` if the stub pattern allows it in under ~40 lines; otherwise record the manual run's `.env` in the task report.

- [ ] **Step 9: Commit**

```bash
git add scripts/public-url-prompts.sh scripts/public-url-prompts.test.ts install.sh update.sh dev.sh
git commit -m "feat: installers and update prompt for the public URL, trusted proxies and direct access"
```

---

### Task 11: Windows installers and the Windows CI harness

**Files:**
- Modify: `install.bat` (after the Port prompt ~line 146; `.env` echo blocks ~226-234; summary ~283)
- Modify: `update.bat` (new code BELOW the landing pad, before the rebuild; summary ~301; `:read_env` ~436)
- Modify: `scripts/ci/windows/Test-WindowsInstallers.ps1` (every `-Answers` array; new scenarios)
- Test: `scripts/update-bat-landing-pad.test.ts` (existing — must stay green)

**Interfaces:**
- Mirrors Task 10's behaviour exactly. Prompt order in `install.bat`: data dir → port → **public URL → trusted proxies → (if blank) allow direct access** → database.

- [ ] **Step 1: Update the harness first (failing)**

Every existing `Invoke-Bat -Script "install.bat" -Answers @(...)` now needs the three new answers after the port answer. Scenario 1 becomes `@("", "", "https://vault.example.com", "", "", "1")`; apply the same insertion to scenarios 2-5. Then add scenarios:

```powershell
# ---------------------------------------------------------------- scenario P1
Write-Scenario "install.bat writes the public URL and seeds direct access on when no proxy is given"
$d = New-Sandbox "p1"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com", "", "", "2")
Show-EvidenceIfFailed $r
Assert ((Get-EnvValue $d "BLACKVAULT_PUBLIC_URL") -eq "https://vault.example.com") "public URL written"
Assert ((Get-EnvValue $d "BLACKVAULT_DIRECT_ACCESS_INITIAL") -eq "on") "direct access seeded on"

# ---------------------------------------------------------------- scenario P2
Write-Scenario "install.bat re-prompts on a URL with a path, and a proxy means no direct-access question"
$d = New-Sandbox "p2"
$r = Invoke-Bat -Dir $d -Script "install.bat" -Answers @("", "", "https://vault.example.com/vault", "https://vault.example.com", "10.10.10.3", "2")
Show-EvidenceIfFailed $r
Assert ($r.Output -match "no path") "invalid URL explained"
Assert ((Get-EnvValue $d "BLACKVAULT_TRUSTED_PROXIES") -eq "10.10.10.3") "trusted proxies written"
Assert ([string]::IsNullOrEmpty((Get-EnvValue $d "BLACKVAULT_DIRECT_ACCESS_INITIAL"))) "no seed when a proxy is set"
```

Add the update.bat equivalents to the existing update scenarios: an `.env` without `BLACKVAULT_PUBLIC_URL` must be prompted and written; an `.env` with it must ask "still current" and keep it on Enter; the first run must write `BLACKVAULT_DIRECT_ACCESS_INITIAL=on` on Enter; a second run must NOT ask again (assert the prompt text is absent from the output).

These run only on `windows-latest` in CI. Push the branch and let the `windows-installers` job show them failing before Step 2.

- [ ] **Step 2: Implement in `install.bat`**

After the port block (line ~146):

```bat
:: ── Public URL, trusted proxies, direct access ────────────────
:: Mirrors scripts/public-url-prompts.sh. The app validates the URL at startup;
:: this is a shape check to catch typos before a build.
echo.
echo Public URL: the address people open BlackVault at, normally your reverse
echo proxy's HTTPS address, e.g. https://vault.example.com
:ask_public_url
set "PUBLIC_URL="
set /p "PUBLIC_URL=Public URL: "
if defined PUBLIC_URL set "PUBLIC_URL=!PUBLIC_URL: =!"
call :valid_public_url "!PUBLIC_URL!"
if errorlevel 1 (
  echo   The URL must start with http:// or https:// and have no path, e.g. https://vault.example.com
  goto ask_public_url
)
echo.
echo Trusted proxies: IPs, CIDR ranges or host names your reverse proxy connects
echo from, comma-separated. Leave blank if you have none yet.
set "TRUSTED_PROXIES="
set /p "TRUSTED_PROXIES=Trusted proxies []: "
if defined TRUSTED_PROXIES set "TRUSTED_PROXIES=!TRUSTED_PROXIES: =!"
set "DIRECT_ACCESS_INITIAL="
if not defined TRUSTED_PROXIES (
  echo.
  echo No trusted proxy set. With direct access off, every connection to
  echo BlackVault would be reset until you configure one.
  set "DA_INPUT="
  set /p "DA_INPUT=Allow direct access until your proxy is set up? [Y/n]: "
  if /i not "!DA_INPUT!"=="n" if /i not "!DA_INPUT!"=="no" set "DIRECT_ACCESS_INITIAL=on"
)
```

Add, at the bottom with the other subroutines:

```bat
:: :valid_public_url "URL" — errorlevel 0 if http(s)://host[:port][/], else 1.
:valid_public_url
set "VPU=%~1"
if not defined VPU exit /b 1
set "VPU_REST="
if /i "!VPU:~0,8!"=="https://" set "VPU_REST=!VPU:~8!"
if /i "!VPU:~0,7!"=="http://" set "VPU_REST=!VPU:~7!"
if not defined VPU_REST exit /b 1
if "!VPU_REST:~-1!"=="/" set "VPU_REST=!VPU_REST:~0,-1!"
if not defined VPU_REST exit /b 1
echo(!VPU_REST!| findstr /r /x "[A-Za-z0-9.-]*[A-Za-z0-9]:*[0-9]*" >nul || exit /b 1
echo(!VPU_REST!| findstr /c:"/" >nul && exit /b 1
exit /b 0
```

In both `.env` echo blocks, after `echo PORT=!PORT!`:

```bat
  echo BLACKVAULT_PUBLIC_URL=!PUBLIC_URL!
  echo BLACKVAULT_TRUSTED_PROXIES=!TRUSTED_PROXIES!
  echo BLACKVAULT_DIRECT_ACCESS_INITIAL=!DIRECT_ACCESS_INITIAL!
```

Summary: `echo   URL:         !PUBLIC_URL!`.

- [ ] **Step 3: Implement in `update.bat` — BELOW the landing pad only**

Extend `:read_env` to also set `ENV_PUBLIC_URL`, `ENV_TRUSTED_PROXIES` and `ENV_DA_INITIAL` (add `set "ENV_PUBLIC_URL="` etc. at its top and `if "%%A"=="BLACKVAULT_PUBLIC_URL" set "ENV_PUBLIC_URL=%%B"` etc. in its loop, following the existing `PORT` line). Add a subroutine:

```bat
:: :set_env_value KEY VALUE — replace or append KEY=VALUE in .env, keep .env.bak.
:set_env_value
copy /y ".env" ".env.bak" >nul
findstr /v /b /c:"%~1=" ".env" > ".env.tmp"
>> ".env.tmp" echo %~1=%~2
move /y ".env.tmp" ".env" >nul
exit /b 0
```

Immediately before the rebuild section, add the same flow as Task 10 Step 6: call `:read_env`; if `ENV_PUBLIC_URL` is defined, ask `Public URL is !ENV_PUBLIC_URL! - still current? [Y/n]` and on `n` fall into the `:ask_public_url`-style loop (copy the install.bat loop with its own label, `:upd_ask_public_url`); write with `call :set_env_value BLACKVAULT_PUBLIC_URL "!PUBLIC_URL!"` only if changed. If `ENV_DA_INITIAL` has no line in `.env` (`findstr /b /c:"BLACKVAULT_DIRECT_ACCESS_INITIAL=" .env >nul || (...)`), ask `Keep allowing direct access by IP (http://<ip>:<port>)? [Y/n]` and write `on`/`off`. If no `BLACKVAULT_TRUSTED_PROXIES=` line, prompt and write. Copy `:valid_public_url` into update.bat's subroutines too (batch cannot share code between files).

- [ ] **Step 4: Landing pad**

Run: `npx vitest run scripts/update-bat-landing-pad.test.ts`
Expected: PASS. If it fails, a line was added above the pad — move it below. Never adjust the offsets.

- [ ] **Step 5: CI**

Push; the `windows-installers` job must be green with the new scenarios. Read its log and confirm the P-scenarios actually ran and asserted (a script that died early can make assertions pass vacuously — see the harness comments).

- [ ] **Step 6: Commit**

```bash
git add install.bat update.bat scripts/ci/windows/Test-WindowsInstallers.ps1
git commit -m "feat: Windows installers prompt for the public URL, trusted proxies and direct access"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md` — the install steps (mention the new prompts), "Mobile Access (Same Network)" (~line 432), a new "Running behind a reverse proxy" section, Troubleshooting
- Modify: `CONTRIBUTING.md` — one paragraph on `gate/` and the env vars

- [ ] **Step 1: README**

Replace "Mobile Access (Same Network)" with text that explains: with direct access off, the Settings QR code opens your public URL; with it on, it opens `http://<ip>:<port>`. Add "Running behind a reverse proxy" covering: `BLACKVAULT_PUBLIC_URL` is required; `BLACKVAULT_TRUSTED_PROXIES` accepts IPs/CIDRs/host names; how to find the right value (the `[gate] rejected <ip>` log line, via `docker compose logs blackvault | grep rejected`); when the proxy dials the host's own IP and published port, BlackVault sees the Docker bridge gateway, so trusting that address trusts everything on the host; Docker Desktop cannot tell peers apart; break-glass `BLACKVAULT_ALLOW_DIRECT_ACCESS=true` + `docker compose up -d`; nginx needs `client_max_body_size` raised for uploads (unverified default ~1 MB — say "check your proxy's upload limit"). Add a Troubleshooting entry: "Connection reset / `curl: (56)`" → direct access is off and your address is not trusted.

- [ ] **Step 2: Upgrade note**

At the top of the README's "Updating without losing data" section:

> ⚠️ **From this release, `BLACKVAULT_PUBLIC_URL` is required.** Run `./update.sh` (or `update.bat`) — it asks for it. Updating any other way (e.g. `git pull && docker compose up -d --build`) without adding it to `.env` leaves a container that refuses to start.

- [ ] **Step 3: CONTRIBUTING**

One paragraph: `gate/` is plain ESM JavaScript run directly by `node` in the image; its tests are vitest `.test.ts` files beside it; `npm run dev` does not use it.

- [ ] **Step 4: Commit**

```bash
git add README.md CONTRIBUTING.md
git commit -m "docs: reverse-proxy deployment, the public URL requirement and direct access"
```

---

### Task 13: Whole-branch verification and PR

- [ ] **Step 1:** `npm run lint && npm run typecheck && npm test` — all green. Record the test count before and after.
- [ ] **Step 2:** `npm run build` with `PUBLIC_URL` unset — succeeds.
- [ ] **Step 3:** Re-run Task 8 Step 3 against the final image. Record outputs.
- [ ] **Step 4:** Walk the spec's eight acceptance criteria one by one; for each, name the test or the recorded command output that proves it. Any criterion without evidence is not done.
- [ ] **Step 5:** Open the PR:

```bash
git push -u origin feat/public-url-direct-access
gh pr create --repo doomcrewinc/BlackVaultArmory --base develop \
  --title "feat: public URL, origin enforcement and the direct-access gate" \
  --body-file <(printf '%s\n' "Implements docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md." "" "**Breaking:** BLACKVAULT_PUBLIC_URL is now required. update.sh / update.bat prompt for it." "" "<acceptance-criteria evidence table from Step 4>" "" "🤖 Generated with [Claude Code](https://claude.com/claude-code)")
```

- [ ] **Step 6:** Wait for CI (all six jobs). Report the run URL and result.
