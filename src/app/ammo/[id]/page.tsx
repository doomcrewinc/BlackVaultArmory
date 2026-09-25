export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatCurrency, formatNumber, stockStatus } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { ItemKitAllocation } from "@/components/kits/ItemKitAllocation";
import { getItemAllocation } from "@/lib/kits/itemAllocation";
import { AmmoTransactionList } from "@/components/ammo/AmmoTransactionList";
import { DeleteAmmoButton } from "./DeleteAmmoButton";
import { ArrowLeft, Pencil, DollarSign, Calendar, MapPin } from "lucide-react";

/**
 * The ammo lot detail page — the fifth and last inventory kind to get one.
 *
 * Its reason for existing is the spec's allocation rule: "the item AND every
 * kit holding it show '14 of 12 assigned'". Phase 6 shipped the kit half, the
 * item half landed on gear, supplies, accessories and firearms, and ammo was
 * missed for one reason only — there was no page to render it on. There is now.
 *
 * NO ItemDocumentPanel: the Document model carries firearmId, accessoryId and
 * gearId and nothing for ammo (prisma/schema.base.prisma:238-260), so a
 * document panel here would be a permanently empty box.
 *
 * THREE QUERIES, sequential, never Promise.all — SQLite here runs with
 * connection_limit=1, so a parallel await is a serialized query with a worse
 * failure mode:
 *   1. the lot itself
 *   2. its last ten ledger rows
 *   3. getItemAllocation — the kit rows for this lot, kit names joined
 * No AppSettings read, unlike the gear and supply pages: ammo has no
 * expiration date, so there is no expiry boundary to resolve and no timezone
 * notice to carry.
 */

const TRANSACTION_LIMIT = 10;

async function getAmmoDetail(id: string) {
  const stock = await prisma.ammoStock.findUnique({ where: { id } });
  if (!stock) return null;

  const transactions = await prisma.ammoTransaction.findMany({
    where: { stockId: id },
    orderBy: { transactedAt: "desc" },
    take: TRANSACTION_LIMIT,
  });

  // `owned` is stock.quantity from the record already in hand, so this adds no
  // second read of the ammo table. Null when the lot is in no kit, which is
  // the usual case and renders nothing at all.
  const allocation = await getItemAllocation(
    "ammoStockId",
    stock.id,
    stock.quantity,
  );

  return { stock, transactions, allocation };
}

const STATUS_BADGES: Record<string, { label: string; className: string }> = {
  low: {
    label: "Low Stock",
    className:
      "border-[#F5A623]/30 bg-[#F5A623]/10 text-[#F5A623]",
  },
  critical: {
    label: "Critical",
    className:
      "border-[#E53935]/30 bg-[#E53935]/10 text-[#E53935]",
  },
  empty: {
    label: "Out of Stock",
    className:
      "border-[#E53935]/30 bg-[#E53935]/10 text-[#E53935]",
  },
};

export default async function AmmoDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let result: Awaited<ReturnType<typeof getAmmoDetail>>;
  try {
    result = await getAmmoDetail(id);
  } catch {
    // The one retry component, pointed at this page's own path — same branch
    // as the gear and supply detail pages.
    return <SectionLoadError label="ammo lot" href={`/ammo/${id}`} />;
  }

  if (!result) {
    notFound();
  }

  const { stock, transactions, allocation } = result;
  const status = stockStatus(stock.quantity, stock.lowStockAlert);
  const statusBadge = STATUS_BADGES[status];

  return (
    <div className="min-h-full">
      {/* Breadcrumb header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4 px-4 sm:px-6 py-4 border-b border-vault-border">
        <Link
          href="/ammo"
          className="flex items-center gap-1.5 text-vault-text-muted hover:text-vault-text text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Ammunition
        </Link>
        <div className="flex items-center gap-2">
          {/* Ammo editing lives in a modal on the list page — there is no
              /ammo/[id]/edit route, and inventing a second edit form for one
              link is how two forms drift apart. `?edit=` opens that existing
              modal on this lot. */}
          <Link
            href={`/ammo?edit=${stock.id}`}
            className="flex items-center gap-1.5 text-sm bg-vault-surface border border-vault-border text-vault-text-muted hover:text-vault-text px-3 py-1.5 rounded-md transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </Link>
          <DeleteAmmoButton id={stock.id} redirectTo="/ammo" />
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        {/* Title block. Every badge is a shrink-0 sibling in the wrapping row
            ABOVE the name; the name is its own element below it. A badge put
            inside a `truncate` element has disappeared outright here before. */}
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="shrink-0 text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-muted font-mono uppercase">
              {stock.caliber}
            </span>
            {stock.bulletType && (
              <span className="shrink-0 text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-faint font-mono uppercase">
                {stock.bulletType}
              </span>
            )}
            {stock.grainWeight != null && (
              <span className="shrink-0 text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-faint font-mono">
                {stock.grainWeight}gr
              </span>
            )}
            {statusBadge && (
              <span
                className={`shrink-0 text-xs px-2 py-0.5 rounded border font-mono uppercase ${statusBadge.className}`}
              >
                {statusBadge.label}
              </span>
            )}
          </div>
          {/* The lot's name is its brand, exactly as the list page's rows
              title themselves. The caliber is the badge above, not repeated
              here as a subtitle. */}
          <h1 className="text-xl font-bold text-vault-text break-words">
            {stock.brand}
          </h1>
        </div>

        {/* Directly under the title, ABOVE the stats — the same placement and
            the same component as the gear, supply, accessory and firearm
            pages, so one over-allocation reads identically on all five.
            Renders nothing when this lot is in no kit. */}
        <ItemKitAllocation allocation={allocation} />

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                On Hand
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {formatNumber(stock.quantity)} rds
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Low Stock Alert
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {stock.lowStockAlert != null
                ? `${formatNumber(stock.lowStockAlert)} rds`
                : "—"}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Purchase Price
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {formatCurrency(stock.purchasePrice)}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Price / Round
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {formatCurrency(stock.pricePerRound)}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Purchased
              </p>
            </div>
            <p className="text-sm text-vault-text">
              {formatDateOnly(stock.purchaseDate)}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <MapPin className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Storage
              </p>
            </div>
            <p className="text-sm text-vault-text">
              {stock.storageLocation ?? "—"}
            </p>
          </div>
        </div>

        {/* Notes */}
        {stock.notes && (
          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted mb-2">
              Notes
            </h3>
            <p className="text-sm text-vault-text leading-relaxed whitespace-pre-wrap">
              {stock.notes}
            </p>
          </div>
        )}

        <AmmoTransactionList transactions={transactions} />
      </div>
    </div>
  );
}
