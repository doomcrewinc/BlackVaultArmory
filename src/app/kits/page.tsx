export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { SectionView } from "@/components/sections/SectionView";
import { sectionBySlug, sectionIsRenderable } from "@/lib/categories";
import {
  loadSectionItems,
  type SectionPayload,
} from "@/lib/sections/loadSectionItems";

/** The registry slug this route is the alias of. One spelling, used twice. */
const KITS_SECTION_SLUG = "kits";

/**
 * `/kits` — the kit list at the path the spec's routing table gives.
 *
 * TWO PATHS SHOW KITS, DELIBERATELY. The spec's section table also puts Kits
 * in the Preparedness group, which makes `/prep/kits` a registry-derived
 * route carrying the nav entry and the section count. Dropping `/prep/kits`
 * breaks the nav invariant and the counts; dropping `/kits` contradicts the
 * routing table. So both exist.
 *
 * They cannot drift, because this page owns NO card grid and NO loader of its
 * own. It resolves the same registry section `/prep/[slug]` resolves, calls
 * the same `loadSectionItems`, and hands the payloads to the same
 * `SectionView` — whose kit branch mounts `KitSectionList`. A change to the
 * card shape, the rollups or the timezone notice lands on both paths at once
 * because there is only one of each to change. The alternative the brief
 * sketched (a second `KitsClientPage` with its own grid) is precisely the
 * duplication this epic has already paid to remove five times over, so it is
 * not what got built; see the task 5 report.
 *
 * `notFound()` on a missing or unrenderable section mirrors `/prep/[slug]`
 * exactly, and is safe for the same reason: the registry test asserts the
 * `kits` section exists and that `sectionIsRenderable` holds for every
 * registered section, so a 404 here means the registry is broken and the
 * suite says so before a user does.
 */
export default async function KitsPage() {
  const section = sectionBySlug(KITS_SECTION_SLUG);
  if (!section) notFound();
  if (!sectionIsRenderable(section)) notFound();

  let payloads: SectionPayload[];
  try {
    payloads = await loadSectionItems(section);
  } catch {
    // The one retry component in this tree, at its sixth call site — not a
    // sixth inline copy of it.
    return <SectionLoadError label={section.label} href="/kits" />;
  }

  return <SectionView section={section} payloads={payloads} />;
}
