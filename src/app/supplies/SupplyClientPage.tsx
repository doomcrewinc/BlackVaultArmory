"use client";

import Link from "next/link";
import { Plus, Boxes, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { formatNumber } from "@/lib/utils";
import {
  SUPPLY_UNIT_LABELS,
  type ExpiryStatus,
  type SupplyUnit,
} from "@/lib/supply";
import type { SupplySectionItem } from "./getSupplySectionItems";

interface Props {
  items: SupplySectionItem[];
  heading?: string;
  subheading?: string;
}

function unitLabel(unit: string): string {
  return SUPPLY_UNIT_LABELS[unit as SupplyUnit] ?? unit;
}

function quantityLabel(item: SupplySectionItem): string {
  return `${formatNumber(item.quantity)} ${unitLabel(item.unit)}`;
}

/**
 * Badges are `shrink-0` SIBLINGS of the `truncate min-w-0` name span, never
 * inside it — `truncate` plus `flex` on one element hides its siblings, and a
 * badge vanishing for a long name shipped in phase 1.
 */
function StatusBadges({ item }: { item: SupplySectionItem }) {
  return (
    <>
      {item.isLow && (
        <span className="shrink-0 text-[10px] font-mono text-[#F5A623] bg-[#F5A623]/10 border border-[#F5A623]/20 px-1.5 py-0.5 rounded">
          LOW
        </span>
      )}
      {item.expiry === "expired" && (
        <span className="shrink-0 text-[10px] font-mono text-[#E53935] bg-[#E53935]/10 border border-[#E53935]/20 px-1.5 py-0.5 rounded">
          EXPIRED
        </span>
      )}
      {item.expiry === "soon" && (
        <span className="shrink-0 text-[10px] font-mono text-[#F5A623] bg-[#F5A623]/10 border border-[#F5A623]/20 px-1.5 py-0.5 rounded">
          SOON
        </span>
      )}
    </>
  );
}

function hasBadges(expiry: ExpiryStatus, isLow: boolean): boolean {
  return isLow || expiry === "expired" || expiry === "soon";
}

export function SupplyClientPage({
  items,
  heading = "SUPPLIES",
  subheading,
}: Props) {
  return (
    <div className="min-h-full">
      <PageHeader
        title={heading}
        subtitle={
          subheading ?? `${items.length} item${items.length !== 1 ? "s" : ""}`
        }
        actions={
          <Link
            href="/supplies/new"
            className="flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-3 py-1.5 rounded text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Supply
          </Link>
        }
      />

      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-full bg-[#00C2FF]/10 border border-[#00C2FF]/20 flex items-center justify-center mb-4">
              <Boxes className="w-8 h-8 text-[#00C2FF]" />
            </div>
            <h3 className="text-lg font-semibold text-vault-text mb-2">
              No supplies yet
            </h3>
            <p className="text-sm text-vault-text-muted mb-6 max-w-sm">
              Track consumables here — quantity, low-stock alerts and expiry
              dates.
            </p>
            <Link
              href="/supplies/new"
              className="flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-4 py-2 rounded text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add First Supply
            </Link>
          </div>
        ) : (
          <>
            {/* Mobile card list */}
            <div className="space-y-3 md:hidden">
              {items.map((item) => (
                <div
                  key={item.id}
                  className="rounded-lg border border-vault-border bg-vault-surface p-3"
                >
                  <div className="flex items-start gap-3">
                    <Link
                      href={`/supplies/item/${item.id}`}
                      className="w-11 h-11 rounded bg-vault-bg border border-vault-border overflow-hidden flex items-center justify-center shrink-0"
                    >
                      <Boxes className="w-4 h-4 text-vault-text-faint" />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/supplies/item/${item.id}`}
                        className="min-w-0"
                      >
                        <p className="font-semibold text-vault-text flex items-center gap-2">
                          <span className="truncate min-w-0">{item.name}</span>
                          {hasBadges(item.expiry, item.isLow) && (
                            <span className="flex shrink-0 items-center gap-1">
                              <StatusBadges item={item} />
                            </span>
                          )}
                        </p>
                      </Link>
                      <p className="text-xs text-vault-text-faint truncate">
                        {item.brand ?? "—"} · {quantityLabel(item)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-vault-text-muted truncate">
                          {item.storageLocation ?? "—"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block bg-vault-surface border border-vault-border rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-vault-border">
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium">
                        Name
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium hidden lg:table-cell">
                        Brand
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium">
                        Quantity
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium hidden md:table-cell">
                        Storage
                      </th>
                      <th className="px-4 py-3 w-20" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-vault-border">
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className="hover:bg-vault-surface-2 transition-colors group"
                      >
                        {/* Name */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/supplies/item/${item.id}`}
                            className="block"
                          >
                            <p className="font-semibold text-vault-text group-hover:text-[#00C2FF] transition-colors max-w-[220px] flex items-center gap-1.5">
                              <span className="truncate min-w-0">
                                {item.name}
                              </span>
                              {hasBadges(item.expiry, item.isLow) && (
                                <span className="flex shrink-0 items-center gap-1">
                                  <StatusBadges item={item} />
                                </span>
                              )}
                              <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 shrink-0" />
                            </p>
                          </Link>
                        </td>

                        {/* Brand */}
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <p className="text-sm text-vault-text-muted truncate max-w-[140px]">
                            {item.brand ?? "—"}
                          </p>
                        </td>

                        {/* Quantity */}
                        <td className="px-4 py-3">
                          <p className="text-sm font-mono text-vault-text-muted whitespace-nowrap">
                            {quantityLabel(item)}
                          </p>
                        </td>

                        {/* Storage */}
                        <td className="px-4 py-3 hidden md:table-cell">
                          <p className="text-sm text-vault-text-muted truncate max-w-[160px]">
                            {item.storageLocation ?? "—"}
                          </p>
                        </td>

                        {/* View */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/supplies/item/${item.id}`}
                            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-vault-border text-vault-text-muted hover:border-[#00C2FF]/50 hover:text-[#00C2FF] transition-colors whitespace-nowrap"
                          >
                            View
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
