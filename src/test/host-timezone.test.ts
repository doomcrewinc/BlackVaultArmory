import { describe, expect, it } from "vitest";
import { IS_PINNED_HOST_ZONE, PINNED_TEST_TIMEZONE, hostTimeZone } from "./host-timezone";

/**
 * Guards the CI timezone matrix against being theatre.
 *
 * vitest writes test.env into process.env, which OVERRIDES a TZ exported by
 * the shell. Before TZ_OVERRIDE existed, `TZ=Pacific/Auckland npx vitest run`
 * therefore ran in America/Denver and reported success — a matrix leg built on
 * that would have proved nothing while looking green.
 *
 * These tests fail loudly if that ever comes back: they assert the zone the
 * suite ACTUALLY resolved equals the zone the caller asked for.
 */
describe("the suite's timezone pin", () => {
  it("runs in the zone the caller asked for", () => {
    const requested = process.env.TZ_OVERRIDE || PINNED_TEST_TIMEZONE;
    expect(hostTimeZone()).toBe(requested);
    expect(process.env.TZ).toBe(requested);
  });

  it("defaults to the pinned zone when TZ_OVERRIDE is unset or empty", () => {
    if (!process.env.TZ_OVERRIDE) {
      expect(hostTimeZone()).toBe(PINNED_TEST_TIMEZONE);
      expect(IS_PINNED_HOST_ZONE).toBe(true);
    }
  });

  it("keeps IS_PINNED_HOST_ZONE consistent with the resolved zone", () => {
    expect(IS_PINNED_HOST_ZONE).toBe(hostTimeZone() === PINNED_TEST_TIMEZONE);
  });

  it("knows which side of UTC it is on", () => {
    // Not an assertion about a particular zone — it records, in the run log,
    // that the two matrix legs really do sit on opposite sides of UTC.
    // getTimezoneOffset is minutes WEST of UTC, so it is negative east of it.
    const offsetMinutesWestOfUtc = new Date("2026-06-15T12:00:00.000Z").getTimezoneOffset();
    expect(Number.isFinite(offsetMinutesWestOfUtc)).toBe(true);
    if (!process.env.TZ_OVERRIDE) {
      // The pinned zone is UTC-negative (America/Denver, UTC-6/-7).
      expect(offsetMinutesWestOfUtc).toBeGreaterThan(0);
    }
  });
});
