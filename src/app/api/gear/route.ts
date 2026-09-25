import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { normalizeGearArmorFields, normalizeGearCategory } from "@/lib/gear";
import { normalizeMoney } from "@/lib/money";
import { normalizeQuantity } from "@/lib/quantity";
import { gearWhereForSection, sectionBySlug } from "@/lib/categories";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/gear - List all gear, optionally filtered by category section
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sectionSlug = normalizeString(searchParams.get("section"));

    let where: object | undefined;

    if (sectionSlug) {
      const section = sectionBySlug(sectionSlug);
      if (section) {
        const gearWhere = gearWhereForSection(section);
        // A slug already registered but with no gear source (e.g. "optics")
        // holds no gear — return early rather than querying with no filter,
        // which would return every gear item instead of none.
        if (!gearWhere) return NextResponse.json([]);
        where = gearWhere;
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
      expirationDate,
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
        purchasePrice: normalizeMoney(purchasePrice),
        currentValue: normalizeMoney(currentValue),
        acquisitionDate: acquisitionDate
          ? toDateOnlyUTC(acquisitionDate)
          : null,
        expirationDate: expirationDate ? toDateOnlyUTC(expirationDate) : null,
        ...normalizeGearArmorFields({
          existing: { category: "", protectionLevel: null, armorSize: null },
          body,
        }),
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
