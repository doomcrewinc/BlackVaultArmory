"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageHeader } from "@/components/shared/PageHeader";
import { sectionHref, sectionsForGroup } from "@/lib/categories";
import { fetchCategoryCounts } from "@/lib/category-counts";

export default function PrepPage() {
  const sections = sectionsForGroup("prep");
  const [counts, setCounts] = useState<Record<string, number>>({});

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
    <div className="px-4 py-6 sm:px-6">
      <PageHeader
        title="PREPAREDNESS"
        subtitle="Armor, medical, food, water, power & bugout stores"
      />
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
              <span className="shrink-0 tabular-nums text-sm text-vault-text-muted">
                {counts[section.slug] ?? 0}
              </span>
            </div>
            <p className="mt-1 text-xs text-vault-text-muted">
              {section.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
