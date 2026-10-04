import { trustsForwardedHeaders } from "./request-gate";

/**
 * The client's address as the trusted reverse proxy saw it: the LAST
 * X-Forwarded-For value (the one our proxy appended; earlier values are
 * client-controlled — same rule as the login throttle). Without
 * configured trusted proxies nothing in the headers can be trusted, so null.
 */
export function getClientIp(request: Request, env: NodeJS.ProcessEnv = process.env): string | null {
  return getClientIpFromHeaders(request.headers, env);
}

/**
 * The same rule for a bare headers object — what `await headers()` from
 * next/headers returns, where no Request is in hand (the audit log's actor).
 */
export function getClientIpFromHeaders(
  headers: Pick<Headers, "get">,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!trustsForwardedHeaders(env)) return null;
  const values = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return values.at(-1) ?? null;
}
