import Link from "next/link";
import { PageHeader } from "@/components/shared/PageHeader";
import { sectionsForGroup } from "@/lib/categories";

export default function GearPage() {
  const sections = sectionsForGroup("gear");

  return (
    <div className="px-4 py-6 sm:px-6">
      <PageHeader title="GEAR" subtitle="Everything that is not a firearm" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((section) => (
          <Link
            key={section.slug}
            href={`/gear/${section.slug}`}
            className="rounded-lg border border-vault-border bg-vault-surface p-4 transition-colors hover:border-[#00C2FF]/40"
          >
            <p className="font-medium text-vault-text">{section.label}</p>
            <p className="mt-1 text-xs text-vault-text-muted">
              {section.description}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
