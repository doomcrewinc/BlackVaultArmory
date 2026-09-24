import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import {
  normalizeAmount,
  normalizeSupplyCategory,
  normalizeSupplyUnit,
} from "@/lib/supply";
import { sectionBySlug, supplyWhereForSection } from "@/lib/categories";
import { revalidateDashboardData } from "@/lib/dashboard/revalidate-dashboard";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/supplies - List all supplies, optionally filtered by category section
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sectionSlug = normalizeString(searchParams.get("section"));

    let where: object | undefined;

    if (sectionSlug) {
      const section = sectionBySlug(sectionSlug);
      if (section) {
        const supplyWhere = supplyWhereForSection(section);
        // A slug already registered but with no supply source (e.g. "optics")
        // holds no supplies — return early rather than querying with no
        // filter, which would return every supply instead of none.
        if (!supplyWhere) return NextResponse.json([]);
        where = supplyWhere;
      }
      // else: unrecognised slug — ignore it and apply no filter.
    }

    const supplies = await prisma.supply.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(supplies);
  } catch (error) {
    console.error("GET /api/supplies error:", error);
    return NextResponse.json(
      { error: "Failed to fetch supplies" },
      { status: 500 },
    );
  }
}

// POST /api/supplies - Create a new supply item
export async function POST(request: NextRequest) {
  try {
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

    const normalizedName = normalizeString(name);
    if (!normalizedName) {
      return NextResponse.json(
        { error: "Missing required field: name" },
        { status: 400 },
      );
    }

    const supply = await prisma.supply.create({
      data: {
        name: normalizedName,
        brand: normalizeString(brand) || null,
        category: normalizeSupplyCategory(category),
        // quantity is NOT NULL DEFAULT 0 — a missing/malformed value falls
        // back to 0 on create (there is no stored value to preserve yet).
        quantity: normalizeAmount(quantity, 0) ?? 0,
        unit: normalizeSupplyUnit(unit),
        lowStockAlert: normalizeAmount(lowStockAlert),
        expirationDate: expirationDate ? toDateOnlyUTC(expirationDate) : null,
        purchasePrice: purchasePrice ?? null,
        purchaseDate: purchaseDate ? toDateOnlyUTC(purchaseDate) : null,
        storageLocation: normalizeString(storageLocation) || null,
        notes: notes ?? null,
      },
    });

    // Supplies feed the dashboard's Supply Alerts widget, and `/` is a static
    // prerender with no time revalidation — without this the server-rendered
    // counts sit at their build-time values until some unrelated write
    // revalidates the page. Matches firearms, accessories, ammo and builds.
    revalidateDashboardData();

    return NextResponse.json(supply, { status: 201 });
  } catch (error) {
    console.error("POST /api/supplies error:", error);
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to create supply" },
      { status: 500 },
    );
  }
}
