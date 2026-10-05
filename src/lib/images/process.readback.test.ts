import { describe, expect, it, vi } from "vitest";

// Every sharp(...) call made without options is the read-back of the saved
// bytes; its metadata() is made to report a leftover XMP block, which is the
// only way to reach the METADATA_REMAINS guard with real pictures.
vi.mock("sharp", async (importOriginal) => {
  const real = (await importOriginal<{ default: typeof import("sharp") }>()).default;
  const wrapped = ((input: unknown, options?: unknown) => {
    const instance = real(input as never, options as never);
    if (options === undefined && Buffer.isBuffer(input)) {
      const original = instance.metadata.bind(instance);
      instance.metadata = (async () => ({
        ...(await original()),
        xmp: Buffer.from("leftover"),
      })) as typeof instance.metadata;
    }
    return instance;
  }) as unknown as typeof real;
  wrapped.concurrency = real.concurrency;
  return { default: wrapped };
});

import { PictureRejected, processPicture } from "./process";
import sharp from "sharp";

describe("processPicture read-back check", () => {
  it("rejects with METADATA_REMAINS when the saved picture still has a metadata block", async () => {
    const input = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();

    const error = await processPicture(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PictureRejected);
    expect((error as PictureRejected).code).toBe("METADATA_REMAINS");
  });
});
