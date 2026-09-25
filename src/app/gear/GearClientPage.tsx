"use client";

import Link from "next/link";
import { Plus, Package, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { formatCurrency } from "@/lib/utils";
import { GEAR_CATEGORY_LABELS, type GearCategory } from "@/lib/gear";
import type { ExpiryStatus } from "@/lib/supply";

interface GearItem {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  category: string;
  quantity: number;
  purchasePrice: number | null;
  imageUrl: string | null;
  /**
   * Resolved server-side via todayForExpiry + expiryStatus — this is a
   * client component and must not compute "today" itself (server and
   * browser timezones can disagree, and a client-computed value would not
   * match the badge the detail page shows for the same item).
   */
  expiry: ExpiryStatus;
}

interface Props {
  items: GearItem[];
  heading?: string;
  subheading?: string;
}

function categoryLabel(category: string): string {
  return GEAR_CATEGORY_LABELS[category as GearCategory] ?? category;
}

/**
 * `shrink-0`, and a SIBLING of the truncating name element rather than a
 * descendant: `truncate` plus `flex` on one element hides its siblings — a
 * `×N` quantity badge vanishing for a long name shipped once already (see
 * SupplyClientPage's StatusBadges). This badge must follow the same rule.
 */
function ExpiryBadge({ expiry }: { expiry: ExpiryStatus }) {
  if (expiry === "expired") {
    return (
      <span className="shrink-0 text-[10px] font-mono text-[#E53935] bg-[#E53935]/10 border border-[#E53935]/20 px-1.5 py-0.5 rounded">
        EXPIRED
      </span>
    );
  }
  if (expiry === "soon") {
    return (
      <span className="shrink-0 text-[10px] font-mono text-[#FFB300] bg-[#FFB300]/10 border border-[#FFB300]/20 px-1.5 py-0.5 rounded">
        SOON
      </span>
    );
  }
  return null;
}

export function GearClientPage({ items, heading = "GEAR", subheading }: Props) {
  return (
    <div className="min-h-full">
      <PageHeader
        title={heading}
        subtitle={
          subheading ?? `${items.length} item${items.length !== 1 ? "s" : ""}`
        }
        actions={
          <Link
            href="/gear/new"
            className="flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-3 py-1.5 rounded text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add Gear
          </Link>
        }
      />

      <div className="p-4 sm:p-6">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="w-16 h-16 rounded-full bg-[#00C2FF]/10 border border-[#00C2FF]/20 flex items-center justify-center mb-4">
              <Package className="w-8 h-8 text-[#00C2FF]" />
            </div>
            <h3 className="text-lg font-semibold text-vault-text mb-2">
              No gear yet
            </h3>
            <p className="text-sm text-vault-text-muted mb-6 max-w-sm">
              Add knives, cases and other standalone kit to track what you own.
            </p>
            <Link
              href="/gear/new"
              className="flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 px-4 py-2 rounded text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add First Item
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
                      href={`/gear/item/${item.id}`}
                      className="w-11 h-11 rounded bg-vault-bg border border-vault-border overflow-hidden flex items-center justify-center shrink-0"
                    >
                      {item.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={item.imageUrl}
                          alt={item.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Package className="w-4 h-4 text-vault-text-faint" />
                      )}
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link href={`/gear/item/${item.id}`} className="min-w-0">
                        <p className="font-semibold text-vault-text flex items-center gap-2">
                          <span className="truncate min-w-0">{item.name}</span>
                          {item.quantity > 1 && (
                            <span className="shrink-0 rounded border border-vault-border px-1.5 py-0.5 text-[11px] text-vault-text-muted">
                              ×{item.quantity}
                            </span>
                          )}
                          <ExpiryBadge expiry={item.expiry} />
                        </p>
                      </Link>
                      <p className="text-xs text-vault-text-faint truncate">
                        {categoryLabel(item.category)}
                        {item.manufacturer ? ` · ${item.manufacturer}` : ""}
                        {item.model ? ` ${item.model}` : ""}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {item.serialNumber && (
                          <span className="text-xs font-mono text-vault-text-muted truncate">
                            SN {item.serialNumber}
                          </span>
                        )}
                        <span className="text-xs font-mono text-vault-text-muted">
                          {formatCurrency(item.purchasePrice)}
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
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium w-12">
                        Img
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium">
                        Name
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium hidden md:table-cell">
                        Category
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium hidden lg:table-cell">
                        Manufacturer
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium hidden xl:table-cell">
                        Serial
                      </th>
                      <th className="text-left px-4 py-3 text-[10px] uppercase tracking-widest text-vault-text-faint font-medium hidden lg:table-cell">
                        Price
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
                        {/* Thumbnail */}
                        <td className="px-4 py-3">
                          <div className="w-9 h-9 rounded bg-vault-bg border border-vault-border overflow-hidden flex items-center justify-center shrink-0">
                            {item.imageUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={item.imageUrl}
                                alt={item.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <Package className="w-4 h-4 text-vault-text-faint" />
                            )}
                          </div>
                        </td>

                        {/* Name */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/gear/item/${item.id}`}
                            className="block"
                          >
                            <p className="font-semibold text-vault-text group-hover:text-[#00C2FF] transition-colors max-w-[180px] flex items-center gap-1">
                              <span className="truncate min-w-0">
                                {item.name}
                              </span>
                              {item.quantity > 1 && (
                                <span className="shrink-0 rounded border border-vault-border px-1.5 py-0.5 text-[11px] text-vault-text-muted">
                                  ×{item.quantity}
                                </span>
                              )}
                              <ExpiryBadge expiry={item.expiry} />
                              <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 shrink-0" />
                            </p>
                            {item.model && (
                              <p className="text-xs text-vault-text-faint truncate max-w-[180px]">
                                {item.model}
                              </p>
                            )}
                          </Link>
                        </td>

                        {/* Category */}
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className="text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-muted font-mono uppercase">
                            {categoryLabel(item.category)}
                          </span>
                        </td>

                        {/* Manufacturer */}
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <p className="text-sm text-vault-text-muted truncate max-w-[120px]">
                            {item.manufacturer ?? "—"}
                          </p>
                        </td>

                        {/* Serial */}
                        <td className="px-4 py-3 hidden xl:table-cell">
                          <p className="text-xs text-vault-text-faint truncate max-w-[140px] font-mono">
                            {item.serialNumber ?? "—"}
                          </p>
                        </td>

                        {/* Price */}
                        <td className="px-4 py-3 hidden lg:table-cell">
                          <p className="text-sm font-mono text-vault-text-muted">
                            {formatCurrency(item.purchasePrice)}
                          </p>
                        </td>

                        {/* View */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/gear/item/${item.id}`}
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
