/**
 * Per-key login throttle. After 5 consecutive failures each attempt must wait
 * 2^(failures-5) seconds, capped at 15 minutes. Never a hard lockout: a lockout would
 * let anyone lock the admin out. In-memory — one process; resets on restart.
 */
const FREE_FAILURES = 5;
const CAP_SECONDS = 900;

export function createThrottle(opts: { now?: () => number; maxKeys?: number } = {}) {
  const now = opts.now ?? Date.now;
  const state = new Map<string, { failures: number; lastFailure: number }>();
  const MAX_KEYS = opts.maxKeys ?? 10_000;

  function waitSeconds(failures: number) {
    return failures < FREE_FAILURES ? 0 : Math.min(2 ** (failures - FREE_FAILURES), CAP_SECONDS);
  }

  /**
   * The cheapest key to forget when the map is full: never one that is currently throttled
   * (evicting it would reset its backoff — spraying ~MAX_KEYS unknown usernames would then
   * free `u:admin`). Among the rest, the one with the fewest failures. O(n), but only runs
   * when the map is full and a new key arrives.
   */
  function evictionVictim(): string | null {
    const t = now();
    let best: string | null = null;
    let bestFailures = Infinity;
    for (const [k, s] of state) {
      if (s.lastFailure + waitSeconds(s.failures) * 1000 > t) continue; // throttled: never evict
      if (s.failures < bestFailures) {
        best = k;
        bestFailures = s.failures;
        if (bestFailures <= 1) break;
      }
    }
    return best;
  }

  return {
    check(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
      const s = state.get(key);
      if (!s) return { allowed: true };
      const remainingMs = s.lastFailure + waitSeconds(s.failures) * 1000 - now();
      return remainingMs > 0 ? { allowed: false, retryAfterSeconds: Math.ceil(remainingMs / 1000) } : { allowed: true };
    },
    fail(key: string) {
      const s = state.get(key);
      if (!s && state.size >= MAX_KEYS) {
        const victim = evictionVictim();
        // Every tracked key is in backoff: keep them all and leave the new key untracked,
        // rather than let a spray of fresh keys evict (and so reset) a throttled one.
        if (victim === null) return;
        state.delete(victim);
      }
      state.set(key, { failures: (s?.failures ?? 0) + 1, lastFailure: now() });
    },
    succeed(key: string) {
      state.delete(key);
    },
  };
}

export const loginThrottle = createThrottle();
