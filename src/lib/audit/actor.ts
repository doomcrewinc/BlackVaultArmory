import { getClientIpFromHeaders } from "../server/client-ip";
import { SYSTEM_ACTOR, type AuditActor } from "./context";

/**
 * Who is making the current change.
 *
 * - Outside any request (startup jobs, the migrator, scripts, tests) Next's
 *   `headers()` throws "called outside a request scope" (code E251) → `system`,
 *   silently. Any OTHER failure to read the headers (a module-resolution
 *   error, `headers()` called inside `after()` or `unstable_cache`, ...) also
 *   records `system`, but is logged with console.error so a misattributed row
 *   is never silent.
 * - In a request with a signed-in user → that user, name snapshotted now.
 * - In a request with no user → `anonymous` (the proxy requires sign-in, so
 *   this signals a bug rather than a normal path).
 *
 * Never throws. Must never be called while a transaction is open: the session
 * lookup needs the database connection, and on SQLite (`connection_limit=1`)
 * an open transaction holds the only one (spike, R5 — it blocks until the
 * transaction times out). The audited client's `$transaction` resolves the
 * actor before it opens the transaction and carries it in the audit store.
 *
 * Memoised once per request: `getCurrentUser()` is NOT memoised in route
 * handlers (React `cache` only works during a server render — spike R5), so a
 * request making several audited writes would repeat the session lookup. The
 * memo is keyed on the object `await headers()` resolves to, which Next keeps
 * per request (`workUnitStore.headers`; proven on a real `next start` server
 * — see the Task 4 report). The promise is stored so concurrent writes in one
 * request share one lookup.
 */
const perRequest = new WeakMap<object, Promise<AuditActor>>();

export type HeaderBag = Pick<Headers, "get">;

// Each module is imported once and the promise shared. Concurrent `import()`s
// of one module from one importer race inside vitest 2's module mocker: the
// second can be handed the REAL module instead of the `vi.mock` one (shared
// per-importer callstack, execute.js requestWithMock), which made the suite
// flake with `system` actors. In production the import resolves from the
// bundle either way; caching is harmless there. A rejected import is not
// cached, so one failure does not poison every later call.
let nextHeadersModule: Promise<typeof import("next/headers")> | undefined;
let authModule: Promise<typeof import("../server/auth")> | undefined;

function loadNextHeaders(): Promise<typeof import("next/headers")> {
  nextHeadersModule ??= import("next/headers").catch((error: unknown) => {
    nextHeadersModule = undefined;
    throw error;
  });
  return nextHeadersModule;
}

function loadAuth(): Promise<typeof import("../server/auth")> {
  authModule ??= import("../server/auth").catch((error: unknown) => {
    authModule = undefined;
    throw error;
  });
  return authModule;
}

/**
 * Next's "`headers` was called outside a request scope" — the expected, silent
 * path (startup jobs, scripts, tests). Matched on the error code AND the
 * message, so a Next upgrade that renumbers codes degrades to logging, never
 * to silence in the other direction.
 */
function isOutsideRequest(error: unknown): boolean {
  const e = error as { __NEXT_ERROR_CODE?: unknown; message?: unknown } | null;
  return e?.__NEXT_ERROR_CODE === "E251" || /outside a request scope/.test(String(e?.message ?? ""));
}

/**
 * The current request's headers, or null outside a request. Never throws.
 * Unexpected failures are logged (see the module comment). Shared with
 * events.ts's header-only IP lookup.
 */
export async function requestHeaders(): Promise<HeaderBag | null> {
  try {
    const { headers } = await loadNextHeaders();
    return await headers();
  } catch (error) {
    if (!isOutsideRequest(error)) {
      console.error("[audit] could not read request headers; recording as system:", error);
    }
    return null;
  }
}

async function lookUp(h: HeaderBag): Promise<AuditActor> {
  const actorIp = getClientIpFromHeaders(h);
  try {
    const { getCurrentUser } = await loadAuth();
    const user = await getCurrentUser();
    if (user) {
      return { kind: "user", actorId: user.id, actorName: `${user.displayName} (@${user.username})`, actorIp };
    }
  } catch (error) {
    console.error("[audit] actor lookup failed; recording as anonymous:", error);
  }
  return { kind: "anonymous", actorId: null, actorName: "anonymous", actorIp };
}

export async function resolveActor(): Promise<AuditActor> {
  const h = await requestHeaders();
  if (!h) return SYSTEM_ACTOR;
  let pending = perRequest.get(h);
  if (!pending) {
    pending = lookUp(h);
    perRequest.set(h, pending);
  }
  return pending;
}
