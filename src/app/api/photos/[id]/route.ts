import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeError } from "@/lib/photos/errors";
import { requireAuth } from "@/lib/server/auth";
import { ownerOf } from "@/lib/photos/owner";
import { itemDelegate, normaliseLabel, photoUrl, removePhotoFiles, toPhotoDto } from "@/lib/photos/store";

type Ctx = { params: Promise<{ id: string }> };

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

// PATCH /api/photos/[id] - body { label?: string | null, main?: true }
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const { id } = await params;
    const existing = await prisma.photo.findUnique({ where: { id } });
    if (!existing) return bad("Photo not found", 404);

    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return bad("Invalid request body.");
    }
    const { label: rawLabel, main } = body as { label?: unknown; main?: unknown };
    let label: string | null | undefined;
    if ("label" in body) {
      if (rawLabel !== null && typeof rawLabel !== "string") return bad("Label must be text or null.");
      try {
        label = normaliseLabel(rawLabel);
      } catch {
        return bad("Label is too long (80 characters at most).");
      }
    }

    const { type, id: entityId } = ownerOf(existing);
    const url = photoUrl(existing.fileName);
    const photo = await prisma.$transaction(async (tx) => {
      const updated = label === undefined ? existing : await tx.photo.update({ where: { id }, data: { label } });
      if (main === true) {
        await itemDelegate(tx, type).update({ where: { id: entityId }, data: { imageUrl: url } });
      }
      return updated;
    });

    const item = await itemDelegate(prisma, type).findUnique({ where: { id: entityId }, select: { imageUrl: true } });
    return NextResponse.json({ photo: toPhotoDto(photo, item?.imageUrl ?? null) });
  } catch (e) {
    console.error("PATCH /api/photos/[id] failed:", describeError(e));
    return bad("Failed to update photo", 500);
  }
}

// DELETE /api/photos/[id] - removes the row, clears the item's main picture
// when this was it, then removes the files.
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const { id } = await params;
    const existing = await prisma.photo.findUnique({ where: { id } });
    if (!existing) return bad("Photo not found", 404);

    const { type, id: entityId } = ownerOf(existing);
    const url = photoUrl(existing.fileName);
    await prisma.$transaction(async (tx) => {
      await tx.photo.delete({ where: { id } });
      const item = itemDelegate(tx, type);
      const current = await item.findUnique({ where: { id: entityId }, select: { imageUrl: true } });
      if (current?.imageUrl === url) {
        await item.update({ where: { id: entityId }, data: { imageUrl: null } });
      }
    });
    await removePhotoFiles([{ id: existing.id, fileName: existing.fileName }]);

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/photos/[id] failed:", describeError(e));
    return bad("Failed to delete photo", 500);
  }
}
