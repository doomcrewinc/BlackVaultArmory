// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserRow, type AdminUserRow, LAST_ADMIN_TOOLTIP } from "./UserRow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ADMIN: AdminUserRow = {
  id: "u1",
  username: "ann",
  displayName: "Ann",
  role: "ADMIN",
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: "2026-09-20T12:00:00.000Z",
};

describe("UserRow — last-admin protection", () => {
  it("disables Make user and Disable when isLastActiveAdmin, with the required text shown", () => {
    render(<UserRow user={ADMIN} currentUserId="other" isLastActiveAdmin onChanged={vi.fn()} onResetLink={vi.fn()} />);

    expect(screen.getByRole("button", { name: /make user/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^disable$/i })).toBeDisabled();
    expect(screen.getByText(LAST_ADMIN_TOOLTIP)).toBeTruthy();
  });

  it("allows Make user when NOT the last active admin, and PATCHes the role", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<UserRow user={ADMIN} currentUserId="other" isLastActiveAdmin={false} onChanged={onChanged} onResetLink={vi.fn()} />);

    const makeUser = screen.getByRole("button", { name: /make user/i });
    expect(makeUser).not.toBeDisabled();
    fireEvent.click(makeUser);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/users/u1", expect.objectContaining({ method: "PATCH" }));
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({ role: "USER" });
  });
});

describe("UserRow — self-disable confirmation", () => {
  it("requires an explicit confirm, warns about immediate logout, then redirects on success", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    render(<UserRow user={ADMIN} currentUserId="u1" isLastActiveAdmin={false} onChanged={vi.fn()} onResetLink={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^disable$/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/you.ll be logged out immediately/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /yes, disable me/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/users/u1", expect.objectContaining({ method: "PATCH" })));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });

  it("Cancel dismisses the confirmation without calling the API", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<UserRow user={ADMIN} currentUserId="u1" isLastActiveAdmin={false} onChanged={vi.fn()} onResetLink={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^disable$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByText(/you.ll be logged out immediately/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("UserRow — Reset link", () => {
  it("calls onResetLink with this user, without hitting the network itself", () => {
    const onResetLink = vi.fn();
    render(<UserRow user={ADMIN} currentUserId="other" isLastActiveAdmin={false} onChanged={vi.fn()} onResetLink={onResetLink} />);
    fireEvent.click(screen.getByRole("button", { name: /reset link/i }));
    expect(onResetLink).toHaveBeenCalledWith(ADMIN);
  });
});
