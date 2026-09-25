import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { KIT_ITEM_SOURCES, type KitItemSourceField } from "@/lib/kit";
import {
  resolveKitItemSource,
  type KitItemSourceInput,
} from "@/lib/kits/kitItemSource";
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

/**
 * The merge-then-normalize rule: `resolveKitItemSource` runs over what the
 * client sent LAYERED ON what is stored, never the body alone. A PUT that
 * sets `supplyId` on a line that already holds `gearId` sends only
 * `{ supplyId: "s1" }` — the body by itself looks like a valid single-source
 * update. Only once it is merged with the stored `gearId` does the conflict
 * become visible. This mirrors `normalizeGearArmorFields` in `src/lib/gear.ts`.
 *
 * A key ABSENT from the body keeps the stored value; a key present (even as
 * `null` or `""`) overrides it — same "undefined vs. present" rule as every
 * other PUT handler in this codebase.
 */
function mergedSource(
  existing: KitItemSourceInput,
  body: Record<string, unknown>,
): KitItemSourceInput {
  const merged = {} as KitItemSourceInput;
  for (const field of KIT_ITEM_SOURCES) {
    merged[field] = field in body && body[field] !== undefined ? body[field] : existing[field];
  }
  merged.label = "label" in body && body.label !== undefined ? body.label : existing.label;
  return merged;
}

// PUT /api/kits/[id]/items/[itemId] - Update a kit line
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { itemId } = await params;
    const body = await request.json();

    const existing = await prisma.kitItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      return NextResponse.json({ error: "Kit item not found" }, { status: 404 });
    }

    const source = resolveKitItemSource(mergedSource(existing, body));
    if (!source.ok) {
      return NextResponse.json(
        { error: source.reason, fields: source.fields },
        { status: 400 },
      );
    }

    const { quantity, targetQuantity, notes } = body;

    const updated = await prisma.kitItem.update({
      where: { id: itemId },
      data: {
        ...sourceColumns(source),
        label: source.label,
        // quantity is NOT NULL DEFAULT 1 — an emptied number input posts
        // "", which must preserve the stored value rather than resetting to
        // 1, and an explicit null is treated like an absent key, matching
        // gear/supply quantity.
        ...(quantity !== undefined &&
          quantity !== null && {
            quantity: normalizeAmount(quantity, existing.quantity) ?? existing.quantity,
          }),
        // targetQuantity is nullable and CAN be intentionally cleared: an
        // explicit null clears it, and only an absent key leaves it alone.
        ...(targetQuantity !== undefined && {
          targetQuantity:
            targetQuantity === null
              ? null
              : normalizeAmount(targetQuantity, existing.targetQuantity),
        }),
        ...(notes !== undefined && { notes }),
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT /api/kits/[id]/items/[itemId] error:", error);
    return NextResponse.json(
      { error: "Failed to update kit item" },
      { status: 500 },
    );
  }
}

// DELETE /api/kits/[id]/items/[itemId] - Remove one line from a kit
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { itemId } = await params;

    const existing = await prisma.kitItem.findUnique({ where: { id: itemId } });
    if (!existing) {
      return NextResponse.json({ error: "Kit item not found" }, { status: 404 });
    }

    await prisma.kitItem.delete({ where: { id: itemId } });

    return NextResponse.json({ success: true, id: itemId });
  } catch (error) {
    console.error("DELETE /api/kits/[id]/items/[itemId] error:", error);
    return NextResponse.json(
      { error: "Failed to delete kit item" },
      { status: 500 },
    );
  }
}
