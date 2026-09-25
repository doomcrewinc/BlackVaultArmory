import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  KIT_ITEM_SOURCES,
  KIT_ITEM_SOURCE_LABELS,
  type KitItemSourceField,
} from "@/lib/kit";
import { resolveKitItemSource } from "@/lib/kits/kitItemSource";
import { normalizeAmount } from "@/lib/supply";

export const dynamic = "force-dynamic";

/**
 * A Prisma foreign-key violation. Duck-typed on `code` rather than imported
 * from the Prisma namespace, the same way `isNotFoundError` reads P2025 in
 * `api/documents/[id]/route.ts` — the generated client is swapped between the
 * sqlite and postgres schemas, and both raise the same code.
 */
function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "P2003"
  );
}

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

    let item;
    try {
      item = await prisma.kitItem.create({
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
    } catch (error) {
      // A STALE SOURCE ID IS A BAD REQUEST, NOT A SERVER FAULT. The picker
      // only ever sends an id it just read, but a tab left open across a
      // delete sends one that is gone, and the FK constraint then fired into
      // the generic catch below as 500 "Failed to add kit item" — which tells
      // the user nothing and reads as an outage.
      //
      // Caught rather than pre-checked with a findUnique: an existence query
      // would be a THIRD sequential Prisma query on a POST that today makes
      // two (SQLite runs connection_limit=1 here), it would have to switch on
      // which of five tables to probe, and it would STILL lose the race
      // against a concurrent delete. The constraint is the authority; this
      // only translates its verdict.
      if (source.field && isForeignKeyViolation(error)) {
        return NextResponse.json(
          {
            error: `No ${KIT_ITEM_SOURCE_LABELS[source.field]} record exists for the id this line points at. It may have been deleted — reload and pick it again.`,
            fields: [source.field],
          },
          { status: 400 },
        );
      }
      throw error;
    }

    return NextResponse.json(item, { status: 201 });
  } catch (error) {
    console.error("POST /api/kits/[id]/items error:", error);
    return NextResponse.json(
      { error: "Failed to add kit item" },
      { status: 500 },
    );
  }
}
