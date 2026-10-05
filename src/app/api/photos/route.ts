import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeError, uploadFailureMessage } from "@/lib/photos/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getCurrentUser, requireAuth } from "@/lib/server/auth";
import { MAX_PHOTO_BYTES, PictureRejected } from "@/lib/images/process";
import {
  SAFE_ENTITY_ID,
  findOwnerName,
  isPhotoEntityType,
  ownerWhere,
  type PhotoEntityType,
} from "@/lib/photos/owner";
import { addPhoto, itemDelegate, normaliseLabel, toPhotoDto } from "@/lib/photos/store";

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

/** The entity named by the request, or the response to send instead. */
async function resolveEntity(
  entityType: unknown,
  entityId: unknown,
): Promise<{ type: PhotoEntityType; id: string } | NextResponse> {
  if (!isPhotoEntityType(entityType)) return bad("Invalid entityType");
  if (typeof entityId !== "string" || !SAFE_ENTITY_ID.test(entityId)) return bad("Invalid entityId");
  if ((await findOwnerName(entityType, entityId)) === null) return bad("Item not found", 404);
  return { type: entityType, id: entityId };
}

// GET /api/photos?entityType=&entityId= - an item's photos, oldest first
export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const params = new URL(request.url).searchParams;
    const entity = await resolveEntity(params.get("entityType"), params.get("entityId"));
    if (entity instanceof NextResponse) return entity;

    const [photos, item] = await Promise.all([
      prisma.photo.findMany({ where: ownerWhere(entity.type, entity.id), orderBy: { createdAt: "asc" } }),
      itemDelegate(prisma, entity.type).findUnique({ where: { id: entity.id }, select: { imageUrl: true } }),
    ]);
    const main = item?.imageUrl ?? null;
    return NextResponse.json({ photos: photos.map((p) => toPhotoDto(p, main)) });
  } catch (e) {
    console.error("GET /api/photos failed:", describeError(e));
    return bad("Failed to list photos", 500);
  }
}

// POST /api/photos - multipart: file, entityType, entityId, label?
export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const user = await getCurrentUser();
    const rateOwner = user ? `u:${user.id}` : "unknown";
    const rate = await enforceRateLimit({
      key: `upload:photos:${rateOwner}`,
      windowMs: 60_000,
      maxAttempts: 20,
    });
    if (!rate.allowed) return bad("Too many upload attempts. Please wait a minute.", 429);

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return bad("Missing required field: file");

    let label: string | null;
    try {
      label = normaliseLabel(formData.get("label"));
    } catch {
      return bad("Label is too long (80 characters at most).");
    }

    const entity = await resolveEntity(formData.get("entityType"), formData.get("entityId"));
    if (entity instanceof NextResponse) return entity;

    if (file.size > MAX_PHOTO_BYTES) return bad("File too large. Maximum size is 25MB.");

    try {
      const photo = await addPhoto({
        bytes: Buffer.from(await file.arrayBuffer()),
        type: entity.type,
        entityId: entity.id,
        label,
        createdById: user?.id ?? null,
        viaPass: false,
      });
      const item = await itemDelegate(prisma, entity.type).findUnique({
        where: { id: entity.id },
        select: { imageUrl: true },
      });
      return NextResponse.json({ photo: toPhotoDto(photo, item?.imageUrl ?? null) }, { status: 201 });
    } catch (e) {
      if (e instanceof PictureRejected) return bad(e.message);
      throw e;
    }
  } catch (e) {
    console.error("POST /api/photos failed:", describeError(e));
    return bad(uploadFailureMessage(e, "Failed to upload photo"), 500);
  }
}
