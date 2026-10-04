"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  sectionHref,
  sectionsForGroup,
  type SectionGroup,
} from "@/lib/categories";
import { fetchCategoryCounts } from "@/lib/category-counts";

/**
 * The card grid shared by the Gear and Preparedness landing pages: one card
 * per section of the group, each with its item count.
 *
 * `counts` stays null until the request settles, and stays null if it fails,
 * so a card shows no number rather than a `0` that is not the real count. Once
 * loaded, a section with nothing in it shows an honest `0`.
 */
export function SectionCardGrid({ group }: Readonly<{ group: SectionGroup }>) {
  const sections = sectionsForGroup(group);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCategoryCounts().then((body) => {
      if (!cancelled && body?.counts) setCounts(body.counts);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {sections.map((section) => (
        <Link
          key={section.slug}
          href={sectionHref(section)}
          className="rounded-lg border border-vault-border bg-vault-surface p-4 transition-colors hover:border-[#00C2FF]/40"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate font-medium text-vault-text">
              {section.label}
            </p>
            {counts && (
              <span className="shrink-0 tabular-nums text-sm text-vault-text-muted">
                {counts[section.slug] ?? 0}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-vault-text-muted">
            {section.description}
          </p>
        </Link>
      ))}
    </div>
  );
}
