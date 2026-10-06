// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const nav = vi.hoisted(() => ({ path: "/", query: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => nav.path,
  useSearchParams: () => new URLSearchParams(nav.query),
}));

import { Sidebar } from "./Sidebar";

afterEach(() => {
  cleanup();
  nav.path = "/";
  nav.query = "";
  vi.unstubAllGlobals();
});

// mobileOpen keeps the drawer's aria-hidden off, so getByRole finds its content; mobileOnly
// keeps only one copy of the nav in the DOM (the desktop <aside> renders the same links too).
describe("Sidebar — no storage-named Accessories entry", () => {
  it.each([
    ["a plain USER", { displayName: "Jeff", role: "USER" as const }],
    ["an ADMIN", { displayName: "Ann", role: "ADMIN" as const }],
  ])("has no Accessories link for %s", (_who, user) => {
    render(<Sidebar mobileOnly mobileOpen user={user} />);
    expect(screen.queryByRole("link", { name: /accessories/i })).toBeNull();
    expect(
      screen.getAllByRole("link").some((link) => link.getAttribute("href") === "/accessories"),
    ).toBe(false);
  });

  it("still lists the Documents and Settings links", () => {
    render(<Sidebar mobileOnly mobileOpen />);
    expect(screen.getByRole("link", { name: /documents/i })).toHaveAttribute("href", "/documents");
    expect(screen.getByRole("link", { name: /settings/i })).toHaveAttribute("href", "/settings");
  });
});

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

describe("Sidebar — scrolling", () => {
  it("contains overscroll in the phone drawer only", () => {
    const { container } = render(<Sidebar user={{ displayName: "Jeff", role: "USER" }} />);
    const navs = Array.from(container.querySelectorAll("nav"));
    expect(navs.length).toBeGreaterThan(0);
    for (const nav of navs) {
      expect(nav.classList.contains("overscroll-contain")).toBe(true);
      expect(nav.classList.contains("md:overscroll-auto")).toBe(true);
    }
  });
});

describe("Sidebar — stays in view", () => {
  it("is sticky to the top of the viewport on a wide screen", () => {
    const { container } = render(<Sidebar user={{ displayName: "Jeff", role: "USER" }} />);
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside!.classList.contains("sticky")).toBe(true);
    expect(aside!.classList.contains("top-0")).toBe(true);
    expect(aside!.classList.contains("h-svh")).toBe(true);
  });

  it("the body does not become a scroll container, which would defeat position: sticky", () => {
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const body = /\nbody\s*\{([^}]*)\}/.exec(css);
    expect(body).not.toBeNull();
    expect(body![1]).toMatch(/overflow-x:\s*clip;/);
    expect(body![1]).not.toMatch(/overflow(-[xy])?:\s*(hidden|auto|scroll)/);
  });
});


describe("Sidebar — highlight on the add forms and accessory pages", () => {
  const ACTIVE = "text-[#00C2FF]";

  function open(path: string, query = "") {
    nav.path = path;
    nav.query = query;
    return render(<Sidebar mobileOnly mobileOpen />);
  }

  function groupLink(container: HTMLElement, href: string): HTMLElement {
    return container.querySelector(`a[href="${href}"]`) as HTMLElement;
  }

  function highlightedSections(container: HTMLElement, groupPrefix: string) {
    return Array.from(
      container.querySelectorAll<HTMLElement>(`a[href^="${groupPrefix}/"]`),
    )
      .filter((link) => link.className.includes(ACTIVE))
      .map((link) => link.getAttribute("href"));
  }

  it("keeps the Gear group active and open on an accessory's own page", () => {
    const { container } = open("/accessories/abc");
    expect(groupLink(container, "/gear").className).toContain("border-[#00C2FF]/20");
    expect(groupLink(container, "/gear/magazines")).not.toBeNull();
    expect(highlightedSections(container, "/gear")).toEqual([]);
  });

  it("keeps the Gear group active on an accessory's edit page", () => {
    const { container } = open("/accessories/abc/edit");
    expect(groupLink(container, "/gear").className).toContain("border-[#00C2FF]/20");
  });

  it("highlights Gear and Magazines on the accessory form opened from Magazines", () => {
    const { container } = open("/accessories/new", "section=magazines");
    expect(groupLink(container, "/gear").className).toContain("border-[#00C2FF]/20");
    expect(highlightedSections(container, "/gear")).toEqual(["/gear/magazines"]);
  });

  it("highlights Preparedness and Medical on the supply form opened from Medical", () => {
    const { container } = open("/supplies/new", "section=medical");
    expect(groupLink(container, "/prep").className).toContain("border-[#00C2FF]/20");
    expect(groupLink(container, "/gear").className).not.toContain("border-[#00C2FF]/20");
    expect(highlightedSections(container, "/prep")).toEqual(["/prep/medical"]);
  });

  it.each([
    ["a made-up section", "/accessories/new", "section=nonsense"],
    ["a firearm section", "/accessories/new", "section=handguns"],
    ["a section of another kind", "/accessories/new", "section=knives"],
    ["an empty section", "/accessories/new", "section="],
    ["a repeated section", "/accessories/new", "section=magazines&section=optics"],
  ])("highlights no section for %s", (_name, path, query) => {
    const { container } = open(path, query);
    expect(highlightedSections(container, "/gear")).toEqual([]);
    expect(highlightedSections(container, "/prep")).toEqual([]);
  });

  it("ignores ?section= on a page that is not an add form", () => {
    const { container } = open("/gear/item/abc", "section=magazines");
    expect(highlightedSections(container, "/gear")).toEqual([]);
  });
});
