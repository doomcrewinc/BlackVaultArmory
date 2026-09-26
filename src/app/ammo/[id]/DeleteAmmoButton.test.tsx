// @vitest-environment jsdom
/**
 * Component test for DeleteAmmoButton.
 *
 * Deleting an ammo lot is the one destructive control on the detail page, and
 * the confirm step is the only thing between a mis-tap and a gone lot. The
 * behaviours tested are: the first click asks rather than deletes, Cancel
 * really does abort (no request at all), Yes calls DELETE on the right URL and
 * navigates, and a failed delete leaves the user on the page with an error
 * instead of silently appearing to work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { DeleteAmmoButton } from "./DeleteAmmoButton";

beforeEach(() => {
  push.mockReset();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeleteAmmoButton", () => {
  it("asks for confirmation instead of deleting on the first click", async () => {
    render(<DeleteAmmoButton id="ammo-1" />);

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));

    expect(screen.getByText("Delete?")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends no request at all when the confirmation is cancelled", async () => {
    render(<DeleteAmmoButton id="ammo-1" />);

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Delete?")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("deletes the lot and returns to the list once confirmed", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    render(<DeleteAmmoButton id="ammo-1" />);

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/ammo"));
    expect(fetch).toHaveBeenCalledWith("/api/ammo/ammo-1", {
      method: "DELETE",
    });
  });

  it("keeps the user on the page with an error when the delete fails", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    render(<DeleteAmmoButton id="ammo-1" />);

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(
      await screen.findByText("Failed to delete. Please try again."),
    ).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
