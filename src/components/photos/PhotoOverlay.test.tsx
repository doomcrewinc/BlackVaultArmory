// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PhotoDto } from "@/lib/photos/store";
import { PhotoOverlay } from "./PhotoOverlay";

const photo: PhotoDto = {
  id: "p1",
  url: "/uploads/images/photos/p1.jpg",
  previewUrl: "/uploads/images/photos/thumbs/p1.webp",
  label: "left side",
  width: 40,
  height: 30,
  fileSize: 10,
  viaPass: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  isMain: false,
};

afterEach(cleanup);

describe("PhotoOverlay", () => {
  it("is a native modal dialog named by the label", () => {
    render(<PhotoOverlay photo={photo} onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "left side" });
    expect(dialog.tagName).toBe("DIALOG");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.hasAttribute("open")).toBe(true);
  });

  it("focuses the close button", () => {
    render(<PhotoOverlay photo={photo} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close picture" }));
  });

  it("has a real button as the backdrop, and clicking it closes", () => {
    const onClose = vi.fn();
    render(<PhotoOverlay photo={photo} onClose={onClose} />);
    const backdrop = screen.getByRole("button", { name: "Close", hidden: true });
    expect(backdrop.tagName).toBe("BUTTON");
    expect(backdrop.getAttribute("type")).toBe("button");
    expect(backdrop.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when the picture is clicked", () => {
    const onClose = vi.fn();
    render(<PhotoOverlay photo={photo} onClose={onClose} />);
    fireEvent.click(screen.getByRole("img", { name: "left side" }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape and on the close button", () => {
    const onClose = vi.fn();
    render(<PhotoOverlay photo={photo} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close picture" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
