export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AccessoriesClientPage } from "@/app/accessories/AccessoriesClientPage";
import { accessoryWhereForSection, sectionBySlug } from "@/lib/categories";

async function getSectionAccessories(where: object | undefined) {
  const accessories = await prisma.accessory.findMany({
    where,
    include: {
      buildSlots: {
        include: {
          build: {
            select: {
              id: true,
              name: true,
              isActive: true,
              firearm: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { roundCount: "desc" },
  });

  return accessories.map((accessory) => {
    const activeSlot = accessory.buildSlots.find((slot) => slot.build.isActive);
    return {
      ...accessory,
      currentBuild: activeSlot
        ? {
            id: activeSlot.build.id,
            name: activeSlot.build.name,
            slotType: activeSlot.slotType,
            firearm: activeSlot.build.firearm,
          }
        : null,
    };
  });
}

export default async function GearSectionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const section = sectionBySlug(slug);
  if (!section || section.group !== "gear") notFound();

  let accessories: Awaited<ReturnType<typeof getSectionAccessories>>;
  try {
    accessories = await getSectionAccessories(
      accessoryWhereForSection(section) ?? undefined,
    );
  } catch {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4">
        <p className="text-sm text-vault-text-muted">
          Failed to load {section.label}.
        </p>
        <Link
          href={`/gear/${section.slug}`}
          className="text-sm text-[#00C2FF] hover:underline"
        >
          Tap to retry
        </Link>
      </div>
    );
  }

  return (
    <AccessoriesClientPage
      accessories={accessories}
      heading={section.label}
      subheading={section.description}
    />
  );
}
