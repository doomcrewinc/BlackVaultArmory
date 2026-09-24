import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import {
  normalizeAmount,
  normalizeSupplyCategory,
  normalizeSupplyUnit,
} from "@/lib/supply";
import { revalidateDashboardData } from "@/lib/dashboard/revalidate-dashboard";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/supplies/[id] - Get a single supply
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const supply = await prisma.supply.findUnique({ where: { id } });

    if (!supply) {
      return NextResponse.json({ error: "Supply not found" }, { status: 404 });
    }

    return NextResponse.json(supply);
  } catch (error) {
    console.error("GET /api/supplies/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch supply" },
      { status: 500 },
    );
  }
}

// PUT /api/supplies/[id] - Update a supply
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const {
      name,
      brand,
      category,
      quantity,
      unit,
      lowStockAlert,
      expirationDate,
      purchasePrice,
      purchaseDate,
      storageLocation,
      notes,
    } = body;

    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Supply not found" }, { status: 404 });
    }

    const updated = await prisma.supply.update({
      where: { id },
      data: {
        ...(name !== undefined && {
          name: normalizeString(name) || existing.name,
        }),
        ...(brand !== undefined && { brand: normalizeString(brand) || null }),
        // category is NOT NULL with an application-level default — an
        // explicit null is treated like an absent key so the stored value
        // survives, matching quantity below.
        ...(category !== undefined &&
          category !== null && {
            category: normalizeSupplyCategory(category),
          }),
        // unit follows the same NOT-NULL shape as category.
        ...(unit !== undefined &&
          unit !== null && {
            unit: normalizeSupplyUnit(unit),
          }),
        // quantity never resets: an emptied number input posts "", which
        // must preserve the stored value rather than zeroing it out, and a
        // real 0 must still be stored as 0. An explicit null is also
        // treated like an absent key, same as category/unit above.
        ...(quantity !== undefined &&
          quantity !== null && {
            quantity:
              normalizeAmount(quantity, existing.quantity) ?? existing.quantity,
          }),
        // lowStockAlert is nullable and CAN be intentionally cleared, unlike
        // quantity/category/unit above — an explicit null clears it, and
        // only an absent key leaves it untouched.
        ...(lowStockAlert !== undefined && {
          lowStockAlert:
            lowStockAlert === null
              ? null
              : normalizeAmount(lowStockAlert, existing.lowStockAlert),
        }),
        ...(expirationDate !== undefined && {
          expirationDate: expirationDate ? toDateOnlyUTC(expirationDate) : null,
        }),
        ...(purchasePrice !== undefined && { purchasePrice }),
        ...(purchaseDate !== undefined && {
          purchaseDate: purchaseDate ? toDateOnlyUTC(purchaseDate) : null,
        }),
        ...(storageLocation !== undefined && {
          storageLocation: normalizeString(storageLocation) || null,
        }),
        ...(notes !== undefined && { notes }),
      },
    });

    // A quantity, threshold or expiry edit changes the dashboard's Supply
    // Alerts; see the note in the POST handler.
    revalidateDashboardData();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT /api/supplies/[id] error:", error);
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to update supply" },
      { status: 500 },
    );
  }
}

// DELETE /api/supplies/[id] - Delete a supply
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = await prisma.supply.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Supply not found" }, { status: 404 });
    }

    await prisma.supply.delete({ where: { id } });

    revalidateDashboardData();

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("DELETE /api/supplies/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to delete supply" },
      { status: 500 },
    );
  }
}
