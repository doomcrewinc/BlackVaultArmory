// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SetupForm } from "./SetupForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillCommon({ password, confirm }: { password: string; confirm: string }) {
  fireEvent.change(screen.getByLabelText(/setup code/i), { target: { value: "ABCD-EFGH-JKLM-NPQR" } });
  fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "jeff" } });
  fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Jeff" } });
  fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: confirm } });
}

describe("SetupForm", () => {
  it("blocks submit when passwords differ, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupForm />);
    fillCommon({ password: "correct-horse-battery", confirm: "different-password-here" });
    fireEvent.click(screen.getByRole("button", { name: /create admin account/i }));
    await waitFor(() => expect(screen.getByText(/passwords do not match/i)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks submit when password is under 12 characters, without calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupForm />);
    fillCommon({ password: "short1", confirm: "short1" });
    fireEvent.click(screen.getByRole("button", { name: /create admin account/i }));
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits and navigates to / on success", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 201, json: async () => ({ user: {} }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SetupForm />);
    fillCommon({ password: "correct-horse-battery", confirm: "correct-horse-battery" });
    fireEvent.click(screen.getByRole("button", { name: /create admin account/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/setup",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
