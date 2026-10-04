import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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

    const body = await request.json().catch(() => ({}));
    let label: string | null | undefined;
    if ("label" in body) {
      try {
        label = normaliseLabel(body.label);
      } catch {
        return bad("Label is too long (80 characters at most).");
      }
    }

    const { type, id: entityId } = ownerOf(existing);
    const url = photoUrl(existing.fileName);
    const photo = await prisma.$transaction(async (tx) => {
      const updated = label === undefined ? existing : await tx.photo.update({ where: { id }, data: { label } });
      if (body.main === true) {
        await itemDelegate(tx, type).update({ where: { id: entityId }, data: { imageUrl: url } });
      }
      return updated;
    });

    const item = await itemDelegate(prisma, type).findUnique({ where: { id: entityId }, select: { imageUrl: true } });
    return NextResponse.json({ photo: toPhotoDto(photo, item?.imageUrl ?? null) });
  } catch {
    console.error("PATCH /api/photos/[id] failed");
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
  } catch {
    console.error("DELETE /api/photos/[id] failed");
    return bad("Failed to delete photo", 500);
  }
}
