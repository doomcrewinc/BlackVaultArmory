export type CategoryCounts = {
  counts: Record<string, number>;
  legacySmgCount: number;
};

// Module-scoped, not a cache: it exists only to fold concurrent callers (the
// desktop rail and the mobile drawer both mount `Sidebar`, and each wants
// these counts on every navigation) onto a single underlying request. It is
// cleared as soon as the request settles, so the next call always fetches
// fresh data — a count must change immediately after an add or delete.
let inFlight: Promise<CategoryCounts | null> | null = null;

async function requestCategoryCounts(): Promise<CategoryCounts | null> {
  try {
    const response = await fetch("/api/categories/counts");
    if (!response.ok) return null;
    return (await response.json()) as CategoryCounts;
  } catch {
    return null;
  }
}

/**
 * Fetches `/api/categories/counts`, sharing one in-flight request across
 * concurrent callers. Never throws — a failed or non-ok response resolves to
 * `null` so callers can fall back to `?? 0` without a try/catch of their own.
 */
export function fetchCategoryCounts(): Promise<CategoryCounts | null> {
  if (!inFlight) {
    inFlight = requestCategoryCounts().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}
