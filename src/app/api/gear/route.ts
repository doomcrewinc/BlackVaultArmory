import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { GearCategory, normalizeGearCategory } from "@/lib/gear";
import { normalizeQuantity } from "@/lib/quantity";
import { sectionBySlug } from "@/lib/categories";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Gear-backed sections (knives, cases, ...) are not in the category registry
 * yet — `src/lib/categories.ts` only knows firearm- and accessory-sourced
 * sections until a later task adds a "gear" source and a `gearWhereForSection`
 * helper. Until that lands, resolve a gear section's categories here.
 *
 * To swap in the helper later: replace the two lookups below (the
 * `sectionBySlug` early-return and this map) with:
 *   const where = gearWhereForSection(section) ...
 * following the same shape as `accessoryWhereForSection`.
 */
const GEAR_SECTION_CATEGORIES: Record<string, GearCategory[]> = {
  knives: ["KNIFE"],
  cases: ["CASE"],
};

// GET /api/gear - List all gear, optionally filtered by category section
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sectionSlug = normalizeString(searchParams.get("section"));

    let where: { category: { in: GearCategory[] } } | undefined;

    if (sectionSlug) {
      // A slug already registered as a firearm- or accessory-sourced section
      // (e.g. "optics") has no gear source — return early rather than
      // querying with no filter, which would return every gear item instead
      // of none.
      if (sectionBySlug(sectionSlug)) {
        return NextResponse.json([]);
      }

      const categories = GEAR_SECTION_CATEGORIES[sectionSlug];
      if (categories) {
        where = { category: { in: categories } };
      }
      // else: unrecognised slug — ignore it and apply no filter.
    }

    const gear = await prisma.gear.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(gear);
  } catch (error) {
    console.error("GET /api/gear error:", error);
    return NextResponse.json(
      { error: "Failed to fetch gear" },
      { status: 500 },
    );
  }
}

// POST /api/gear - Create a new gear item
export async function POST(request: NextRequest) {
  try {
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
      storageLocation,
      notes,
      imageUrl,
      imageSource,
    } = body;

    const normalizedName = normalizeString(name);
    if (!normalizedName) {
      return NextResponse.json(
        { error: "Missing required field: name" },
        { status: 400 },
      );
    }

    const gear = await prisma.gear.create({
      data: {
        name: normalizedName,
        manufacturer: normalizeString(manufacturer) || null,
        model: normalizeString(model) || null,
        serialNumber: normalizeString(serialNumber) || null,
        category: normalizeGearCategory(category),
        quantity: normalizeQuantity(quantity),
        purchasePrice: purchasePrice ?? null,
        currentValue: currentValue ?? null,
        acquisitionDate: acquisitionDate
          ? toDateOnlyUTC(acquisitionDate)
          : null,
        storageLocation: normalizeString(storageLocation) || null,
        notes: notes ?? null,
        imageUrl: imageUrl ?? null,
        imageSource: imageSource ?? null,
      },
    });

    return NextResponse.json(gear, { status: 201 });
  } catch (error) {
    console.error("POST /api/gear error:", error);
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to create gear" },
      { status: 500 },
    );
  }
}
