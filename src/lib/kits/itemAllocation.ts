/**
 * itemAllocation.ts — the ITEM half of the spec's allocation rule.
 *
 * The spec says over-allocation is "flagged, never blocked: the item AND every
 * kit holding it show '14 of 12 assigned'". Phase 6 shipped the kit half only
 * (`getKitDetail` → `KitContents`), so a user looking at 12 magazines could not
 * see that 14 were packed, nor which bags they were in. This is the other half,
 * and it is the same maths: the sums come from `allocationByItem` and the
 * verdict from `isOverAllocated`, never re-derived here. Two implementations of
 * "how many are assigned" disagreeing is the bug class this epic paid for most.
 *
 * NOT PURE, unlike `allocation.ts` and `sourceDisplay.ts` — it owns the one
 * query. It is the only module in `src/lib/kits` that imports Prisma, which is
 * why it is separate rather than folded into `allocation.ts`: that module is
 * imported by a client component.
 *
 * ONE QUERY PER DETAIL PAGE, and no more. The kit detail page reads the WHOLE
 * KitItem table because it needs a total for each of its lines; an item page
 * needs the total for exactly one item, so it filters on that item's foreign
 * key in the database and gets back only the handful of rows that hold it. The
 * kit names come back on the same query as a join, not a second round trip —
 * SQLite here runs with `connection_limit=1`, so a second await is a second
 * serialized query, and `Promise.all` over Prisma is forbidden outright.
 */
import { prisma } from "@/lib/prisma";
import type { KitItemSourceField } from "@/lib/kit";
import { allocationByItem, allocationKey, isOverAllocated } from "./allocation";

/** One kit that holds this item, and how many of it that kit packs. */
export interface ItemKitHolding {
  kitId: string;
  kitName: string;
  quantity: number;
}

export interface ItemAllocation {
  /** The sum across every kit, from `allocationByItem`. */
  allocated: number;
  /** How many are owned, or null when the table tracks no quantity. */
  owned: number | null;
  /** From `isOverAllocated`, not a second `>` comparison. */
  overAllocated: boolean;
  /** Every kit holding it, by kit name. Never empty — see the null return. */
  kits: ItemKitHolding[];
}

/**
 * How much of one inventory item is assigned across kits, or NULL when it is
 * in no kit at all.
 *
 * Null rather than a zeroed record, because "0 assigned" is a sentence the
 * detail page must never print: almost nothing a user owns is in a kit, and a
 * line saying so on every gear, supply, accessory and firearm page would be
 * noise on the overwhelming majority of them. The callers render nothing on
 * null, which is also what makes this cheap to add to a page that has no kits
 * feature turned on in practice.
 *
 * `owned` is supplied by the CALLER, from the record it has already loaded —
 * this function does not read the item's own table, so it adds no second
 * query. Each table's honest answer differs (Gear/Supply/Accessory carry a
 * quantity; a Firearm row is one physical object, so `FIREARM_OWNED_QUANTITY`)
 * and `describeSource` in `getKitDetail` makes the same choice per kind.
 */
export async function getItemAllocation(
  field: KitItemSourceField,
  id: string,
  owned: number | null,
): Promise<ItemAllocation | null> {
  const rows = await prisma.kitItem.findMany({
    where: { [field]: id },
    // The five source columns are ALL selected even though the query already
    // filtered on one of them: `allocationByItem` resolves each row's source
    // with `allocationSourceOf`, which is first-match-wins over
    // KIT_ITEM_SOURCES. A malformed row with two keys set — the API rejects
    // one, the database does not forbid it — must be attributed the same way
    // here as on the kit page, or the two surfaces would report different
    // totals for the same item. Selecting only the filtered column would have
    // hidden that instead of matching it.
    select: {
      gearId: true,
      supplyId: true,
      accessoryId: true,
      ammoStockId: true,
      firearmId: true,
      quantity: true,
      kit: { select: { id: true, name: true } },
    },
    orderBy: { kit: { name: "asc" } },
  });

  if (rows.length === 0) return null;

  const allocated = allocationByItem(rows).get(allocationKey({ field, id })) ?? 0;

  return {
    allocated,
    owned,
    // FLAGGED, NEVER BLOCKED. This returns a boolean for a page to render; no
    // caller branches on it to refuse or clamp a write, and nothing in this
    // module writes at all.
    overAllocated: isOverAllocated({ allocated, owned }),
    kits: rows.map((row) => ({
      kitId: row.kit.id,
      kitName: row.kit.name,
      quantity: row.quantity,
    })),
  };
}
