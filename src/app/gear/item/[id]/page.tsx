export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { GEAR_CATEGORY_LABELS, type GearCategory } from "@/lib/gear";
import { formatCurrency } from "@/lib/utils";
import { formatDateOnly } from "@/lib/date";
import { DeleteGearButton } from "./DeleteGearButton";
import { ArrowLeft, Pencil, DollarSign, Calendar, MapPin } from "lucide-react";

async function getGear(id: string) {
  return prisma.gear.findUnique({
    where: { id },
    include: {
      documents: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
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

  let gear: Awaited<ReturnType<typeof getGear>>;
  try {
    gear = await getGear(id);
  } catch {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <p className="text-vault-text-muted text-sm">Failed to load item.</p>
        <Link href="/gear" className="text-[#00C2FF] text-sm hover:underline">
          Back to gear
        </Link>
      </div>
    );
  }

  if (!gear) {
    notFound();
  }

  return (
    <div className="min-h-full">
      {/* Breadcrumb header */}
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4 px-4 sm:px-6 py-4 border-b border-vault-border">
        <Link
          href="/gear"
          className="flex items-center gap-1.5 text-vault-text-muted hover:text-vault-text text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Gear
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/gear/item/${gear.id}/edit`}
            className="flex items-center gap-1.5 text-sm bg-vault-surface border border-vault-border text-vault-text-muted hover:text-vault-text px-3 py-1.5 rounded-md transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Edit
          </Link>
          <DeleteGearButton id={gear.id} />
        </div>
      </div>

      <div className="p-4 sm:p-6 space-y-6">
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
          </div>
          <h1 className="text-xl font-bold text-vault-text">{gear.name}</h1>
          {(gear.manufacturer || gear.model) && (
            <p className="text-sm text-vault-text-muted">
              {[gear.manufacturer, gear.model].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

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
      </div>
    </div>
  );
}
