import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { normalizeGearArmorFields, normalizeGearCategory } from "@/lib/gear";
import { normalizeMoney } from "@/lib/money";
import { normalizeQuantity } from "@/lib/quantity";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/gear/[id] - Get a single gear item with its documents
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const gear = await prisma.gear.findUnique({
      where: { id },
      include: {
        documents: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    if (!gear) {
      return NextResponse.json({ error: "Gear not found" }, { status: 404 });
    }

    return NextResponse.json(gear);
  } catch (error) {
    console.error("GET /api/gear/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch gear" },
      { status: 500 },
    );
  }
}

// PUT /api/gear/[id] - Update a gear item
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const {
      name,
      manufacturer,
      model,
      serialNumber,
      category,
      quantity,
      purchasePrice,
      currentValue,
      acquisitionDate,
      expirationDate,
      storageLocation,
      notes,
      imageUrl,
      imageSource,
    } = body;

    const existing = await prisma.gear.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Gear not found" }, { status: 404 });
    }

    const updated = await prisma.gear.update({
      where: { id },
      data: {
        ...(name !== undefined && {
          name: normalizeString(name) || existing.name,
        }),
        ...(manufacturer !== undefined && {
          manufacturer: normalizeString(manufacturer) || null,
        }),
        ...(model !== undefined && { model: normalizeString(model) || null }),
        ...(serialNumber !== undefined && {
          serialNumber: normalizeString(serialNumber) || null,
        }),
        // category is NOT NULL with an application-level default — an
        // explicit null is treated like an absent key so the stored value
        // survives, matching quantity below.
        ...(category !== undefined &&
          category !== null && {
            category: normalizeGearCategory(category),
          }),
        ...(purchasePrice !== undefined && {
          purchasePrice: normalizeMoney(purchasePrice),
        }),
        ...(currentValue !== undefined && {
          currentValue: normalizeMoney(currentValue),
        }),
        ...(acquisitionDate !== undefined && {
          acquisitionDate: acquisitionDate
            ? toDateOnlyUTC(acquisitionDate)
            : null,
        }),
        ...(expirationDate !== undefined && {
          expirationDate: expirationDate ? toDateOnlyUTC(expirationDate) : null,
        }),
        ...normalizeGearArmorFields({ existing, body }),
        ...(storageLocation !== undefined && {
          storageLocation: normalizeString(storageLocation) || null,
        }),
        ...(notes !== undefined && { notes }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(imageSource !== undefined && { imageSource }),
        // quantity never resets: an emptied number input posts "", which
        // must preserve the stored value rather than falling back to 1.
        ...(quantity !== undefined &&
          quantity !== null && {
            quantity: normalizeQuantity(quantity, existing.quantity),
          }),
      },
      include: {
        documents: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT /api/gear/[id] error:", error);
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to update gear" },
      { status: 500 },
    );
  }
}

// DELETE /api/gear/[id] - Delete a gear item
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = await prisma.gear.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Gear not found" }, { status: 404 });
    }

    await prisma.gear.delete({ where: { id } });

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("DELETE /api/gear/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to delete gear" },
      { status: 500 },
    );
  }
}
