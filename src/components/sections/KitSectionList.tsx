import Link from "next/link";
import { Backpack, PackageOpen, Plus } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionBlockHeader } from "@/components/sections/SectionBlockHeader";
import { SupplyTimezoneNotice } from "@/components/supplies/SupplyTimezoneNotice";
import { formatDateOnly } from "@/lib/date";
import { KIT_CATEGORY_LABELS, type KitCategory } from "@/lib/kit";
import {
  kitRollupHasExpiryBadges,
  type KitExpiryRollup,
} from "@/lib/kits/allocation";

/**
 * The Kits block of the Preparedness group: one card per kit, showing what is
 * packed, what is missing and what is going off.
 *
 * MOUNTED BY BOTH KIT LIST ROUTES, which is the point of it existing as a
 * component rather than as markup inside a page:
 *
 *   /prep/kits — the registry-derived section route (the nav entry and the
 *                section count come from here), via SectionView's kit branch.
 *   /kits      — the spec's routing-table path, which resolves the same
 *                registry section and renders the same SectionView.
 *
 * Both must exist (dropping /prep/kits breaks the nav invariant and the
 * counts; dropping /kits contradicts the routing table) and neither may own a
 * card grid of its own, or the two drift.
 *
 * Still a SERVER component, unlike GearClientPage and SupplyClientPage: the
 * card is a link and the "Add Kit" action is a link, so there is nothing to
 * hydrate. Phase 6 task 5 added both — the note that once stood here saying
 * a detail link "would 404" is obsolete now that /kits/[id] exists.
 *
 * Every number on the card is resolved SERVER-SIDE by `loadSectionItems`:
 * `expiry` comes from `kitExpiryRollup` against the one `today` that loader
 * shares with its gear and supply branches. This component must never compute
 * a verdict itself — a browser-derived "expired" and a server-derived one
 * disagree for every user west of UTC after 17:00.
 */

interface KitItem {
  id: string;
  name: string;
  category: string;
  location: string | null;
  /** The kit's own photo, uploaded on `/kits/[id]/edit`. */
  imageUrl: string | null;
  itemCount: number;
  missing: number;
  expiry: KitExpiryRollup;
}

interface Props {
  items: KitItem[];
  /**
   * REQUIRED with no default, exactly as on GearClientPage and
   * SupplyClientPage: a kit card renders EXPIRED and SOON badges, and an
   * optional prop defaulting to `true` would fail open and silently drop the
   * notice on the next surface that forgets to pass it.
   */
  timezoneConfigured: boolean;
  heading?: string;
  subheading?: string;
  /** True when this is one block of a multi-source section page. */
  embedded?: boolean;
}

function categoryLabel(category: string): string {
  return KIT_CATEGORY_LABELS[category as KitCategory] ?? category;
}

/**
 * The card's badges. Each is `shrink-0` and a SIBLING of the truncating name
 * element rather than a descendant: `truncate` plus `flex` on one element
 * hides its siblings, which hid a quantity badge outright in this repo once
 * (see GearClientPage's ExpiryBadge). Markup that read correctly and only a
 * browser caught — so the name gets its own `truncate min-w-0` span and every
 * badge sits outside it.
 */
function ExpiryBadges({ expiry }: { expiry: KitExpiryRollup }) {
  return (
    <>
      {expiry.expired > 0 && (
        <span className="shrink-0 rounded border border-[#E53935]/20 bg-[#E53935]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#E53935]">
          {expiry.expired} EXPIRED
        </span>
      )}
      {expiry.soon > 0 && (
        <span className="shrink-0 rounded border border-[#F5A623]/20 bg-[#F5A623]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#F5A623]">
          {expiry.soon} SOON
        </span>
      )}
    </>
  );
}

export function KitSectionList({
  items,
  timezoneConfigured,
  heading = "KITS",
  subheading,
  embedded = false,
}: Props) {
  // The SAME rule KitContents uses, via the shared predicate rather than a
  // second spelling: the notice appears only where a verdict badge does. Not
  // `items.length > 0` — that put the amber box above a grid of bags holding
  // nothing dated, which is the gate the comment below has always described.
  const hasExpiryBadges = items.some((kit) =>
    kitRollupHasExpiryBadges(kit.expiry),
  );

  const addAction = (
    <Link
      href="/kits/new"
      className="flex items-center gap-2 rounded border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-3 py-1.5 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20"
    >
      <Plus className="h-4 w-4" />
      Add Kit
    </Link>
  );

  return (
    <div className={embedded ? undefined : "min-h-full"}>
      {embedded ? (
        <SectionBlockHeader title={heading} action={addAction} />
      ) : (
        <PageHeader
          title={heading}
          subtitle={
            subheading ?? `${items.length} kit${items.length !== 1 ? "s" : ""}`
          }
          actions={addAction}
        />
      )}

      <div className="p-4 sm:p-6">
        {/* Only where the badges it explains actually appear, and never when
            embedded — SectionView renders the one notice for the whole page
            in that case, and two copies on one page is the failure that
            guard exists to prevent. */}
        {!embedded && hasExpiryBadges && (
          <SupplyTimezoneNotice
            timezoneConfigured={timezoneConfigured}
            className="mb-4"
          />
        )}

        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-[#00C2FF]/20 bg-[#00C2FF]/10">
              <Backpack className="h-8 w-8 text-[#00C2FF]" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-vault-text">
              No kits yet
            </h3>
            <p className="mb-6 max-w-sm text-sm text-vault-text-muted">
              A kit is a packing list — a bugout bag, a range bag, a vehicle kit
              — that points at gear and supplies you already track.
            </p>
            <Link
              href="/kits/new"
              className="flex items-center gap-2 rounded border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-4 py-2 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20"
            >
              <Plus className="h-4 w-4" />
              Add First Kit
            </Link>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((kit) => (
              <Link
                key={kit.id}
                href={`/kits/${kit.id}`}
                className="block rounded-lg border border-vault-border bg-vault-surface p-3 transition-colors hover:border-[#00C2FF]/40"
              >
                <div className="flex items-start gap-3">
                  {/* The photo where there is one, the icon where there is
                      not — the same 11×11 tile GearClientPage uses, so a kit
                      card and a gear card line up in a mixed section page. */}
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded border border-vault-border bg-vault-bg">
                    {kit.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={kit.imageUrl}
                        alt={kit.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <Backpack className="h-4 w-4 text-vault-text-faint" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    {/* The name truncates alone; the badges are siblings. */}
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-vault-text">
                      <span className="min-w-0 truncate">{kit.name}</span>
                      <span className="shrink-0 rounded border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[#00C2FF]">
                        {categoryLabel(kit.category)}
                      </span>
                      <ExpiryBadges expiry={kit.expiry} />
                    </p>
                    {kit.location && (
                      <p className="truncate text-xs text-vault-text-faint">
                        {kit.location}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="flex items-center gap-1 font-mono text-xs text-vault-text-muted">
                        <PackageOpen className="h-3 w-3" />
                        {kit.itemCount} item{kit.itemCount !== 1 ? "s" : ""}
                      </span>
                      {/* Amber, not red: a short kit is a packing task, not
                          an error. Rendered only when > 0 — a kit whose lines
                          carry no targetQuantity sums to 0 and must not read
                          as "0 missing", which implies a target was met. */}
                      {kit.missing > 0 && (
                        <span className="font-mono text-xs text-[#F5A623]">
                          {kit.missing} missing
                        </span>
                      )}
                      {kit.expiry.earliest && (
                        <span className="font-mono text-xs text-vault-text-muted">
                          exp {formatDateOnly(kit.expiry.earliest)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
