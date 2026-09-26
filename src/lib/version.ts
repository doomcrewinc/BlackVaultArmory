/**
 * version.ts — CalVer (YYYY.M.D) + short sha.
 *
 * The whole string is injected at Docker build time via the APP_VERSION build
 * arg -> NEXT_PUBLIC_APP_VERSION. .github/workflows/publish.yml derives it
 * from the COMMIT DATE of the commit being built (calverForDate's rule,
 * reimplemented in scripts/ci/derive-image-tags.sh and asserted equal to this
 * module by scripts/ci/derive-image-tags.test.ts) plus that commit's sha7 —
 * and pushes an image tagged with the identical string. The version the
 * Settings page shows is therefore always an image tag that can be pulled.
 *
 * package.json's "version" is npm metadata and is NOT this value; nothing
 * reads it at runtime.
 *
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
