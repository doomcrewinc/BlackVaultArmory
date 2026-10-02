import { NextRequest, NextResponse } from "next/server";
import { basename } from "path";
import { requireAuth } from "@/lib/server/auth";
import { resolveDocumentStoragePath } from "@/lib/upload-security";
import { FileAtRestError, fileResponseHeaders, readDecryptedFile } from "@/lib/files/storage";

function guessMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileName: string }> }
) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const { fileName } = await params;
    const safeName = basename(fileName);
    const fileUrl = `/api/files/documents/${safeName}`;
    const filePath = resolveDocumentStoragePath(fileUrl);

    if (!filePath) {
      return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
    }

    const fileBuffer = await readDecryptedFile(filePath);

    return new NextResponse(new Uint8Array(fileBuffer), {
      headers: fileResponseHeaders(guessMimeType(safeName)),
    });
  } catch (error: unknown) {
    if (error instanceof FileAtRestError) {
      console.error(`[documents] ${error.code} for ${error.path}`);
      return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    console.error("GET /api/files/documents/[fileName] error:", error);
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }
}
