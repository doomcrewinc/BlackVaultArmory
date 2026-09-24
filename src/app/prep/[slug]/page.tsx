export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { SupplyClientPage } from "@/app/supplies/SupplyClientPage";
import { getSupplySectionItems } from "@/app/supplies/getSupplySectionItems";
import { sectionBySlug, supplyWhereForSection } from "@/lib/categories";

export default async function PrepSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "prep") notFound();

  // Every prep-group section today carries a supply matcher. A slug that
  // resolves to a real section but has none must still 404 rather than fall
  // through to an unfiltered query — `?? undefined` here would silently pull
  // in every supply instead of none.
  const supplyWhere = supplyWhereForSection(section);
  if (!supplyWhere) notFound();

  let result: Awaited<ReturnType<typeof getSupplySectionItems>>;
  try {
    result = await getSupplySectionItems(supplyWhere);
  } catch {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-vault-text-muted">
          Failed to load {section.label}.
        </p>
        <Link
          href={`/prep/${section.slug}`}
          className="text-sm text-[#00C2FF] hover:underline"
        >
          Tap to retry
        </Link>
      </div>
    );
  }

  return (
    <SupplyClientPage
      items={result.items}
      timezoneConfigured={result.timezoneConfigured}
      heading={section.label}
      subheading={section.description}
    />
  );
}
