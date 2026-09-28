// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LinkExpired } from "./LinkExpired";

describe("LinkExpired", () => {
  it("shows the expired-link copy verbatim", () => {
    render(<LinkExpired />);
    expect(
      screen.getByText("This link has expired or was already used. Ask your admin for a new one."),
    ).toBeTruthy();
  });
});
