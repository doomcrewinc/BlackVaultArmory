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
 * The per-source early returns this page used to carry are gone: each
 * returned after the FIRST source it matched, so a section declaring both a
 * gear and a supply source would silently have rendered one of its two lists.
 * `loadSectionItems` walks every source in declaration order, and its
 * exhaustive switch makes a new source kind a compile error rather than a
 * quietly missing list.
 */
export default async function GearSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "gear") notFound();

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
        href={`/gear/${section.slug}`}
      />
    );
  }

  return <SectionView section={section} payloads={payloads} />;
}
