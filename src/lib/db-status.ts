/**
 * Shared, framework-free logic for detecting a database outage from the
 * browser. Kept out of the components so it can be tested without a DOM.
 */

export type DbStatus = "ok" | "db-down" | "unreachable";

export const HEALTH_PATH = "/api/health";

/** Seconds between automatic retries while an outage is showing. */
export const RETRY_SECONDS = 5;

/**
 * True when a failed request is worth confirming against /api/health. Only
 * this app's own requests count, never the health probe itself (that would
 * recurse), and only server-side failures — a 404 or a 400 says nothing about
 * the database.
 */
export function looksLikeOutage(
  rawUrl: string,
  status: number,
  origin: string,
): boolean {
  if (status < 500) return false;
  let url: URL;
  try {
    url = new URL(rawUrl, origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return url.pathname !== HEALTH_PATH;
}

/**
 * Ask the app whether its database is reachable. Never throws: anything it
 * cannot interpret as an outage is reported as "ok", so a bug here can only
 * fail to show the splash, not wrongly block a working app.
 */
export async function probeDatabase(
  fetchImpl: typeof fetch = fetch,
): Promise<DbStatus> {
  let response: Response;
  try {
    response = await fetchImpl(HEALTH_PATH, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    // The server itself did not answer — restarting, stopped, or no network.
    return "unreachable";
  }

  if (response.ok) {
    try {
      const body = (await response.json()) as { database?: unknown };
      return body?.database === "ok" ? "ok" : "db-down";
    } catch {
      // A 200 whose body will not parse is not evidence of an outage.
      return "ok";
    }
  }

  if (response.status === 503) return "db-down";
  // 502/504 come from a proxy in front of an app that is not answering.
  if (response.status === 502 || response.status === 504) return "unreachable";
  return "ok";
}
