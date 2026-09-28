// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RedeemForm } from "./RedeemForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RedeemForm — invite", () => {
  it("shows Username/Display name/Password/Confirm fields", () => {
    render(<RedeemForm kind="INVITE" token="tok123" />);
    expect(screen.getByLabelText(/^username$/i)).toBeTruthy();
    expect(screen.getByLabelText(/display name/i)).toBeTruthy();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
  });

  it("shows inline 'That username is taken' on 409", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: false, status: 409, json: async () => ({ error: "Username taken" }) })),
    );
    render(<RedeemForm kind="INVITE" token="tok123" />);
    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "jeff" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Jeff" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(screen.getByText("That username is taken")).toBeTruthy());
  });

  it("posts token + username + displayName + password and navigates to the returned next", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ next: "/" }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RedeemForm kind="INVITE" token="tok123" />);
    fireEvent.change(screen.getByLabelText(/^username$/i), { target: { value: "jeff" } });
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: "Jeff" } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({ token: "tok123", username: "jeff", displayName: "Jeff", password: "correct-horse-battery" });
  });
});

describe("RedeemForm — reset", () => {
  it("shows only Password/Confirm fields, no username or display name", () => {
    render(<RedeemForm kind="RESET" token="tok456" />);
    expect(screen.queryByLabelText(/^username$/i)).toBeNull();
    expect(screen.queryByLabelText(/display name/i)).toBeNull();
    expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
  });

  it("posts only token + password", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ next: "/" }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RedeemForm kind="RESET" token="tok456" />);
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: /reset password/i }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({ token: "tok456", password: "correct-horse-battery" });
  });
});
