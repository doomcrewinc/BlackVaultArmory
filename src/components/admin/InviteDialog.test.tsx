// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("qrcode", () => {
  const toDataURL = vi.fn(async () => "data:image/png;base64,ABC");
  return { toDataURL, default: { toDataURL } };
});

import { InviteDialog } from "./InviteDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("InviteDialog — invite mode", () => {
  it("posts the selected role and renders URL + QR image + expiry after the mocked POST", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ url: "http://localhost:3000/invite/tok123", expiresAt: "2026-10-04T00:00:00.000Z" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<InviteDialog mode="invite" onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/role/i), { target: { value: "ADMIN" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));

    await waitFor(() => expect(screen.getByText("http://localhost:3000/invite/tok123")).toBeTruthy());
    const img = await screen.findByAltText(/qr code/i);
    expect(img).toHaveAttribute("src", "data:image/png;base64,ABC");
    expect(screen.getByText(/expires/i)).toBeTruthy();

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init!.body as string)).toEqual({ role: "ADMIN" });
  });
});

describe("InviteDialog — reset mode", () => {
  it("fires the reset-link POST for the given user immediately and renders URL + QR image + expiry", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: "http://localhost:3000/reset/tok456", expiresAt: "2026-09-28T00:00:00.000Z" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<InviteDialog mode="reset" userId="u9" displayName="Jeff" onClose={vi.fn()} />);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/users/u9/reset-link", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(screen.getByText("http://localhost:3000/reset/tok456")).toBeTruthy());
    const img = await screen.findByAltText(/qr code/i);
    expect(img).toHaveAttribute("src", "data:image/png;base64,ABC");
    expect(screen.getByText(/expires/i)).toBeTruthy();
  });
});
