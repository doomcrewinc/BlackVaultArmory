/**
 * The host-timezone gate for tests.
 *
 * vitest.config.ts pins TZ to PINNED_TEST_TIMEZONE so date-only behaviour is
 * deterministic. TZ_OVERRIDE lets CI re-run the same suite on the OTHER side
 * of UTC, because a UTC-negative pin hides off-by-ones that only a
 * UTC-positive zone surfaces (the real one: toDateOnlyUTC("2026-9-20")
 * resolving to the 19th, invisible under America/Denver).
 *
 * Most of the suite is zone-portable and runs unchanged in both legs —
 * including every toDateOnlyUTC case, which is the bug the second leg exists
 * to catch.
 *
 * A small family of tests is NOT portable, and cannot be made portable
 * without destroying what it checks. Those tests assert the HOST-ZONE
 * FALLBACK — what the app does when AppSettings.timezone is NULL — and they
 * do it with fixtures that encode America/Denver arithmetic, e.g. "21:00 on
 * June 15 in Denver is already the 16th in UTC, so the two answers are
 * distinguishable". Rewriting the expectation to be computed from whatever
 * zone happens to be active turns the assertion tautological: it would then
 * compare the implementation against itself. The instant that makes the
 * host-zone answer differ from the UTC answer is zone-specific by
 * construction, and no single instant works for every zone.
 *
 * So those tests declare the requirement instead of faking portability:
 *
 *     it.skipIf(!IS_PINNED_HOST_ZONE)("falls back to the HOST timezone", ...)
 *
 * They run, as they always have, in the default leg. In the TZ_OVERRIDE leg
 * they report as skipped with this reason, rather than failing for a reason
 * that is not a product defect. Verified 2026-09-25: under
 * TZ_OVERRIDE=Pacific/Auckland these are the only 10 failures in the suite,
 * and every one is fixture arithmetic, not a bug in src/.
 */

/** The zone vitest.config.ts pins when TZ_OVERRIDE is unset. */
export const PINNED_TEST_TIMEZONE = "America/Denver";

/** The zone this vitest process actually resolved. */
export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * True when the run is in the pinned zone, i.e. host-zone fixtures hold.
 * False in the CI matrix's TZ_OVERRIDE leg.
 */
export const IS_PINNED_HOST_ZONE: boolean = hostTimeZone() === PINNED_TEST_TIMEZONE;
