import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DOCUMENT_OWNER_INCLUDE } from "@/lib/documents/owner-include";
import { requireAuth } from "@/lib/server/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const firearmId = searchParams.get("firearmId");
    const accessoryId = searchParams.get("accessoryId");
    const gearId = searchParams.get("gearId");
    const ammoStockId = searchParams.get("ammoStockId");
    const supplyId = searchParams.get("supplyId");
    const kitId = searchParams.get("kitId");
    const type = searchParams.get("type");

    const docs = await prisma.document.findMany({
      where: {
        ...(firearmId ? { firearmId } : {}),
        ...(accessoryId ? { accessoryId } : {}),
        ...(gearId ? { gearId } : {}),
        ...(ammoStockId ? { ammoStockId } : {}),
        ...(supplyId ? { supplyId } : {}),
        ...(kitId ? { kitId } : {}),
        ...(type ? { type } : {}),
      },
      include: DOCUMENT_OWNER_INCLUDE,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(docs);
  } catch (error) {
    console.error("GET /api/documents error:", error);
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  try {
    const body = await req.json();
    const {
      name,
      type,
      fileUrl,
      fileSize,
      mimeType,
      notes,
      firearmId,
      accessoryId,
      gearId,
      ammoStockId,
      supplyId,
      kitId,
    } = body;

    if (!name || !fileUrl) {
      return NextResponse.json(
        { error: "name and fileUrl are required" },
        { status: 400 },
      );
    }

    const doc = await prisma.document.create({
      data: {
        name,
        type: type || "RECEIPT",
        fileUrl,
        fileSize: fileSize ? Number(fileSize) : null,
        mimeType: mimeType || null,
        notes: notes || null,
        firearmId: firearmId || null,
        accessoryId: accessoryId || null,
        gearId: gearId || null,
        ammoStockId: ammoStockId || null,
        supplyId: supplyId || null,
        kitId: kitId || null,
      },
      include: DOCUMENT_OWNER_INCLUDE,
    });

    return NextResponse.json(doc, { status: 201 });
  } catch (error) {
    console.error("POST /api/documents error:", error);
    return NextResponse.json(
      { error: "Failed to create document" },
      { status: 500 },
    );
  }
}
