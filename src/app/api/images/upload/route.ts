import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { enforceRateLimit } from "@/lib/rate-limit";
import { requireAuth, getCurrentUser } from "@/lib/server/auth";
import { PictureRejected, processPicture, type ProcessedPicture } from "@/lib/images/process";
import { requireEntityWriteAccess, type WritableEntityType } from "@/lib/server/entity-write-access";
import { uploadsRoot, writeEncryptedFile } from "@/lib/files/storage";

// Every entity whose table carries an `imageUrl` column AND has a form that
// writes one. "kit" is here because Kit.imageUrl is a dead column unless
// this allowlist, ImagePicker's union and the kit edit form all know about
// it. Directory and URL are derived
// (`${entityType}s`), so nothing else here is per-entity.
const ALLOWED_ENTITY_TYPES = new Set([
  "firearm",
  "accessory",
  "ammo",
  "build",
  "gear",
  "kit",
]);
const SAFE_ENTITY_ID = /^[a-zA-Z0-9_-]{1,64}$/;

// POST /api/images/upload - Upload an image for an entity
// Accepts multipart form data: file, entityType, entityId
// Saves to /uploads/images/{entityType}s/{entityId}.{ext}
// Returns the URL path.
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    // Rate limiting — by user ID, fallback to "unknown" if getCurrentUser fails
    const user = await getCurrentUser();
    const rateLimitKey = user ? `u:${user.id}` : "unknown";
    const rate = await enforceRateLimit({ key: `upload:images:${rateLimitKey}`, windowMs: 60_000, maxAttempts: 20 });
    if (!rate.allowed) {
      return NextResponse.json(
        { error: "Too many upload attempts. Please wait a minute." },
        { status: 429 }
      );
    }

    const formData = await request.formData();

    const file = formData.get("file") as File | null;
    const entityType = formData.get("entityType") as string | null;
    const entityId = formData.get("entityId") as string | null;

    if (!file) {
      return NextResponse.json(
        { error: "Missing required field: file" },
        { status: 400 }
      );
    }

    if (!entityType || !entityId) {
      return NextResponse.json(
        { error: "Missing required fields: entityType, entityId" },
        { status: 400 }
      );
    }

    if (!ALLOWED_ENTITY_TYPES.has(entityType)) {
      return NextResponse.json(
        {
          error: `Invalid entityType. Must be one of: ${Array.from(ALLOWED_ENTITY_TYPES).join(", ")}`,
        },
        { status: 400 }
      );
    }

    if (!SAFE_ENTITY_ID.test(entityId)) {
      return NextResponse.json(
        { error: "Invalid entityId" },
        { status: 400 }
      );
    }
    const sanitizedEntityId = entityId;

    const entityAccess = await requireEntityWriteAccess(
      request,
      entityType as WritableEntityType,
      sanitizedEntityId
    );
    if (!entityAccess.ok) {
      return entityAccess.response;
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    let processed: ProcessedPicture;
    try {
      processed = await processPicture(buffer);
    } catch (e) {
      if (e instanceof PictureRejected) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    // Build paths
    // entityType = "firearm" -> directory = "firearms"
    const entityTypeDir = `${entityType}s`;
    const fileName = `${sanitizedEntityId}_${Date.now()}.${processed.extension}`;
    const relativeUrl = `/uploads/images/${entityTypeDir}/${fileName}`;

    // Resolve the absolute path outside the web root
    const uploadRoot = uploadsRoot();
    const uploadDir = path.join(uploadRoot, "images", entityTypeDir);
    const filePath = path.join(uploadDir, fileName);

    // Ensure the directory exists
    await fs.mkdir(uploadDir, { recursive: true });

    await writeEncryptedFile(filePath, processed.bytes);

    return NextResponse.json(
      {
        url: relativeUrl,
        entityType,
        entityId: sanitizedEntityId,
        fileName,
        size: processed.bytes.length,
        mimeType: processed.mimeType,
      },
      { status: 201 }
    );
  } catch {
    console.error("POST /api/images/upload failed");
    return NextResponse.json(
      { error: "Failed to upload image" },
      { status: 500 }
    );
  }
}
