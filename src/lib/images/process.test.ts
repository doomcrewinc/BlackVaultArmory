import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  HEIC_MESSAGE,
  PictureRejected,
  processPicture,
} from "./process";

const GPS_EXIF = {
  IFD0: { Make: "TestCam" },
  IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 26/1 46/1" },
};

function blank(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  });
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(PictureRejected);
    return e as PictureRejected;
  }
  throw new Error("expected PictureRejected");
}

describe("processPicture", () => {
  it("removes EXIF, GPS, XMP and IPTC from a JPEG and keeps its size", async () => {
    const input = await blank(40, 20).jpeg().withMetadata({ exif: GPS_EXIF }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const out = await processPicture(input);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(out.width).toBe(40);
    expect(out.height).toBe(20);
    expect(out.extension).toBe("jpg");
    expect(out.mimeType).toBe("image/jpeg");
    expect(out.preview).toBeUndefined();
  });

  it("stores a sideways photo (orientation 6) upright with no orientation tag", async () => {
    const input = await blank(40, 20).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(input).metadata()).orientation).toBe(6);

    const out = await processPicture(input);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(20);
    expect(meta.height).toBe(40);
    expect(out.width).toBe(20);
    expect(out.height).toBe(40);
    expect(meta.orientation).toBeUndefined();
  });

  it("keeps the format and size of a PNG and a WebP and drops their metadata", async () => {
    const png = await blank(30, 10).png().withMetadata({ exif: GPS_EXIF }).toBuffer();
    const webp = await blank(30, 10).webp().withMetadata({ exif: GPS_EXIF }).toBuffer();

    const outPng = await processPicture(png);
    const outWebp = await processPicture(webp);

    expect(outPng.extension).toBe("png");
    expect(outPng.mimeType).toBe("image/png");
    expect(outWebp.extension).toBe("webp");
    expect(outWebp.mimeType).toBe("image/webp");
    for (const out of [outPng, outWebp]) {
      const meta = await sharp(out.bytes).metadata();
      expect(meta.format).toBe(out.extension);
      expect(meta.width).toBe(30);
      expect(meta.height).toBe(10);
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
    }
  });

  it("keeps the colour profile", async () => {
    const input = await blank(40, 20)
      .jpeg()
      .withIccProfile("srgb")
      .withMetadata({ exif: GPS_EXIF })
      .toBuffer();
    expect((await sharp(input).metadata()).icc).toBeDefined();

    const out = await processPicture(input);
    const meta = await sharp(out.bytes).metadata();
    expect(meta.icc).toBeDefined();
    expect(meta.exif).toBeUndefined();
  });

  it("makes a WebP preview with a longest side of 480", async () => {
    const input = await blank(1200, 600).jpeg().toBuffer();
    const out = await processPicture(input, { preview: true });
    const meta = await sharp(out.preview).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(240);
    expect(out.width).toBe(1200);
  });

  it("does not enlarge a small picture for its preview", async () => {
    const input = await blank(100, 50).jpeg().toBuffer();
    const out = await processPicture(input, { preview: true });
    const meta = await sharp(out.preview).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(50);
  });

  it("rejects a HEIC file with the HEIC message", async () => {
    const heic = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const e = await rejection(processPicture(heic));
    expect(e.code).toBe("HEIC");
    expect(e.message).toBe(HEIC_MESSAGE);
  });

  it("rejects bytes that are not a picture", async () => {
    expect((await rejection(processPicture(Buffer.from([1, 2, 3, 4])))).code).toBe("NOT_A_PICTURE");
    expect((await rejection(processPicture(Buffer.from("%PDF-1.4\n%EOF\n")))).code).toBe("NOT_A_PICTURE");
  });

  it("rejects a file whose header looks like a picture but cannot be decoded", async () => {
    const fake = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    expect((await rejection(processPicture(fake))).code).toBe("NOT_A_PICTURE");
  });

  it("rejects a file over maxBytes", async () => {
    const input = await blank(40, 20).jpeg().toBuffer();
    const e = await rejection(processPicture(input, { maxBytes: 10 }));
    expect(e.code).toBe("TOO_LARGE");
  });

  it("rejects a picture over maxPixels", async () => {
    const input = await blank(40, 20).jpeg().toBuffer();
    const e = await rejection(processPicture(input, { maxPixels: 100 }));
    expect(e.code).toBe("TOO_MANY_PIXELS");
  });
});
