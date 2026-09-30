import { getClientIpFromHeaders } from "../server/client-ip";
import { SYSTEM_ACTOR, type AuditActor } from "./context";

/**
 * Who is making the current change.
 *
 * - Outside any request (startup jobs, the migrator, scripts, tests) Next's
 *   `headers()` throws "called outside a request scope" → `system`.
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

type HeaderBag = Pick<Headers, "get">;

async function requestHeaders(): Promise<HeaderBag | null> {
  try {
    const { headers } = await import("next/headers");
    return await headers();
  } catch {
    return null;
  }
}

async function lookUp(h: HeaderBag): Promise<AuditActor> {
  const actorIp = getClientIpFromHeaders(h);
  try {
    const { getCurrentUser } = await import("../server/auth");
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
