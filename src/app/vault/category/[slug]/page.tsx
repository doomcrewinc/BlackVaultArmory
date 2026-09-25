import { notFound } from "next/navigation";
import { VaultClientPage } from "../../VaultClientPage";
import { LegacySmgNotice } from "@/components/vault/LegacySmgNotice";
import { sectionBySlug, sectionIsRenderable } from "@/lib/categories";

export default async function VaultSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "vault") notFound();

  // The same gate the /gear and /prep [slug] pages carry. This page's view
  // is VaultClientPage, which fetches /api/firearms by slug, so a vault
  // section declaring a gear or supply source would render firearms only
  // and drop the rest silently. sectionIsRenderable is group-aware and the
  // registry test asserts it holds for all nine vault sections, so this
  // 404 is unreachable unless the registry itself is broken.
  if (!sectionIsRenderable(section)) notFound();

  return (
    <>
      {section.slug === "machine-guns" && (
        <div className="px-4 pt-4 sm:px-6">
          <LegacySmgNotice />
        </div>
      )}
      <VaultClientPage
        heading={section.label.toUpperCase()}
        subheading={section.description}
        sectionSlug={section.slug}
      />
    </>
  );
}
