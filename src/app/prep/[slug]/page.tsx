export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { SectionView } from "@/components/sections/SectionView";
import { sectionBySlug, sectionIsRenderable } from "@/lib/categories";
import {
  loadSectionItems,
  type SectionPayload,
} from "@/lib/sections/loadSectionItems";

/**
 * Resolve the slug, check the group, load, render.
 *
 * The supply-source `notFound()` this page used to carry is gone: it was
 * exactly what made a gear-backed prep section (armor, shelter & clothing)
 * 404 the moment phase 5 registered it. `loadSectionItems` walks every source
 * a section declares, so "no supply matcher" is now "this section draws from
 * somewhere else", not "this page cannot render". Every query it issues still
 * carries a where clause — the guard that `notFound()` was standing in for.
 */
export default async function PrepSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "prep") notFound();

  // The only notFound() about sources this page may contain. Safe
  // precisely because the registry test asserts sectionIsRenderable is
  // true for every registered section: a 404 here means the registry is
  // broken — a section with no source, a source with no where clause, or
  // one this group's view cannot render — and the suite says so before a
  // user does.
  if (!sectionIsRenderable(section)) notFound();

  let payloads: SectionPayload[];
  try {
    payloads = await loadSectionItems(section);
  } catch {
    return (
      <SectionLoadError
        label={section.label}
        href={`/prep/${section.slug}`}
      />
    );
  }

  return <SectionView section={section} payloads={payloads} />;
}
