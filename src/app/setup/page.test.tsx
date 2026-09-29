// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  userCount: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { count: m.userCount } } }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: m.notFound,
}));

import SetupPage from "./page";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SetupPage (server component)", () => {
  it("renders the first-admin form while no account exists", async () => {
    m.userCount.mockResolvedValue(0);
    render(await SetupPage());
    expect(screen.getByText("Create the first admin account")).toBeTruthy();
    expect(m.notFound).not.toHaveBeenCalled();
  });

  it("404s once any account exists (spec: once any admin exists, /setup returns 404)", async () => {
    m.userCount.mockResolvedValue(1);
    await expect(SetupPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(m.notFound).toHaveBeenCalledTimes(1);
  });
});
