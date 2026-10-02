import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { FileAtRestError, fileResponseHeaders, readDecryptedFile, uploadsRoot } from "@/lib/files/storage";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/;

// GET /uploads/[...path] - Serve uploaded media from IMAGE_UPLOAD_DIR or ./uploads
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path: rawPath } = await params;
    const segments = Array.isArray(rawPath) ? rawPath : [];
    if (segments.length < 2 || !segments.every((seg) => SAFE_SEGMENT.test(seg))) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }

    const absoluteRoot = path.resolve(uploadsRoot());
    const filePath = path.resolve(absoluteRoot, ...segments);
    const extension = path.extname(filePath).toLowerCase();
    const contentType = MIME_BY_EXT[extension];

    if (!contentType) {
      return NextResponse.json({ error: "Unsupported file type" }, { status: 400 });
    }

    if (!filePath.startsWith(`${absoluteRoot}${path.sep}`)) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }

    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const realRoot = await fs.realpath(absoluteRoot);
    const realFilePath = await fs.realpath(filePath);
    if (!realFilePath.startsWith(`${realRoot}${path.sep}`)) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }

    let file: Buffer;
    try {
      file = await readDecryptedFile(filePath);
    } catch (error) {
      if (error instanceof FileAtRestError) {
        console.error(`[uploads] ${error.code}${error.causeCode ? ` (${error.causeCode})` : ""} for ${error.path}`);
        return NextResponse.json({ error: "File unavailable" }, { status: 500 });
      }
      // Fix round 1, m4: this used to rethrow into the outer catch, which
      // returns a silent, unlogged 404 for EVERY failure — indistinguishable
      // from a genuinely missing file. Only a real ENOENT (the file vanished
      // between the lstat check above and this read) is still a 404; any
      // other failure (e.g. getFieldKeys() throwing) is logged and a 500,
      // never swallowed.
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
      console.error("GET /uploads/[...path] error:", error);
      return NextResponse.json({ error: "File unavailable" }, { status: 500 });
    }

    return new NextResponse(new Uint8Array(file), {
      status: 200,
      headers: fileResponseHeaders(contentType),
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
