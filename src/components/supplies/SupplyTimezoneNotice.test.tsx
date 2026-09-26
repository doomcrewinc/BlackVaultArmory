// @vitest-environment jsdom
/**
 * Component test for SupplyTimezoneNotice — the notice has a documented
 * history of being invisible in a browser profile that dismissed it in an
 * earlier session (see .superpowers/sdd/epic-followups/timezone-notice-report.md),
 * and of appearing/not-appearing incorrectly depending on whether a timezone
 * is configured server-side. Both are runtime, DOM + localStorage behaviors
 * that a node-environment unit test cannot exercise, which is the whole
 * reason this repo needed jsdom.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SupplyTimezoneNotice } from "./SupplyTimezoneNotice";

const DISMISS_KEY = "bv-supply-timezone-notice-dismissed";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SupplyTimezoneNotice", () => {
  it("renders when the timezone is unconfigured and the notice has not been dismissed", () => {
    render(<SupplyTimezoneNotice timezoneConfigured={false} />);

    expect(
      screen.getByText(/Expiry dates use the server's timezone/i),
    ).toBeInTheDocument();
  });

  it("stays hidden when the notice was dismissed in an earlier session", () => {
    // Simulate a prior session's dismissal, written before this render — this
    // is exactly the "invisible in a profile that dismissed it earlier"
    // scenario from the bug history.
    localStorage.setItem(DISMISS_KEY, "1");

    render(<SupplyTimezoneNotice timezoneConfigured={false} />);

    expect(
      screen.queryByText(/Expiry dates use the server's timezone/i),
    ).not.toBeInTheDocument();
  });

  it("stays hidden when a timezone is configured, regardless of dismissal state", () => {
    render(<SupplyTimezoneNotice timezoneConfigured={true} />);

    expect(
      screen.queryByText(/Expiry dates use the server's timezone/i),
    ).not.toBeInTheDocument();
  });
});
