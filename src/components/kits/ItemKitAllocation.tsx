import Link from "next/link";
import { Backpack, TriangleAlert } from "lucide-react";
import { formatKitQuantity } from "@/lib/kits/sourceDisplay";
import type { ItemAllocation } from "@/lib/kits/itemAllocation";

/**
 * "14 of 12 assigned across kits", on the ITEM's detail page — the half of the
 * spec's allocation rule phase 6 shipped only for kits.
 *
 * NEITHER a server nor a client component on purpose: no hooks, no Prisma, no
 * clock, and its whole input is one plain object. The gear, supply and firearm
 * detail pages are server components and render it directly; the accessory
 * detail page is a client component that reads the same object off
 * `/api/accessories/[id]`, and renders THIS component, so the four pages
 * cannot drift into four phrasings of one number.
 *
 * FLAGS, NEVER BLOCKS. There is no control here — nothing to unpack, nothing
 * to clamp, no warning that gates an action. The user is told, and decides.
 *
 * Renders nothing for `allocation === null`, which is how an item in no kit
 * says nothing at all rather than "0 assigned". The caller may pass null
 * freely; the gate lives here rather than at four call sites.
 */
export function ItemKitAllocation({
  allocation,
}: {
  allocation: ItemAllocation | null;
}) {
  if (!allocation) return null;

  const { allocated, owned, overAllocated, kits } = allocation;

  // Over-allocated gets the same #E53935 treatment and the same sentence as
  // the kit line in KitContents — a user who saw "14 of 12 assigned across
  // kits" on the bag must read the identical words here, not a paraphrase.
  // Under-allocated is muted text with no box: it is information, not a
  // problem, and a bordered panel on every packed item would cry wolf.
  const headline =
    owned === null
      ? `${formatKitQuantity(allocated)} assigned across kits`
      : `${formatKitQuantity(allocated)} of ${formatKitQuantity(owned)} assigned across kits`;

  return (
    <div
      className={
        overAllocated
          ? "rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 p-3"
          : "rounded-lg border border-vault-border bg-vault-surface p-3"
      }
    >
      <p
        className={
          overAllocated
            ? "flex items-start gap-1.5 text-sm font-medium text-[#E53935]"
            : "flex items-start gap-1.5 text-sm text-vault-text-muted"
        }
      >
        {overAllocated ? (
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        ) : (
          <Backpack className="mt-0.5 h-4 w-4 shrink-0" />
        )}
        <span>{headline}</span>
      </p>

      {/* WHICH BAGS, not just how many — the question a user asks the instant
          they are told 14 of 12 are packed is "in what?". Each is a link, so
          the answer is one tap away. */}
      <ul className="mt-2 space-y-1">
        {kits.map((holding) => (
          <li
            key={holding.kitId}
            className="flex items-baseline justify-between gap-3"
          >
            {/* The name truncates ALONE; the quantity is a shrink-0 sibling.
                `truncate` plus `flex` on one element hides its children, which
                hid a quantity badge outright in this repo once. */}
            <Link
              href={`/kits/${holding.kitId}`}
              className="min-w-0 truncate text-sm text-[#00C2FF] hover:underline"
            >
              {holding.kitName}
            </Link>
            <span className="shrink-0 font-mono text-xs text-vault-text-muted">
              ×{formatKitQuantity(holding.quantity)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
