/**
 * The host-timezone gate for tests.
 *
 * vitest.config.ts pins TZ to PINNED_TEST_TIMEZONE so date-only behaviour is
 * deterministic. TZ_OVERRIDE lets CI re-run the same suite on the OTHER side
 * of UTC, because a UTC-negative pin hides off-by-ones that only a
 * UTC-positive zone surfaces (the real one: toDateOnlyUTC("2026-9-20")
 * resolving to the 19th, invisible under America/Denver).
 *
 * Most of the suite is zone-portable and runs unchanged in both legs.
 *
 * CRITICALLY, THAT INCLUDES EVERY ZONE-SENSITIVE FUNCTION IN THE APP.
 * todayLocalISO (src/lib/date.ts) is the only production function that reads
 * the host zone at all — everything else uses Date.UTC or passes an explicit
 * timeZone to Intl, so it is zone-invariant by construction. All of
 * todayLocalISO's tests, and all of toDateOnlyUTC's (including the unpadded
 * "2026-9-20" case the second leg exists to catch), run UNGATED in both legs.
 * If that ever stops being true, the second leg degenerates into re-running
 * ~900 zone-invariant tests and this whole matrix becomes theatre.
 *
 * What remains gated is a small family that asserts the HOST-ZONE FALLBACK —
 * what the app does when AppSettings.timezone is NULL — using fixtures that
 * encode America/Denver arithmetic, e.g. "21:00 on June 15 in Denver is
 * already the 16th in UTC, so the two answers are distinguishable". Rewriting
 * those expectations to be computed from whatever zone is active makes them
 * TAUTOLOGICAL: they would compare the implementation against itself. The
 * instant that makes the host-zone answer differ from the UTC answer is
 * zone-specific by construction, and no single instant works for every zone.
 *
 * So those tests declare the requirement instead of faking portability:
 *
 *     it.skipIf(!IS_PINNED_HOST_ZONE)("falls back to the HOST timezone", ...)
 *
 * They run, as they always have, in the default leg. In the TZ_OVERRIDE leg
 * they report as skipped with this reason, rather than failing for something
 * that is not a product defect.
 *
 * KEEP THIS LIST SMALL, AND SPLIT BEFORE YOU GATE. Where a test bundled one
 * zone-bound assertion with portable ones, it was split so the portable half
 * runs in both legs (see resolveExpiryTimeZone in supply.test.ts and the
 * "(server default)" footnote in the full-armory route test). Reach for
 * skipIf only when the assertion is genuinely unknowable outside the pin.
 *
 * Verified 2026-09-25 under TZ_OVERRIDE=Pacific/Auckland: 7 gated, 900 run,
 * 0 failures. Every gated one is fixture arithmetic, not a bug in src/.
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
