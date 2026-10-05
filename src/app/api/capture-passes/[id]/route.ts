import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { describeError } from "@/lib/photos/errors";
import { getCurrentUser } from "@/lib/server/auth";
import { recordEventBestEffort } from "@/lib/audit/events";
import { PASS_MAX_UPLOADS, closePass, endReason } from "@/lib/capture/pass";
import { OWNER_MODEL, findOwnerName, ownerWhere, type PhotoEntityType } from "@/lib/photos/owner";
import { itemDelegate, toPhotoDto } from "@/lib/photos/store";

type Ctx = { params: Promise<{ id: string }> };

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

// GET /api/capture-passes/[id] - the creating account only: state, and what has arrived
export async function GET(_request: NextRequest, { params }: Ctx) {
  try {
    const user = await getCurrentUser();
    if (!user) return bad("Authentication required", 401);

    const { id } = await params;
    const pass = await prisma.capturePass.findUnique({ where: { id } });
    if (!pass || pass.createdById !== user.id) return bad("Capture pass not found", 404);

    const type = pass.entityType as PhotoEntityType;
    const owner = ownerWhere(type, pass.entityId);
    const [photos, documents, item] = await Promise.all([
      prisma.photo.findMany({
        where: { ...owner, viaPass: true, createdAt: { gte: pass.createdAt } },
        orderBy: { createdAt: "asc" },
      }),
      prisma.document.findMany({
        where: { ...owner, createdAt: { gte: pass.createdAt } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, type: true, createdAt: true },
      }),
      itemDelegate(prisma, type).findUnique({ where: { id: pass.entityId }, select: { imageUrl: true } }),
    ]);

    return NextResponse.json(
      {
        status: endReason(pass) ?? "open",
        expiresAt: pass.expiresAt.toISOString(),
        uploadCount: pass.uploadCount,
        remaining: Math.max(PASS_MAX_UPLOADS - pass.uploadCount, 0),
        photos: photos.map((p) => toPhotoDto(p, item?.imageUrl ?? null)),
        documents: documents.map((d) => ({ id: d.id, name: d.name, type: d.type, createdAt: d.createdAt.toISOString() })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("GET /api/capture-passes/[id] failed:", describeError(e));
    return bad("Failed to read capture pass", 500);
  }
}

// DELETE /api/capture-passes/[id] - the creating account or an admin
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  try {
    const user = await getCurrentUser();
    if (!user) return bad("Authentication required", 401);

    const { id } = await params;
    const pass = await prisma.capturePass.findUnique({ where: { id } });
    if (!pass) return bad("Capture pass not found", 404);
    if (pass.createdById !== user.id && user.role !== "ADMIN") return bad("Forbidden", 403);

    if (await closePass(pass.id)) {
      const type = pass.entityType as PhotoEntityType;
      await recordEventBestEffort(null, {
        action: "CAPTURE_PASS_CLOSED",
        entityType: OWNER_MODEL[type],
        entityId: pass.entityId,
        entityLabel: (await findOwnerName(type, pass.entityId)) ?? pass.entityId,
        changes: { passId: pass.id },
      });
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    console.error("DELETE /api/capture-passes/[id] failed:", describeError(e));
    return bad("Failed to close capture pass", 500);
  }
}
