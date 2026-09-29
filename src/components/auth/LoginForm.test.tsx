// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LoginForm } from "./LoginForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "jeff" } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
}

describe("LoginForm", () => {
  it("shows the 429 message with seconds from the Retry-After header", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === "Retry-After" ? "42" : null) },
        json: async () => ({ error: "Too many attempts" }),
      })),
    );
    render(<LoginForm next={null} />);
    fillAndSubmit();
    await waitFor(() =>
      expect(screen.getByText("Too many attempts — try again in 42 seconds")).toBeTruthy(),
    );
  });

  it("shows Invalid username or password on 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({ error: "Invalid username or password" }),
      })),
    );
    render(<LoginForm next={null} />);
    fillAndSubmit();
    await waitFor(() => expect(screen.getByText("Invalid username or password")).toBeTruthy());
  });

  it("sends next as-is to the API and navigates to the next the API returns", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ next: "/builds" }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginForm next="/builds%3Fx%3D1" />);
    fillAndSubmit();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/builds"));
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init!.body as string);
    expect(body.next).toBe("/builds%3Fx%3D1");
  });
});
