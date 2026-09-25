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

/**
 * THE LINE MUST BELONG TO THE KIT IN THE PATH.
 *
 * `findUnique({ where: { id: itemId } })` alone answered for ANY line in the
 * database, whichever kit the `[id]` segment named. `DELETE
 * /api/kits/<some-other-kit>/items/<itemId>` therefore deleted a line out of a
 * different bag and returned `{ success: true }` — the caller was told it had
 * emptied a slot in the kit it asked about, and the kit that actually lost a
 * line was never mentioned. A stale kit id in a tab left open across a kit
 * delete-and-recreate is enough to produce it.
 *
 * Not a privilege boundary — this is a single-user, self-hosted app — but the
 * route path ASSERTS a parent-child relation, and a path that asserts a
 * relation it does not check is a lie the client cannot detect. The sibling
 * POST in `../route.ts` already resolves and 404s the parent kit, so this
 * closes an inconsistency inside one feature rather than inventing a rule.
 *
 * 404, not 403: as far as this URL is concerned the line does not exist, which
 * is the same answer a genuinely missing id gets, and the same shape. The two
 * cases are deliberately INDISTINGUISHABLE to the caller — "no such line here"
 * is the whole truth either way.
 *
 * A type guard, so one call both rejects the mismatch and narrows `existing`
 * away from null for the PUT below; two conditions would let a later edit drop
 * the kit check while TypeScript stayed happy.
 */
function belongsToKit<T extends { kitId: string }>(
  existing: T | null,
  kitId: string,
): existing is T {
  return existing !== null && existing.kitId === kitId;
}

// PUT /api/kits/[id]/items/[itemId] - Update a kit line
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; itemId: string }> },
) {
  try {
    const { id: kitId, itemId } = await params;
    const body = await request.json();

    const existing = await prisma.kitItem.findUnique({ where: { id: itemId } });
    if (!belongsToKit(existing, kitId)) {
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
    const { id: kitId, itemId } = await params;

    const existing = await prisma.kitItem.findUnique({ where: { id: itemId } });
    if (!belongsToKit(existing, kitId)) {
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
