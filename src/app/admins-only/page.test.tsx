// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), listAdmins: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("@/lib/auth/admins", () => ({ listAdmins: mocks.listAdmins }));

import AdminsOnlyPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AdminsOnlyPage (server component)", () => {
  it("names the signed-in user and every admin, with a way back to the Command Center", async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: "u2", username: "jeff", displayName: "Jeff", role: "USER", sessionId: "s1" });
    mocks.listAdmins.mockResolvedValue([{ displayName: "Ann" }, { displayName: "Bob" }]);

    const jsx = await AdminsOnlyPage();
    render(jsx);

    expect(screen.getByText("Restricted — admins only")).toBeTruthy();
    expect(screen.getByText("Jeff")).toBeTruthy();
    expect(screen.getByText("Ann")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByRole("link", { name: /back to command center/i })).toHaveAttribute("href", "/");
  });

  it("still renders (with a generic fallback) if getCurrentUser somehow returns null", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.listAdmins.mockResolvedValue([{ displayName: "Ann" }]);

    const jsx = await AdminsOnlyPage();
    render(jsx);

    expect(screen.getByText("Restricted — admins only")).toBeTruthy();
    expect(screen.getByText("Ann")).toBeTruthy();
  });
});
