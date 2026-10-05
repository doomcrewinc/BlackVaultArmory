// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

afterEach(() => {
  cleanup();
  hdrs.value = new Headers();
});

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn() }));
vi.mock("@/lib/server/auth", () => ({ getCurrentUser: auth.getCurrentUser }));

const hdrs = vi.hoisted(() => ({ value: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => hdrs.value }));

// Chrome components replaced with detectable stand-ins so the test asserts on
// presence/absence, not on their internals (they have their own tests).
vi.mock("@/components/layout/Sidebar", () => ({ Sidebar: () => <nav data-testid="sidebar" /> }));
vi.mock("@/components/layout/MobileHeader", () => ({ MobileHeader: () => <header data-testid="mobile-header" /> }));
vi.mock("@/components/layout/ThemeToggle", () => ({ ThemeToggle: () => <button data-testid="theme-toggle" /> }));
vi.mock("@/components/search/GlobalSearch", () => ({ GlobalSearch: () => <div data-testid="global-search" /> }));
vi.mock("@/components/layout/ThemeProvider", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/layout/ErrorBoundary", () => ({ ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/layout/DatabaseStatusProvider", () => ({
  DatabaseStatusProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RootLayout from "./layout";

describe("RootLayout", () => {
  it("renders no chrome when signed out", async () => {
    auth.getCurrentUser.mockResolvedValue(null);
    const jsx = await RootLayout({ children: <div data-testid="page-content">hi</div> });
    const { container, queryByTestId } = render(jsx);
    expect(queryByTestId("sidebar")).toBeNull();
    expect(queryByTestId("mobile-header")).toBeNull();
    expect(queryByTestId("global-search")).toBeNull();
    expect(queryByTestId("theme-toggle")).toBeNull();
    expect(container.querySelector('[data-testid="page-content"]')).not.toBeNull();
  });

  it("renders full chrome when signed in", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: "u1", username: "jeff", displayName: "Jeff", role: "USER", sessionId: "s1" });
    const jsx = await RootLayout({ children: <div data-testid="page-content">hi</div> });
    const { queryByTestId } = render(jsx);
    expect(queryByTestId("sidebar")).not.toBeNull();
    expect(queryByTestId("mobile-header")).not.toBeNull();
    expect(queryByTestId("global-search")).not.toBeNull();
    expect(queryByTestId("theme-toggle")).not.toBeNull();
  });

  it("lets the wheel reach the document from the page area", async () => {
    auth.getCurrentUser.mockResolvedValue({ id: "u1", username: "jeff", displayName: "Jeff", role: "USER", sessionId: "s1" });
    const jsx = await RootLayout({ children: <div data-testid="page-content">hi</div> });
    const { container } = render(jsx);
    const main = container.querySelector("main");
    expect(main).not.toBeNull();
    expect(Array.from(main!.classList).filter((c) => c.includes("overscroll"))).toEqual([]);
  });

  it("renders the capture page bare, signed in or not, and never asks who is signed in", async () => {
    hdrs.value = new Headers({ "x-bv-capture-page": "1" });
    auth.getCurrentUser.mockClear();
    auth.getCurrentUser.mockResolvedValue({ id: "u1", username: "jeff", displayName: "Jeff", role: "USER", sessionId: "s1" });
    const jsx = await RootLayout({ children: <div data-testid="page-content">hi</div> });
    const { queryByTestId } = render(jsx);
    expect(queryByTestId("page-content")).not.toBeNull();
    for (const id of ["sidebar", "mobile-header", "global-search", "theme-toggle"]) {
      expect(queryByTestId(id)).toBeNull();
    }
    expect(auth.getCurrentUser).not.toHaveBeenCalled();
  });
});
