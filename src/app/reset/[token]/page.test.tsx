// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const tokens = vi.hoisted(() => ({ peekToken: vi.fn() }));
vi.mock("@/lib/auth/tokens", () => ({ peekToken: tokens.peekToken }));

import ResetPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ResetPage (server component)", () => {
  it("renders LinkExpired for a null peek", async () => {
    tokens.peekToken.mockResolvedValue(null);
    const jsx = await ResetPage({ params: Promise.resolve({ token: "deadbeef" }) });
    render(jsx);
    expect(
      screen.getByText("This link has expired or was already used. Ask your admin for a new one."),
    ).toBeTruthy();
  });

  it("renders LinkExpired for a token that peeks as a different kind (e.g. INVITE)", async () => {
    tokens.peekToken.mockResolvedValue({ kind: "INVITE", role: "USER", userId: null });
    const jsx = await ResetPage({ params: Promise.resolve({ token: "invitetoken" }) });
    render(jsx);
    expect(
      screen.getByText("This link has expired or was already used. Ask your admin for a new one."),
    ).toBeTruthy();
  });

  it("renders the password-only form for a valid RESET peek", async () => {
    tokens.peekToken.mockResolvedValue({ kind: "RESET", role: null, userId: "u1" });
    const jsx = await ResetPage({ params: Promise.resolve({ token: "goodtoken" }) });
    render(jsx);
    expect(screen.queryByLabelText(/^username$/i)).toBeNull();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /reset password/i })).toBeTruthy();
  });
});
