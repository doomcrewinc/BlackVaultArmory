import { notFound } from "next/navigation";
import { VaultClientPage } from "../../VaultClientPage";
import { LegacySmgNotice } from "@/components/vault/LegacySmgNotice";
import { sectionBySlug } from "@/lib/categories";

export default async function VaultSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "vault") notFound();

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
