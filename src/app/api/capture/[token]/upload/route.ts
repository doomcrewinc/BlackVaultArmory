import { handleCaptureUpload } from "@/lib/capture/upload";
import { describeError } from "@/lib/photos/errors";
import { NextResponse } from "next/server";

type Ctx = { params: Promise<{ token: string }> };

// POST /api/capture/[token]/upload - no session. multipart: file, kind, label?, docType?, name?
// The pass names the item; nothing in the form can.
export async function POST(request: Request, { params }: Ctx) {
  try {
    const { token } = await params;
    return await handleCaptureUpload(request, token);
  } catch (e) {
    console.error("POST /api/capture/[token]/upload failed:", describeError(e));
    return NextResponse.json({ error: "Failed to upload" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
