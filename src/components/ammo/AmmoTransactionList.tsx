import { formatNumber } from "@/lib/utils";
import { formatTimestamp } from "@/lib/date";

/**
 * The ammo lot's ledger, on its detail page.
 *
 * PURE and presentational on purpose — no hooks, no Prisma, no clock. Its
 * whole input is the rows the server component already read, which is what
 * makes it testable in jsdom without a database (see the sibling test) and
 * what keeps the detail page a server component.
 *
 * The rows come from `AmmoTransaction`, which is the ONE ledger for a lot:
 * "Add Rounds" and "Log Use" on the list page write it via
 * `POST /api/ammo/[id]/transactions`, and finalising a range session writes a
 * RANGE_USE row via `/api/range/sessions/[id]/finalize`. That is why this page
 * shows no separate range-session panel — a finalised session is already a row
 * here, and an unfinalised one has not moved any rounds yet.
 */

export interface AmmoTransactionRow {
  id: string;
  type: string;
  quantity: number;
  previousQty: number;
  newQty: number;
  note: string | null;
  transactedAt: Date | string;
}

const TYPE_LABELS: Record<string, string> = {
  PURCHASE: "Purchase",
  RANGE_USE: "Range Use",
  TRANSFER_OUT: "Transfer Out",
  INVENTORY_CORRECTION: "Correction",
  EXPENDED: "Expended",
};

const ADDS = new Set(["PURCHASE"]);
const SUBTRACTS = new Set(["RANGE_USE", "TRANSFER_OUT", "EXPENDED"]);

function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/**
 * The signed movement, derived from the SAME type sets the transactions API
 * applies when it writes the row — never re-derived from `newQty - previousQty`,
 * which would silently disagree with the ledger for a correction that happened
 * to leave the count unchanged.
 */
function movement(row: AmmoTransactionRow): { text: string; className: string } {
  if (ADDS.has(row.type)) {
    return {
      text: `+${formatNumber(row.quantity)}`,
      className: "text-[#00C853]",
    };
  }
  if (SUBTRACTS.has(row.type)) {
    return {
      text: `−${formatNumber(row.quantity)}`,
      className: "text-[#F5A623]",
    };
  }
  // INVENTORY_CORRECTION and anything unrecognised: state the resulting count
  // rather than invent a direction for it.
  return {
    text: `= ${formatNumber(row.newQty)}`,
    className: "text-vault-text-muted",
  };
}

export function AmmoTransactionList({
  transactions,
}: {
  transactions: AmmoTransactionRow[];
}) {
  return (
    <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted mb-3">
        Recent Activity
      </h3>

      {transactions.length === 0 ? (
        <p className="text-sm text-vault-text-muted">
          No transactions logged for this lot.
        </p>
      ) : (
        <ul className="divide-y divide-vault-border">
          {transactions.map((row) => {
            const move = movement(row);
            return (
              <li
                key={row.id}
                className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0"
              >
                {/* The label and note truncate ALONE inside this min-w-0
                    column; the movement and running count are a shrink-0
                    sibling outside it. `truncate` plus `flex` on one element
                    has hidden a badge outright in this repo before. */}
                <div className="min-w-0">
                  <p className="truncate text-sm text-vault-text">
                    {typeLabel(row.type)}
                  </p>
                  <p className="truncate text-xs text-vault-text-faint">
                    {formatTimestamp(row.transactedAt)}
                    {row.note ? ` · ${row.note}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className={`font-mono text-sm ${move.className}`}>
                    {move.text}
                  </p>
                  <p className="font-mono text-[10px] text-vault-text-faint">
                    {formatNumber(row.previousQty)} → {formatNumber(row.newQty)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
