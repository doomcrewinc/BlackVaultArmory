import sharp from "sharp";
import { detectFileSignature, isHeicFamilySignature } from "@/lib/server/file-signatures";

// One large upload must not take all of the container's memory.
sharp.concurrency(1);

export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_PHOTO_PIXELS = 100_000_000;
export const HEIC_MESSAGE =
  "HEIC photos are not supported. On an iPhone, set Camera → Formats to Most Compatible, or send the photo as JPEG.";

const PREVIEW_SIDE = 480;

export type PictureRejectionCode =
  | "TOO_LARGE"
  | "NOT_A_PICTURE"
  | "HEIC"
  | "TOO_MANY_PIXELS"
  | "METADATA_REMAINS";

export type ProcessedPicture = {
  /** Re-saved with no metadata block other than the colour profile, upright. */
  bytes: Buffer;
  extension: "jpg" | "png" | "webp";
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  /** WebP, longest side 480; only when `opts.preview` is set. */
  preview?: Buffer;
};

export class PictureRejected extends Error {
  constructor(
    public readonly code: PictureRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "PictureRejected";
  }
}

const FORMATS = {
  jpg: { mimeType: "image/jpeg", save: (p: sharp.Sharp) => p.jpeg({ quality: 92 }) },
  png: { mimeType: "image/png", save: (p: sharp.Sharp) => p.png() },
  webp: { mimeType: "image/webp", save: (p: sharp.Sharp) => p.webp({ quality: 92 }) },
} as const;

const NOT_READABLE = "This file could not be read as a picture.";

function pixelMessage(maxPixels: number): string {
  return `This picture is too large (over ${Math.round(maxPixels / 1_000_000)} megapixels).`;
}

function mapSharpError(e: unknown, maxPixels: number): PictureRejected {
  const message = e instanceof Error ? e.message : "";
  if (message.includes("pixel limit")) {
    return new PictureRejected("TOO_MANY_PIXELS", pixelMessage(maxPixels));
  }
  return new PictureRejected("NOT_A_PICTURE", NOT_READABLE);
}

/**
 * Validates a JPEG, PNG or WebP, applies its orientation to the pixels and
 * re-saves it at the same pixel size without location or other hidden
 * metadata. Throws PictureRejected; any other error is a server fault.
 */
export async function processPicture(
  input: Buffer,
  opts: { preview?: boolean; maxBytes?: number; maxPixels?: number } = {},
): Promise<ProcessedPicture> {
  const maxBytes = opts.maxBytes ?? MAX_PHOTO_BYTES;
  const maxPixels = opts.maxPixels ?? MAX_PHOTO_PIXELS;

  if (input.length > maxBytes) {
    throw new PictureRejected(
      "TOO_LARGE",
      `File too large. Maximum size is ${Math.round(maxBytes / 1048576)}MB.`,
    );
  }
  if (isHeicFamilySignature(input)) throw new PictureRejected("HEIC", HEIC_MESSAGE);

  const ext = detectFileSignature(input)?.extension;
  if (ext !== "jpg" && ext !== "png" && ext !== "webp") {
    throw new PictureRejected("NOT_A_PICTURE", "Invalid file type. Supported formats: JPEG, PNG, WebP.");
  }

  // rotate() with no argument applies the EXIF orientation to the pixels.
  // sharp writes no metadata unless asked; keepIccProfile() keeps only the
  // colour profile.
  const upright = () => sharp(input, { limitInputPixels: maxPixels }).rotate();

  let bytes: Buffer;
  try {
    const meta = await sharp(input, { limitInputPixels: maxPixels }).metadata();
    if ((meta.width ?? 0) * (meta.height ?? 0) > maxPixels) {
      throw new PictureRejected("TOO_MANY_PIXELS", pixelMessage(maxPixels));
    }
    bytes = await FORMATS[ext].save(upright().keepIccProfile()).toBuffer();
  } catch (e) {
    if (e instanceof PictureRejected) throw e;
    throw mapSharpError(e, maxPixels);
  }

  const out = await sharp(bytes).metadata();
  if (out.exif || out.xmp || out.iptc || (out.orientation && out.orientation !== 1)) {
    throw new PictureRejected(
      "METADATA_REMAINS",
      "This picture's hidden data could not be removed, so it was not stored.",
    );
  }

  const preview = opts.preview
    ? await upright()
        .resize({ width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer()
    : undefined;

  return {
    bytes,
    extension: ext,
    mimeType: FORMATS[ext].mimeType,
    width: out.width ?? 0,
    height: out.height ?? 0,
    preview,
  };
}
