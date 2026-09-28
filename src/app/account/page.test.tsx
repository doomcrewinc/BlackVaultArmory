// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountPage from "./page";

const ME = { id: "u1", username: "jeff", displayName: "Jeff", role: "USER" };
const SESSIONS = {
  sessions: [
    { id: "s1", createdAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-27T00:00:00.000Z", expiresAt: "2026-10-27T00:00:00.000Z", userAgent: "Mozilla/5.0", current: true },
    { id: "s2", createdAt: "2026-09-01T00:00:00.000Z", lastSeenAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-10-20T00:00:00.000Z", userAgent: "Mozilla/5.0", current: false },
  ],
};

/** Routes `/api/account` and `/api/account/sessions` to their fixtures; anything else is up to `overrides`. */
function stubFetch(overrides: (url: string, init?: RequestInit) => Response | null) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const override = overrides(url, init);
    if (override) return override;
    if (url === "/api/account") return { ok: true, json: async () => ME } as Response;
    if (url === "/api/account/sessions") return { ok: true, json: async () => SESSIONS } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AccountPage — Log out everywhere failure handling", () => {
  it("on a 500, shows an error and does NOT redirect", async () => {
    const fetchMock = stubFetch((url) => (url === "/api/auth/logout?all=1" ? ({ ok: false, status: 500, json: async () => ({}) } as Response) : null));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<AccountPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /log out everywhere/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /log out everywhere/i }));

    await waitFor(() => expect(screen.getByText(/could not log out everywhere/i)).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
  });

  it("on success, redirects to /login", async () => {
    const fetchMock = stubFetch((url) => (url === "/api/auth/logout?all=1" ? ({ ok: true, json: async () => ({ ok: true }) } as Response) : null));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<AccountPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /log out everywhere/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /log out everywhere/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("a 401 still redirects (already signed out)", async () => {
    const fetchMock = stubFetch((url) => (url === "/api/auth/logout?all=1" ? ({ ok: false, status: 401, json: async () => ({}) } as Response) : null));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<AccountPage />);
    await waitFor(() => expect(screen.getByRole("button", { name: /log out everywhere/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /log out everywhere/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });
});

describe("AccountPage — End session failure handling", () => {
  it("on a 500, shows an error, keeps the session in the list, and does NOT redirect", async () => {
    const fetchMock = stubFetch((url) => (url === "/api/account/sessions/s2" ? ({ ok: false, status: 500, json: async () => ({}) } as Response) : null));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<AccountPage />);
    const endButtons = await screen.findAllByRole("button", { name: /^end$/i });
    fireEvent.click(endButtons[1]); // the non-current session

    await waitFor(() => expect(screen.getByText(/could not end that session/i)).toBeTruthy());
    expect(assign).not.toHaveBeenCalled();
    expect(await screen.findAllByRole("button", { name: /^end$/i })).toHaveLength(2);
  });

  it("on success for a non-current session, removes it from the list without redirecting", async () => {
    const fetchMock = stubFetch((url) => (url === "/api/account/sessions/s2" ? ({ ok: true, json: async () => ({ ok: true }) } as Response) : null));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<AccountPage />);
    const endButtons = await screen.findAllByRole("button", { name: /^end$/i });
    fireEvent.click(endButtons[1]);

    await waitFor(async () => expect(await screen.findAllByRole("button", { name: /^end$/i })).toHaveLength(1));
    expect(assign).not.toHaveBeenCalled();
  });

  it("on success for the current session, redirects to /login", async () => {
    const fetchMock = stubFetch((url) => (url === "/api/account/sessions/s1" ? ({ ok: true, json: async () => ({ ok: true }) } as Response) : null));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<AccountPage />);
    const endButtons = await screen.findAllByRole("button", { name: /^end$/i });
    fireEvent.click(endButtons[0]); // the current session

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });
});
