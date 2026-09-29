// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ImageProps } from "next/image";
import { SafeImage } from "./SafeImage";

// Records what SafeImage hands next/image, without running the optimiser.
vi.mock("next/image", () => ({
  default: ({ src, alt, unoptimized }: ImageProps) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={String(src)} alt={alt} data-unoptimized={String(Boolean(unoptimized))} />
  ),
}));

afterEach(cleanup);

function unoptimizedFor(src: string, extra: Partial<ImageProps> = {}) {
  render(<SafeImage src={src} alt="pic" width={10} height={10} fallback={null} {...extra} />);
  return screen.getByAltText("pic").getAttribute("data-unoptimized");
}

describe("SafeImage — local sources bypass /_next/image so the browser sends the session cookie", () => {
  it("passes unoptimized for /uploads/...", () => {
    expect(unoptimizedFor("/uploads/images/a.jpg")).toBe("true");
  });

  it("passes unoptimized for /api/...", () => {
    expect(unoptimizedFor("/api/image-proxy?u=x")).toBe("true");
  });

  it("keeps optimisation for remote https URLs", () => {
    expect(unoptimizedFor("https://example.com/a.jpg")).toBe("false");
  });

  it("respects an explicit unoptimized from the caller", () => {
    expect(unoptimizedFor("https://example.com/a.jpg", { unoptimized: true })).toBe("true");
  });
});
