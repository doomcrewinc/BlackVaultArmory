import Link from "next/link";
import { ExternalLink, PackageOpen, TriangleAlert } from "lucide-react";
import { SupplyTimezoneNotice } from "@/components/supplies/SupplyTimezoneNotice";
import { formatDateOnly } from "@/lib/date";
import { KitLineControls } from "./KitLineControls";
import { formatKitQuantity as formatQuantity } from "@/lib/kits/sourceDisplay";
import type { KitContentGroup, KitContentLine } from "./getKitDetail";

/**
 * A kit's contents, grouped by source, one labelled block each.
 *
 * Renders only. Every verdict on a line — `expiry`, `overAllocated`,
 * `missing` — was decided server-side by `getKitDetail` against one `today`
 * resolved from AppSettings. Nothing here reads a clock, and nothing here
 * re-derives a threshold.
 */

/**
 * Every badge is `shrink-0` and a SIBLING of the truncating name element,
 * never a descendant of it: `truncate` and `flex` on one element hides that
 * element's children, which hid a quantity badge outright in this repo once
 * (see GearClientPage and SupplyClientPage, which each paid for it). The name
 * gets its own `truncate min-w-0` span and the badges sit outside.
 */
function LineBadges({ line }: { line: KitContentLine }) {
  return (
    <>
      {line.expiry === "expired" && (
        <span className="shrink-0 rounded border border-[#E53935]/20 bg-[#E53935]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#E53935]">
          Expired
        </span>
      )}
      {line.expiry === "soon" && (
        <span className="shrink-0 rounded border border-[#F5A623]/20 bg-[#F5A623]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#F5A623]">
          Soon
        </span>
      )}
      {/* Amber, not red: a short line is a packing task, not an error.
          Rendered only above zero — `missingQuantity` returns 0 both for "no
          target" and for "target met", and "0 missing" would imply a target
          existed and was met. */}
      {line.missing > 0 && (
        <span className="shrink-0 font-mono text-[10px] text-[#F5A623]">
          {formatQuantity(line.missing)} missing
        </span>
      )}
    </>
  );
}

function ContentLine({
  line,
  kitId,
}: {
  line: KitContentLine;
  kitId: string;
}) {
  const name = (
    <span className="min-w-0 truncate font-medium text-vault-text">
      {line.name}
    </span>
  );

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {line.href ? (
          <Link
            href={line.href}
            className="flex min-w-0 items-center gap-1 hover:underline"
          >
            {name}
            <ExternalLink className="h-3 w-3 shrink-0 text-vault-text-faint" />
          </Link>
        ) : (
          name
        )}
        <LineBadges line={line} />
      </div>

      {line.detail && (
        <p className="truncate text-xs text-vault-text-faint">{line.detail}</p>
      )}

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-vault-text-muted">
        <span>
          {formatQuantity(line.quantity)}
          {/* The target only appears when one is set: "3 / 3" and a bare "3"
              say different things, and printing "3 / —" would say neither. */}
          {line.targetQuantity !== null && (
            <> / {formatQuantity(line.targetQuantity)}</>
          )}
          {line.unit && <span className="text-vault-text-faint"> {line.unit}</span>}
        </span>
        {line.expirationDate && (
          <span>exp {formatDateOnly(line.expirationDate)}</span>
        )}
      </div>

      {/* The spec's example, shown and never refused: "an over-allocated line
          shows its warning inline". `allocated` is the sum across EVERY kit,
          so the same warning appears on every kit holding the item. */}
      {line.overAllocated && line.owned !== null && (
        <p className="mt-1.5 flex items-start gap-1.5 rounded border border-[#E53935]/30 bg-[#E53935]/10 px-2 py-1 text-xs text-[#E53935]">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            {formatQuantity(line.allocated)} of {formatQuantity(line.owned)}{" "}
            assigned across kits
          </span>
        </p>
      )}

      {line.notes && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-vault-text-muted">
          {line.notes}
        </p>
      )}

      {/* The only client component on this list: everything above it is a
          server-rendered verdict, and these are the two writes. */}
      <KitLineControls
        kitId={kitId}
        itemId={line.id}
        name={line.name}
        quantity={line.quantity}
        targetQuantity={line.targetQuantity}
        notes={line.notes}
      />
    </li>
  );
}

export function KitContents({
  groups,
  kitId,
  timezoneConfigured,
  hasExpiryBadges,
}: {
  groups: KitContentGroup[];
  /** Needed by every line's edit/remove controls to address its API route. */
  kitId: string;
  /**
   * REQUIRED with no default, as on every other surface that renders an
   * expiry badge: an optional prop defaulting to `true` is fail-open and
   * would drop the notice silently here.
   */
  timezoneConfigured: boolean;
  /** True when some line renders an EXPIRED/SOON badge. */
  hasExpiryBadges: boolean;
}) {
  if (groups.length === 0) {
    // An empty kit is a real, common state — a kit is created before it is
    // packed — so it gets an empty state, never a blank region under a
    // heading. The picker now exists (task 6) and the page mounts it directly
    // above this block, so the copy points at it rather than describing a
    // control that has not been built.
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-vault-border bg-vault-surface py-16 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-[#00C2FF]/20 bg-[#00C2FF]/10">
          <PackageOpen className="h-7 w-7 text-[#00C2FF]" />
        </div>
        <h3 className="mb-2 text-base font-semibold text-vault-text">
          Nothing packed yet
        </h3>
        <p className="max-w-sm px-4 text-sm text-vault-text-muted">
          Use <span className="text-vault-text">Add a line</span> above.
          A kit&apos;s contents point at gear, supplies, accessories, ammo and
          firearms you already track — or carry a plain label for something you
          don&apos;t.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Only where the badges it explains actually appear. A kit of
          accessories and firearms carries no expiry date at all, and the
          notice would be answering a question the page never raised. */}
      {hasExpiryBadges && (
        <SupplyTimezoneNotice timezoneConfigured={timezoneConfigured} />
      )}

      {groups.map((group) => (
        <div
          key={group.key}
          className="overflow-hidden rounded-lg border border-vault-border bg-vault-surface"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-vault-border px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted">
              {group.label}
            </h3>
            <span className="font-mono text-xs text-vault-text-faint">
              {group.lines.length} line{group.lines.length !== 1 ? "s" : ""}
            </span>
          </div>
          <ul className="divide-y divide-vault-border">
            {group.lines.map((line) => (
              <ContentLine key={line.id} line={line} kitId={kitId} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
