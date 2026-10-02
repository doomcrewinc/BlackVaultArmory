// @vitest-environment jsdom
/**
 * Task 8: exports are a known limitation of field encryption (spec §4,
 * "Known limitations" — "Exports (CSV, PDF, full armory) contain plaintext
 * by design. The export page says so."). This pins that the export config
 * page actually carries that warning, so it is not just a line in the spec.
 */
import { afterEach, describe, expect, it } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import FullArmoryExportPage from "./page";

afterEach(() => {
  cleanup();
});

describe("Full Armory export page — plaintext warning", () => {
  it("tells the user exports contain serial numbers in plain text", () => {
    render(<FullArmoryExportPage />);
    expect(screen.getByText(/exports contain serial numbers in plain text/i)).toBeInTheDocument();
  });
});
