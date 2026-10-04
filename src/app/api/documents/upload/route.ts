import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { detectFileSignature } from "@/lib/server/file-signatures";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireAuth, getCurrentUser } from "@/lib/server/auth";
import { PictureRejected, processPicture } from "@/lib/images/process";
import { documentsRoot, writeEncryptedFile } from "@/lib/files/storage";

const ALLOWED_EXTENSIONS = new Set(["pdf", "jpg", "png", "webp"]);

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

// POST /api/documents/upload
// Accepts multipart form data: file, name, type, firearmId?, accessoryId?, gearId?, notes?
// Saves to <uploadsRoot>/documents/{uuid}.{ext}, encrypted at rest (BVF1).
// Creates a Document record and returns it.
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    // Rate limiting — by user ID, fallback to "unknown" if getCurrentUser fails
    const user = await getCurrentUser();
    const rateLimitKey = user ? `u:${user.id}` : "unknown";
    const rate = await enforceRateLimit({
      key: `upload:documents:${rateLimitKey}`,
      windowMs: 60_000,
      maxAttempts: 20,
    });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many upload attempts. Please wait a minute." },
        { status: 429 },
      );
    }

    const formData = await request.formData();

    const file = formData.get("file") as File | null;
    const name = formData.get("name") as string | null;
    const type = (formData.get("type") as string | null) || "RECEIPT";
    const firearmId = formData.get("firearmId") as string | null;
    const accessoryId = formData.get("accessoryId") as string | null;
    const gearId = formData.get("gearId") as string | null;
    const notes = formData.get("notes") as string | null;

    if (!file) {
      return NextResponse.json(
        { error: "Missing required field: file" },
        { status: 400 },
      );
    }
    if (!name) {
      return NextResponse.json(
        { error: "Missing required field: name" },
        { status: 400 },
      );
    }

    if (file.size > MAX_SIZE) {
      return NextResponse.json(
        { error: "File too large. Maximum size is 20MB." },
        { status: 400 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const detected = detectFileSignature(buffer);

    if (!detected || !ALLOWED_EXTENSIONS.has(detected.extension)) {
      return NextResponse.json(
        {
          error: `Invalid file type. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(", ")}`,
        },
        { status: 400 },
      );
    }

    // Pictures are re-saved without location or other hidden metadata; PDFs
    // are stored as uploaded.
    let stored: Buffer = buffer;
    let storedMimeType = detected.mimeType;
    if (detected.extension !== "pdf") {
      try {
        const processed = await processPicture(buffer, { maxBytes: MAX_SIZE });
        stored = processed.bytes;
        storedMimeType = processed.mimeType;
      } catch (e) {
        if (e instanceof PictureRejected) {
          return NextResponse.json({ error: e.message }, { status: 400 });
        }
        throw e;
      }
    }

    // Generate a unique ID for the file
    const fileId = randomUUID().replace(/-/g, "");

    const fileName = `${fileId}.${detected.extension}`;
    const relativeUrl = `/api/files/documents/${fileName}`;

    const uploadDir = documentsRoot();
    const filePath = path.join(uploadDir, fileName);

    await fs.mkdir(uploadDir, { recursive: true });

    await writeEncryptedFile(filePath, stored);

    const doc = await prisma.document.create({
      data: {
        name,
        type,
        fileUrl: relativeUrl,
        fileSize: stored.length,
        mimeType: storedMimeType,
        notes: notes || null,
        firearmId: firearmId || null,
        accessoryId: accessoryId || null,
        gearId: gearId || null,
      },
      include: {
        firearm: { select: { id: true, name: true } },
        accessory: { select: { id: true, name: true } },
        gear: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json(doc, { status: 201 });
  } catch (error) {
    console.error("POST /api/documents/upload error:", error);
    return NextResponse.json(
      { error: "Failed to upload document" },
      { status: 500 },
    );
  }
}
