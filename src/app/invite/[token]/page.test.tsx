// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const tokens = vi.hoisted(() => ({ peekToken: vi.fn() }));
vi.mock("@/lib/auth/tokens", () => ({ peekToken: tokens.peekToken }));

import InvitePage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InvitePage (server component)", () => {
  it("renders LinkExpired for a null peek", async () => {
    tokens.peekToken.mockResolvedValue(null);
    const jsx = await InvitePage({ params: Promise.resolve({ token: "deadbeef" }) });
    render(jsx);
    expect(
      screen.getByText("This link has expired or was already used. Ask your admin for a new one."),
    ).toBeTruthy();
  });

  it("renders LinkExpired for a token that peeks as a different kind (e.g. SETUP)", async () => {
    tokens.peekToken.mockResolvedValue({ kind: "SETUP", role: null, userId: null });
    const jsx = await InvitePage({ params: Promise.resolve({ token: "setupcode" }) });
    render(jsx);
    expect(
      screen.getByText("This link has expired or was already used. Ask your admin for a new one."),
    ).toBeTruthy();
  });

  it("renders the redeem form for a valid INVITE peek", async () => {
    tokens.peekToken.mockResolvedValue({ kind: "INVITE", role: "USER", userId: null });
    const jsx = await InvitePage({ params: Promise.resolve({ token: "goodtoken" }) });
    render(jsx);
    expect(screen.getByLabelText(/^username$/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /create account/i })).toBeTruthy();
  });
});
