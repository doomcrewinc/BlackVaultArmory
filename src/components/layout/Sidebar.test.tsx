// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

import { Sidebar } from "./Sidebar";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// mobileOpen keeps the drawer's aria-hidden off, so getByRole finds its content; mobileOnly
// keeps only one copy of the nav in the DOM (the desktop <aside> renders the same links too).
describe("Sidebar — admin-only Users link", () => {
  it("hides the Users link for a plain USER", () => {
    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Jeff", role: "USER" }} />);
    expect(screen.queryByRole("link", { name: /users/i })).toBeNull();
  });

  it("shows the Users link for an ADMIN", () => {
    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Ann", role: "ADMIN" }} />);
    expect(screen.getByRole("link", { name: /users/i })).toHaveAttribute("href", "/admin/users");
  });

  it("hides the Users link entirely when no user is signed in", () => {
    render(<Sidebar mobileOnly mobileOpen />);
    expect(screen.queryByRole("link", { name: /users/i })).toBeNull();
  });
});

describe("Sidebar — admin-only Audit log link", () => {
  it("hides the Audit log link for a plain USER", () => {
    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Jeff", role: "USER" }} />);
    expect(screen.queryByRole("link", { name: /audit log/i })).toBeNull();
  });

  it("shows the Audit log link for an ADMIN, next to Users", () => {
    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Ann", role: "ADMIN" }} />);
    expect(screen.getByRole("link", { name: /audit log/i })).toHaveAttribute("href", "/admin/audit");
  });

  it("hides the Audit log link entirely when no user is signed in", () => {
    render(<Sidebar mobileOnly mobileOpen />);
    expect(screen.queryByRole("link", { name: /audit log/i })).toBeNull();
  });
});

describe("Sidebar — signed-in account block", () => {
  it("shows the display name, links to /account, and a Log out control", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Jeff", role: "USER" }} />);

    expect(screen.getByText("Jeff")).toBeTruthy();
    expect(screen.getByRole("link", { name: /jeff/i })).toHaveAttribute("href", "/account");

    fireEvent.click(screen.getByRole("button", { name: /log out/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST" })));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("renders no account block when no user is signed in", () => {
    render(<Sidebar mobileOnly mobileOpen />);
    expect(screen.queryByRole("button", { name: /log out/i })).toBeNull();
  });

  it("on a 500 from /api/auth/logout, shows an error and does NOT redirect", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Jeff", role: "USER" }} />);
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(screen.getByText(/could not log out/i)).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });

  it("a 401 from /api/auth/logout still redirects (already signed out)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Jeff", role: "USER" }} />);
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("on a network error from /api/auth/logout, shows an error and does NOT redirect", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<Sidebar mobileOnly mobileOpen user={{ displayName: "Jeff", role: "USER" }} />);
    fireEvent.click(screen.getByRole("button", { name: /log out/i }));

    await waitFor(() => expect(screen.getByText(/could not log out/i)).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });
});
