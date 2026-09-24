import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import {
  normalizeAmount,
  normalizeSupplyCategory,
  normalizeSupplyUnit,
  type SupplyCategory,
} from "@/lib/supply";
import { sectionBySlug } from "@/lib/categories";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// Supply-backed sections. The shared registry (src/lib/categories.ts) does
// not yet know about these — a later task registers cleaning/medical/
// food-water there with a "supply" source and a `supplyWhereForSection`
// helper mirroring `gearWhereForSection`. Once that lands, delete this map
// and `supplyWhereForSectionSlug` below and replace the `if (sectionSlug)`
// block in GET with the same two-call shape gear/route.ts uses:
//
//   const section = sectionBySlug(sectionSlug);
//   if (section) {
//     const supplyWhere = supplyWhereForSection(section);
//     if (!supplyWhere) return NextResponse.json([]);
//     where = supplyWhere;
//   }
//
// See task-3-report.md for the full hand-off note.
const CLEANING_CATEGORIES: SupplyCategory[] = ["CLEANING"];
const MEDICAL_CATEGORIES: SupplyCategory[] = ["MEDICAL"];
// food-water doubles as the catch-all: every category cleaning/medical
// didn't claim, the same shape as gear's "cases" section
// (gearSection(CASE_CATEGORIES) + otherGearSection()).
const FOOD_WATER_CLAIMED: SupplyCategory[] = ["CLEANING", "MEDICAL"];

function supplyWhereForSectionSlug(slug: string): object | undefined {
  if (slug === "cleaning") return { category: { in: CLEANING_CATEGORIES } };
  if (slug === "medical") return { category: { in: MEDICAL_CATEGORIES } };
  if (slug === "food-water") {
    return { category: { notIn: FOOD_WATER_CLAIMED } };
  }
  return undefined;
}

// GET /api/supplies - List all supplies, optionally filtered by category section
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sectionSlug = normalizeString(searchParams.get("section"));

    let where: object | undefined;

    if (sectionSlug) {
      const supplyWhere = supplyWhereForSectionSlug(sectionSlug);
      if (supplyWhere) {
        where = supplyWhere;
      } else {
        // Not a supply-backed slug. It may still be a section registered
        // elsewhere (e.g. "optics", "cases") that simply holds no
        // supplies — return early rather than querying with no filter,
        // which would return every supply instead of none.
        const section = sectionBySlug(sectionSlug);
        if (section) return NextResponse.json([]);
        // else: unrecognised slug — ignore it and apply no filter.
      }
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
