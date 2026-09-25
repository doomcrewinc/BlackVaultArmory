import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { normalizeKitCategory } from "@/lib/kit";

export const dynamic = "force-dynamic";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/kits - List all kits, ordered by name
export async function GET() {
  try {
    const kits = await prisma.kit.findMany({
      orderBy: { name: "asc" },
    });

    return NextResponse.json(kits);
  } catch (error) {
    console.error("GET /api/kits error:", error);
    return NextResponse.json(
      { error: "Failed to fetch kits" },
      { status: 500 },
    );
  }
}

// POST /api/kits - Create a new kit
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const { name, category, location, notes, imageUrl } = body;

    const normalizedName = normalizeString(name);
    if (!normalizedName) {
      return NextResponse.json(
        { error: "Missing required field: name" },
        { status: 400 },
      );
    }

    const kit = await prisma.kit.create({
      data: {
        name: normalizedName,
        category: normalizeKitCategory(category),
        location: normalizeString(location) || null,
        notes: notes ?? null,
        imageUrl: imageUrl ?? null,
      },
    });

    return NextResponse.json(kit, { status: 201 });
  } catch (error) {
    console.error("POST /api/kits error:", error);
    return NextResponse.json(
      { error: "Failed to create kit" },
      { status: 500 },
    );
  }
}
