import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { KIT_ITEM_SOURCES, type KitItemSourceField } from "@/lib/kit";
import { resolveKitItemSource } from "@/lib/kits/kitItemSource";
import { normalizeAmount } from "@/lib/supply";

export const dynamic = "force-dynamic";

/**
 * Turns a resolved source (`field`/`id` from `resolveKitItemSource`) into
 * the five-column write: the chosen field gets the id, every other source
 * column is explicitly null. Explicit, not partial — a stale FK from a
 * previous source must never survive an update that switches sources.
 */
function sourceColumns(
  result: { field: KitItemSourceField | null; id: string | null },
): Record<KitItemSourceField, string | null> {
  const columns = {} as Record<KitItemSourceField, string | null>;
  for (const field of KIT_ITEM_SOURCES) {
    columns[field] = field === result.field ? result.id : null;
  }
  return columns;
}

// POST /api/kits/[id]/items - Add a line to a kit
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: kitId } = await params;
    const body = await request.json();

    const kit = await prisma.kit.findUnique({ where: { id: kitId } });
    if (!kit) {
      return NextResponse.json({ error: "Kit not found" }, { status: 404 });
    }

    const source = resolveKitItemSource(body);
    if (!source.ok) {
      return NextResponse.json(
        { error: source.reason, fields: source.fields },
        { status: 400 },
      );
    }

    const { quantity, targetQuantity, notes } = body;

    const item = await prisma.kitItem.create({
      data: {
        kitId,
        ...sourceColumns(source),
        label: source.label,
        // quantity is NOT NULL DEFAULT 1 — there is no stored value yet, so
        // a missing/blank/malformed amount falls back to the schema default
        // rather than preserving anything.
        quantity: normalizeAmount(quantity, 1) ?? 1,
        // targetQuantity is nullable: absent or blank simply means "no
        // target set", not "reset to some default".
        targetQuantity: normalizeAmount(targetQuantity),
        notes: notes ?? null,
      },
    });

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error("POST /api/kits/[id]/items error:", error);
    return NextResponse.json(
      { error: "Failed to add kit item" },
      { status: 500 },
    );
  }
}
