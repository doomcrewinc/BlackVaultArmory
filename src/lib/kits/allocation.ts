/**
 * allocation.ts — the packing maths for kits: how much of an item is spread
 * across every kit that holds it, over- and under-allocation, and a kit's
 * expiry rollup.
 *
 * PURE, like kitItemSource.ts: no Prisma, no clock. `kitExpiryRollup` takes
 * `today` as an argument for the same reason `expiryStatus` does — a server
 * component and a client component must resolve "today" from their own
 * clock/timezone and run the identical comparison, or a dashboard and a
 * section page will disagree about what's expired.
 */
import { expiryStatus } from "@/lib/supply";
import { KIT_ITEM_SOURCES, type KitItemSourceField } from "@/lib/kit";

/**
 * One KitItem row, as far as allocation cares. `label` is accepted (and
 * ignored — a label-only row sets none of the five foreign keys, so the
 * loop below finds nothing to key on) so a real KitItem, which always has
 * this field, can be passed through without stripping it first.
 */
export interface AllocationRow {
  gearId?: string | null;
  supplyId?: string | null;
  accessoryId?: string | null;
  ammoStockId?: string | null;
  firearmId?: string | null;
  label?: string | null;
  quantity: number;
}

/**
 * Sums `quantity` for one item across every kit that holds it, keyed by
 * SOURCE AND ID together (`"accessoryId:a1"`), never a bare id. Two
 * different tables could in principle share an id (cuids collide only
 * astronomically rarely, but the point is the key shape, not the odds); a
 * bare-id key would make that collision silent. A label-only row allocates
 * nothing and is skipped.
 */
export function allocationByItem(rows: AllocationRow[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    for (const field of KIT_ITEM_SOURCES as readonly KitItemSourceField[]) {
      const id = row[field];
      if (typeof id === "string" && id.trim() !== "") {
        const key = `${field}:${id}`;
        totals.set(key, (totals.get(key) ?? 0) + row.quantity);
        break; // a KitItem sets at most one source (see kitItemSource.ts)
      }
    }
  }
  return totals;
}

/**
 * Whether an item's total allocation across kits exceeds how many are
 * owned. `owned: null` (a label-only line, or an item with no tracked
 * quantity) is never over-allocated — there is nothing measurable to
 * exceed, and flagging it would cry wolf on every untracked item.
 *
 * This FLAGS, never blocks: nothing in this module rejects or clamps a
 * quantity. The spec's example is "14 of 12 assigned", shown, not refused.
 */
export function isOverAllocated(input: {
  allocated: number;
  owned: number | null;
}): boolean {
  if (input.owned === null) return false;
  return input.allocated > input.owned;
}

/**
 * How many more of an item are needed to reach its target. Zero when there
 * is no target, or when packed quantity already meets or exceeds it —
 * never negative.
 */
export function missingQuantity(item: {
  quantity: number;
  targetQuantity: number | null;
}): number {
  if (item.targetQuantity === null) return 0;
  const missing = item.targetQuantity - item.quantity;
  return missing > 0 ? missing : 0;
}

/** One kit line, as far as the expiry rollup cares. */
export interface KitExpiryLine {
  expirationDate: Date | null;
}

export interface KitExpiryRollup {
  /** The earliest expirationDate among the kit's dated contents, or null. */
  earliest: Date | null;
  /** Count of lines whose expiryStatus is "expired". */
  expired: number;
  /** Count of lines whose expiryStatus is "soon". */
  soon: number;
}

/**
 * Rolls a kit's contents up into one earliest-expiry date and expired/soon
 * counts. Calls `expiryStatus` from `@/lib/supply` rather than re-deriving
 * "expired" or "soon" — two implementations of that question disagreeing is
 * this epic's most expensive bug class (see supply.ts).
 *
 * `earliest` considers every dated line regardless of status, so a kit
 * whose nearest expiry is still "fine" still reports it.
 */
export function kitExpiryRollup(
  lines: KitExpiryLine[],
  today: Date,
  warningDays: number,
): KitExpiryRollup {
  let earliest: Date | null = null;
  let expired = 0;
  let soon = 0;

  for (const line of lines) {
    if (!line.expirationDate) continue;
    if (earliest === null || line.expirationDate.getTime() < earliest.getTime()) {
      earliest = line.expirationDate;
    }
    const status = expiryStatus(line.expirationDate, today, warningDays);
    if (status === "expired") expired++;
    else if (status === "soon") soon++;
  }

  return { earliest, expired, soon };
}
