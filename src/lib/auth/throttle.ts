/**
 * Per-key login throttle. After 5 consecutive failures each attempt must wait
 * 2^(failures-5) seconds, capped at 15 minutes. Never a hard lockout: a lockout would
 * let anyone lock the admin out. In-memory — one process; resets on restart.
 */
const FREE_FAILURES = 5;
const CAP_SECONDS = 900;

export function createThrottle(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const state = new Map<string, { failures: number; lastFailure: number }>();
  const MAX_KEYS = 10_000;

  function waitSeconds(failures: number) {
    return failures < FREE_FAILURES ? 0 : Math.min(2 ** (failures - FREE_FAILURES), CAP_SECONDS);
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
      if (!s && state.size >= MAX_KEYS) state.delete(state.keys().next().value as string);
      state.set(key, { failures: (s?.failures ?? 0) + 1, lastFailure: now() });
    },
    succeed(key: string) {
      state.delete(key);
    },
  };
}

export const loginThrottle = createThrottle();
