export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Backpack, MapPin, PackageOpen, Pencil } from "lucide-react";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { formatDateOnly } from "@/lib/date";
import { KIT_CATEGORY_LABELS, type KitCategory } from "@/lib/kit";
import { getKitDetail, type KitDetail } from "./getKitDetail";
import { KitContents } from "./KitContents";
import { AddKitItem } from "./AddKitItem";
import { DeleteKitButton } from "./DeleteKitButton";

/**
 * `/kits/[id]` — the ONE kit detail page. Both list paths link here:
 * `/prep/kits` (the registry section, via SectionView → KitSectionList) and
 * `/kits` (the routing table's path, which resolves the same section and
 * renders the same SectionView). There is no second detail route.
 *
 * Layout follows the accessory and gear detail pages — breadcrumb, badge row,
 * stat tiles, notes — minus what does not apply to a kit: it has no price, no
 * serial and no documents panel, so those tiles are absent rather than
 * printed as four dashes.
 *
 * `back` points at `/prep/kits` rather than `/kits`, and so does the delete
 * redirect: that is the path in the nav, so it is the path a user recognises
 * returning to.
 */
const BACK_HREF = "/prep/kits";

function categoryLabel(category: string): string {
  return KIT_CATEGORY_LABELS[category as KitCategory] ?? category;
}

function StatTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-vault-border bg-vault-surface p-4">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <p className="text-[10px] uppercase tracking-widest text-vault-text-faint">
          {label}
        </p>
      </div>
      <p className="text-sm text-vault-text">{value}</p>
    </div>
  );
}

export default async function KitDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let detail: KitDetail | null;
  try {
    detail = await getKitDetail(id);
  } catch {
    // The one retry component in this tree, pointed at this page — not a
    // fresh inline copy of it.
    return <SectionLoadError label="kit" href={`/kits/${id}`} />;
  }

  if (!detail) notFound();

  const { kit, groups, itemCount, missing, expiry } = detail;

  return (
    <div className="min-h-full">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-vault-border px-4 py-4 sm:gap-4 sm:px-6">
        <Link
          href={BACK_HREF}
          className="flex items-center gap-1.5 text-sm text-vault-text-muted transition-colors hover:text-vault-text"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Kits
        </Link>
        <div className="flex items-center gap-2">
          <Link
            href={`/kits/${kit.id}/edit`}
            className="flex items-center gap-1.5 rounded-md border border-vault-border bg-vault-surface px-3 py-1.5 text-sm text-vault-text-muted transition-colors hover:text-vault-text"
          >
            <Pencil className="h-4 w-4" />
            Edit
          </Link>
          <DeleteKitButton id={kit.id} redirectTo={BACK_HREF} />
        </div>
      </div>

      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex items-start gap-4">
          {/* The kit's own photo, where one has been uploaded. `Kit.imageUrl`
              is written by the edit form's ImagePicker; this is where it is
              read back, so the column is not a write-only field. */}
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-vault-border bg-vault-surface">
            {kit.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={kit.imageUrl}
                alt={kit.name}
                className="h-full w-full object-cover"
              />
            ) : (
              <Backpack className="h-6 w-6 text-vault-text-faint" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            {/* Badges are siblings of the name, and the name is an `h1` of its
                own below them — not a flex row with the name truncating inside
                it, which is how a badge came to disappear for a long name
                elsewhere in this repo. */}
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <span className="rounded border border-vault-border px-2 py-0.5 font-mono text-xs uppercase text-vault-text-muted">
                {categoryLabel(kit.category)}
              </span>
              {expiry.expired > 0 && (
                <span className="rounded border border-[#E53935]/30 bg-[#E53935]/10 px-2 py-0.5 font-mono text-xs uppercase text-[#E53935]">
                  {expiry.expired} Expired
                </span>
              )}
              {expiry.soon > 0 && (
                <span className="rounded border border-[#F5A623]/30 bg-[#F5A623]/10 px-2 py-0.5 font-mono text-xs uppercase text-[#F5A623]">
                  {expiry.soon} Soon
                </span>
              )}
              {missing > 0 && (
                <span className="rounded border border-[#F5A623]/30 bg-[#F5A623]/10 px-2 py-0.5 font-mono text-xs uppercase text-[#F5A623]">
                  {missing} Missing
                </span>
              )}
            </div>
            <h1 className="break-words text-xl font-bold text-vault-text">
              {kit.name}
            </h1>
            {kit.location && (
              <p className="flex items-center gap-1.5 text-sm text-vault-text-muted">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-vault-text-faint" />
                <span className="min-w-0 break-words">{kit.location}</span>
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StatTile
            label="Contents"
            value={`${itemCount} line${itemCount !== 1 ? "s" : ""}`}
            icon={<PackageOpen className="h-3.5 w-3.5 text-vault-text-faint" />}
          />
          <StatTile
            label="Missing"
            // A dash, not "0": a kit whose lines carry no targetQuantity sums
            // to 0, and "0 missing" would claim a target was met.
            value={missing > 0 ? String(missing) : "—"}
          />
          <StatTile
            label="Next Expiry"
            value={
              expiry.earliest ? formatDateOnly(expiry.earliest) : "—"
            }
          />
        </div>

        <div>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-vault-text-muted">
            Contents
          </h2>
          {/* The picker, above the list it adds to, and mounted whether or not
              the kit has lines yet — an empty kit is exactly when you need
              it. */}
          <div className="mb-4">
            <AddKitItem kitId={kit.id} />
          </div>
          <KitContents
            groups={groups}
            kitId={kit.id}
            timezoneConfigured={detail.timezoneConfigured}
            hasExpiryBadges={detail.hasExpiryBadges}
          />
        </div>

        {kit.notes && (
          <div className="rounded-lg border border-vault-border bg-vault-surface p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-vault-text-muted">
              Notes
            </h3>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-vault-text">
              {kit.notes}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
