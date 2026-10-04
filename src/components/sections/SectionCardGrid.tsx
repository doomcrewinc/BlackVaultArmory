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
 * The counts have an explicit status. While `loading` and after a `failed`
 * request (or a body without counts) a card shows no number, rather than a `0`
 * that is not the real count; once `ready`, a section with nothing in it shows
 * an honest `0`. The grid is `aria-busy` only while loading.
 */
type CountsState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; counts: Record<string, number> };

export function SectionCardGrid({ group }: Readonly<{ group: SectionGroup }>) {
  const sections = sectionsForGroup(group);
  const [state, setState] = useState<CountsState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchCategoryCounts()
      .then((body) => {
        if (cancelled) return;
        setState(
          body?.counts
            ? { status: "ready", counts: body.counts }
            : { status: "failed" },
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
      aria-busy={state.status === "loading" ? true : undefined}
    >
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
            {state.status === "ready" && (
              <span className="shrink-0 tabular-nums text-sm text-vault-text-muted">
                {state.counts[section.slug] ?? 0}
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
