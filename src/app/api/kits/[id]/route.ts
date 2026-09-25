import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeKitCategory } from "@/lib/kit";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// The five relations a KitItem may point at. Included on the single-kit read
// so the detail page can render whichever one each line actually set without
// a second round trip per line.
const itemsInclude = {
  items: {
    include: {
      gear: true,
      supply: true,
      accessory: true,
      ammoStock: true,
      firearm: true,
    },
  },
} as const;

// GET /api/kits/[id] - Get a single kit with its items
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const kit = await prisma.kit.findUnique({
      where: { id },
      include: itemsInclude,
    });

    if (!kit) {
      return NextResponse.json({ error: "Kit not found" }, { status: 404 });
    }

    return NextResponse.json(kit);
  } catch (error) {
    console.error("GET /api/kits/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch kit" },
      { status: 500 },
    );
  }
}

// PUT /api/kits/[id] - Update a kit
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const { name, category, location, notes, imageUrl } = body;

    const existing = await prisma.kit.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Kit not found" }, { status: 404 });
    }

    const updated = await prisma.kit.update({
      where: { id },
      data: {
        ...(name !== undefined && {
          name: normalizeString(name) || existing.name,
        }),
        // category is NOT NULL with an application-level default — an
        // explicit null is treated like an absent key so the stored value
        // survives, matching the gear and supply routes.
        ...(category !== undefined &&
          category !== null && {
            category: normalizeKitCategory(category),
          }),
        ...(location !== undefined && {
          location: normalizeString(location) || null,
        }),
        ...(notes !== undefined && { notes }),
        ...(imageUrl !== undefined && { imageUrl }),
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT /api/kits/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to update kit" },
      { status: 500 },
    );
  }
}

// DELETE /api/kits/[id] - Delete a kit
//
// This deletes ONLY the Kit row. The KitItem rows that point at it are
// removed by the database's own `onDelete: Cascade` on KitItem.kitId (see
// prisma/*/schema.prisma) — this route never touches prisma.kitItem, and
// certainly never touches prisma.gear/supply/accessory/ammoStock/firearm.
// A KitItem's OTHER four relations (to the inventory record it points at)
// cascade the opposite way: deleting a Gear row removes the KitItem that
// referenced it, not the reverse. Deleting a kit must never delete a
// firearm just because it was packed in a bag.
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = await prisma.kit.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Kit not found" }, { status: 404 });
    }

    await prisma.kit.delete({ where: { id } });

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("DELETE /api/kits/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to delete kit" },
      { status: 500 },
    );
  }
}
