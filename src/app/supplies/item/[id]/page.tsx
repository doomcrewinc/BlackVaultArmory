export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  SUPPLY_CATEGORY_LABELS,
  SUPPLY_UNIT_LABELS,
  expiryStatus,
  isLowStock,
  resolveExpiryContext,
  type SupplyCategory,
  type SupplyUnit,
} from "@/lib/supply";
import { supplySectionForItem } from "@/lib/categories";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { SupplyTimezoneNotice } from "@/components/supplies/SupplyTimezoneNotice";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { DeleteSupplyButton } from "./DeleteSupplyButton";
import { ArrowLeft, Pencil, DollarSign, Calendar, MapPin } from "lucide-react";

// Single-record read: today and the expiry window are resolved once from
// AppSettings via todayForExpiry, the same boundary getSupplySectionItems
// uses for list pages — never a raw `new Date()`.
async function getSupplyWithExpiry(id: string) {
  const supply = await prisma.supply.findUnique({ where: { id } });
  if (!supply) return null;

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const { today, warningDays, timezoneFromSetting } = resolveExpiryContext(
    settings,
    new Date(),
  );

  return {
    supply,
    isLow: isLowStock(supply),
    expiry: expiryStatus(supply.expirationDate, today, warningDays),
    // Same read AND the same resolution, handed on: this page renders Expired
    // / Expiring Soon badges too, so it carries the same notice as the list
    // pages and the dashboard. Taken off resolveExpiryContext rather than
    // recomputed as Boolean(settings.timezone), which claims "configured" for
    // a set-but-unrecognised zone that was actually evaluated in UTC.
    timezoneConfigured: timezoneFromSetting,
  };
}

function categoryLabel(category: string): string {
  return SUPPLY_CATEGORY_LABELS[category as SupplyCategory] ?? category;
}

function unitLabel(unit: string): string {
  return SUPPLY_UNIT_LABELS[unit as SupplyUnit] ?? unit;
}

export default async function SupplyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let result: Awaited<ReturnType<typeof getSupplyWithExpiry>>;
  try {
    result = await getSupplyWithExpiry(id);
  } catch {
    return <SectionLoadError label="item" href={`/supplies/item/${id}`} />;
  }

  if (!result) {
    notFound();
  }

  const { supply, isLow, expiry, timezoneConfigured } = result;
  const section = supplySectionForItem({ category: supply.category });
  const backHref = section
    ? `/${section.group === "prep" ? "prep" : "gear"}/${section.slug}`
    : "/";
  const backLabel = section ? section.label : "Home";

  return (
    <div className="min-h-full">
      {/* Breadcrumb header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4 px-4 sm:px-6 py-4 border-b border-vault-border">
        <Link
          href={backHref}
          className="flex items-center gap-1.5 text-vault-text-muted hover:text-vault-text text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to {backLabel}
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/supplies/item/${supply.id}/edit`}
            className="flex items-center gap-1.5 text-sm bg-vault-surface border border-vault-border text-vault-text-muted hover:text-vault-text px-3 py-1.5 rounded-md transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </Link>
          <DeleteSupplyButton id={supply.id} redirectTo={backHref} />
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        <SupplyTimezoneNotice timezoneConfigured={timezoneConfigured} />

        {/* Title block */}
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-muted font-mono uppercase">
              {categoryLabel(supply.category)}
            </span>
            {isLow && (
              <span className="text-xs px-2 py-0.5 rounded border border-[#F5A623]/30 bg-[#F5A623]/10 text-[#F5A623] font-mono uppercase">
                Low Stock
              </span>
            )}
            {expiry === "expired" && (
              <span className="text-xs px-2 py-0.5 rounded border border-[#E53935]/30 bg-[#E53935]/10 text-[#E53935] font-mono uppercase">
                Expired
              </span>
            )}
            {expiry === "soon" && (
              <span className="text-xs px-2 py-0.5 rounded border border-[#F5A623]/30 bg-[#F5A623]/10 text-[#F5A623] font-mono uppercase">
                Expiring Soon
              </span>
            )}
          </div>
          <h1 className="text-xl font-bold text-vault-text">{supply.name}</h1>
          {supply.brand && (
            <p className="text-sm text-vault-text-muted">{supply.brand}</p>
          )}
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Quantity
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {formatNumber(supply.quantity)} {unitLabel(supply.unit)}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Low Stock Threshold
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {supply.lowStockAlert != null
                ? `${formatNumber(supply.lowStockAlert)} ${unitLabel(supply.unit)}`
                : "—"}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Expires
              </p>
            </div>
            <p className="text-sm text-vault-text">
              {formatDateOnly(supply.expirationDate)}
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
              {supply.storageLocation ?? "—"}
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
              {formatCurrency(supply.purchasePrice)}
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
              {formatDateOnly(supply.purchaseDate)}
            </p>
          </div>
        </div>

        {/* Notes */}
        {supply.notes && (
          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted mb-2">
              Notes
            </h3>
            <p className="text-sm text-vault-text leading-relaxed whitespace-pre-wrap">
              {supply.notes}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
