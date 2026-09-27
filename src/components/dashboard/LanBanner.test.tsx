// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://10.10.10.3:3000/"}
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanBanner } from "./LanBanner";

function mockFetch(body: object) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ json: async () => body })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("LanBanner", () => {
  it("shows the LAN URL when direct access is on", async () => {
    mockFetch({ url: "http://10.10.10.3:3000", directAccess: { allowed: true, source: "setting" } });
    render(<LanBanner />);
    await waitFor(() => expect(screen.getByText("http://10.10.10.3:3000")).toBeTruthy());
  });

  it("renders nothing when direct access is off", async () => {
    const fetchMock = vi.fn(async () => ({
      json: async () => ({ url: "http://10.10.10.3:3000", directAccess: { allowed: false, source: "setting" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<LanBanner />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe("");
  });
});
