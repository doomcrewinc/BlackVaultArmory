export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import {
  GEAR_CATEGORY_LABELS,
  isArmorCategory,
  type GearCategory,
} from "@/lib/gear";
import { expiryStatus, resolveExpiryContext } from "@/lib/supply";
import { gearSectionForItem, sectionHref } from "@/lib/categories";
import { formatCurrency } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { SupplyTimezoneNotice } from "@/components/supplies/SupplyTimezoneNotice";
import { DeleteGearButton } from "./DeleteGearButton";
import { ItemDocumentPanel } from "@/components/shared/ItemDocumentPanel";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { ItemKitAllocation } from "@/components/kits/ItemKitAllocation";
import { getItemAllocation } from "@/lib/kits/itemAllocation";
import { ArrowLeft, Pencil, DollarSign, Calendar, MapPin } from "lucide-react";

// No `include: { documents }`: ItemDocumentPanel fetches its own list from
// /api/documents?gearId=…, so an included set would be loaded and never read.
//
// `today` is resolved here via resolveExpiryContext, the same boundary the
// supply detail page and getSupplySectionItems use — never a raw
// `new Date()`, which reads an item expiring "today" as already expired
// every evening in a negative-UTC-offset timezone. Two sequential awaits,
// not Promise.all — SQLite here runs with connection_limit=1.
async function getGearWithExpiry(id: string) {
  const gear = await prisma.gear.findUnique({ where: { id } });
  if (!gear) return null;

  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const { today, warningDays, timezoneFromSetting } = resolveExpiryContext(
    settings,
    new Date(),
  );

  // ONE more sequential query, and only one: how much of this gear is packed
  // across kits. `owned` is gear.quantity from the record already in hand, so
  // this adds no read of the gear table. Null when it is in no kit, which is
  // the usual case and renders nothing.
  const allocation = await getItemAllocation("gearId", gear.id, gear.quantity);

  return {
    gear,
    expiry: expiryStatus(gear.expirationDate, today, warningDays),
    allocation,
    // Same read AND the same resolution, handed on: this page renders
    // Expired / Expiring Soon badges too, so it carries the same notice as
    // the supply detail page. Taken off resolveExpiryContext rather than
    // recomputed as Boolean(settings.timezone), which claims "configured" for
    // a set-but-unrecognised zone that was actually evaluated in UTC.
    timezoneConfigured: timezoneFromSetting,
  };
}

function categoryLabel(category: string): string {
  return GEAR_CATEGORY_LABELS[category as GearCategory] ?? category;
}

export default async function GearDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let result: Awaited<ReturnType<typeof getGearWithExpiry>>;
  try {
    result = await getGearWithExpiry(id);
  } catch {
    // Retry this page rather than link to a section: the load failed, so
    // there is no category to resolve a section from — and "/gear" would be
    // the wrong guess for the eighteen categories that live under /prep.
    // Same component and same shape as the supply detail page's error branch.
    return <SectionLoadError label="item" href={`/gear/item/${id}`} />;
  }

  if (!result) {
    notFound();
  }

  const { gear, expiry, allocation, timezoneConfigured } = result;
  const hasExpiryBadge = expiry === "expired" || expiry === "soon";
  // Resolved from the item, not hardcoded. /gear is a section INDEX over the
  // gear group only, so "Back to Gear" stranded an ARMOR, MEDICAL_KIT or
  // SHELTER item on a page that does not contain it — eighteen of the twenty
  // categories live in the prep group. gearSectionForItem searches every
  // group for exactly this; sectionHref owns the path shape. Mirrors
  // supplies/item/[id].
  const section = gearSectionForItem({ category: gear.category });
  const backHref = section ? sectionHref(section) : "/";
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
            href={`/gear/item/${gear.id}/edit`}
            className="flex items-center gap-1.5 text-sm bg-vault-surface border border-vault-border text-vault-text-muted hover:text-vault-text px-3 py-1.5 rounded-md transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </Link>
          <DeleteGearButton id={gear.id} redirectTo={backHref} />
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-6">
        {/* Only where the badge it explains actually appears — see the
            supply detail page and KitContents for the same rule. */}
        {hasExpiryBadge && (
          <SupplyTimezoneNotice timezoneConfigured={timezoneConfigured} />
        )}

        {/* Title block */}
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-muted font-mono uppercase">
              {categoryLabel(gear.category)}
            </span>
            {gear.serialNumber && (
              <span className="text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-faint font-mono">
                S/N {gear.serialNumber}
              </span>
            )}
            {/* Only worth a badge when there is more than one of the item,
                matching the list view's ×N badge rule. */}
            {gear.quantity > 1 && (
              <span className="text-xs px-2 py-0.5 rounded border border-vault-border text-vault-text-muted font-mono">
                ×{gear.quantity}
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
          <h1 className="text-xl font-bold text-vault-text">{gear.name}</h1>
          {(gear.manufacturer || gear.model) && (
            <p className="text-sm text-vault-text-muted">
              {[gear.manufacturer, gear.model].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        {/* Directly under the title, ABOVE the stats: an over-allocation is
            the most urgent thing this page has to say, and burying it under
            four price tiles is how the kit half of the rule came to be the
            only half anyone saw. Renders nothing when the item is in no kit. */}
        <ItemKitAllocation allocation={allocation} />

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Purchase Price
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {formatCurrency(gear.purchasePrice)}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Current Value
              </p>
            </div>
            <p className="text-sm font-mono text-vault-text">
              {formatCurrency(gear.currentValue)}
            </p>
          </div>

          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Calendar className="w-3.5 h-3.5 text-vault-text-faint" />
              <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                Acquired
              </p>
            </div>
            <p className="text-sm text-vault-text">
              {formatDateOnly(gear.acquisitionDate)}
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
              {gear.storageLocation ?? "—"}
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
              {formatDateOnly(gear.expirationDate)}
            </p>
          </div>

          {isArmorCategory(gear.category) && (
            <>
              <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                    Protection Level
                  </p>
                </div>
                <p className="text-sm text-vault-text">
                  {gear.protectionLevel ?? "—"}
                </p>
              </div>

              <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
                    Size / Cut
                  </p>
                </div>
                <p className="text-sm text-vault-text">
                  {gear.armorSize ?? "—"}
                </p>
              </div>
            </>
          )}
        </div>

        {/* Notes */}
        {gear.notes && (
          <div className="bg-vault-surface border border-vault-border rounded-lg p-4">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted mb-2">
              Notes
            </h3>
            <p className="text-sm text-vault-text leading-relaxed whitespace-pre-wrap">
              {gear.notes}
            </p>
          </div>
        )}

        <ItemDocumentPanel
          entityType="gear"
          entityId={gear.id}
          title="Gear Documents"
        />
      </div>
    </div>
  );
}
