/**
 * version.ts — CalVer (YYYY.M.D) + short sha.
 *
 * The CalVer portion lives in package.json and is stamped at release time.
 * The sha is injected at Docker build time via NEXT_PUBLIC_APP_VERSION.
 * Outside Docker the version resolves to "dev".
 */

/** UTC CalVer with no leading zeros, e.g. 2026.9.20. Semver-parseable by construction. */
export function calverForDate(date: Date): string {
  return `${date.getUTCFullYear()}.${date.getUTCMonth() + 1}.${date.getUTCDate()}`;
}

/** Join a CalVer with a short sha. Returns bare CalVer when no usable sha is supplied. */
export function formatVersion(calver: string, sha?: string | null): string {
  const trimmed = (sha ?? "").trim();
  if (!trimmed) return calver;
  return `${calver}-${trimmed.slice(0, 7)}`;
}

/** The running version. "dev" when NEXT_PUBLIC_APP_VERSION is not set. */
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION?.trim() || "dev";
