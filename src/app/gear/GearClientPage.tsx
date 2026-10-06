"use client";

import Link from "next/link";
import { Package, ExternalLink } from "lucide-react";
import { SectionEmptyState } from "@/components/sections/SectionEmptyState";
import { SectionListHeader } from "@/components/sections/SectionListHeader";
import { SupplyTimezoneNotice } from "@/components/supplies/SupplyTimezoneNotice";
import { formatCurrency } from "@/lib/utils";
import { GEAR_CATEGORY_LABELS, type GearCategory } from "@/lib/gear";
import type { ExpiryStatus } from "@/lib/supply";
import { DEFAULT_LIST_WORDING, type ListWording } from "@/lib/sections/wording";

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
  /**
   * From the server, via loadSectionItems. REQUIRED, with no default, exactly
   * as on SupplyClientPage: an optional prop defaulting to `true` is
   * fail-open, so a new surface that renders expiry badges and forgets to
   * pass it would lose the notice silently — a guard that looks present and
   * does nothing. tsc cannot catch that through a default.
   */
  timezoneConfigured: boolean;
  heading?: string;
  subheading?: string;
  /**
   * The words for this list's rows. Defaults to the generic wording of the
   * standalone page; a section page passes its own.
   */
  wording?: ListWording;
  /**
   * True when this list is one block of a multi-source section page (see
   * SectionView). The page owns the `h1`, so the block gets the lighter
   * SectionBlockHeader instead of a second PageHeader.
   */
  embedded?: boolean;
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
      <span className="shrink-0 text-[10px] font-mono text-[#F5A623] bg-[#F5A623]/10 border border-[#F5A623]/20 px-1.5 py-0.5 rounded">
        SOON
      </span>
    );
  }
  return null;
}

export function GearClientPage({
  items,
  timezoneConfigured,
  heading = "GEAR",
  subheading,
  wording = DEFAULT_LIST_WORDING.gear,
  embedded = false,
}: Props) {
  // The SAME rule KitSectionList/KitContents use: show the notice only where
  // an expiry badge actually appears, not merely because the list is
  // non-empty — a list of items carrying no expiration date at all has
  // nothing for the notice to qualify.
  const hasExpiryBadges = items.some(
    (item) => item.expiry === "expired" || item.expiry === "soon",
  );

  return (
    <div className={embedded ? undefined : "min-h-full"}>
      <SectionListHeader
        heading={heading}
        subtitle={
          subheading ?? `${items.length} item${items.length !== 1 ? "s" : ""}`
        }
        wording={wording}
        embedded={embedded}
      />

      <div className="p-4 sm:p-6">
        {/* Only where the badges it explains actually appear: the empty state
            below renders no SOON/EXPIRED badge, so there is nothing for the
            notice to qualify. Skipped entirely when embedded — SectionView
            renders the one notice for the whole page in that case, and two
            copies on one page is the failure this guard exists to prevent.
            Mirrors SupplyClientPage exactly: gear carries expiry dates too,
            and a page showing an EXPIRED verdict must disclose which timezone
            decided it. */}
        {!embedded && hasExpiryBadges && (
          <SupplyTimezoneNotice
            timezoneConfigured={timezoneConfigured}
            className="mb-4"
          />
        )}
        {items.length === 0 ? (
          <SectionEmptyState icon={Package} wording={wording} />
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
