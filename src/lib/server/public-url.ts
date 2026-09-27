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
