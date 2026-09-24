export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AccessoriesClientPage } from "@/app/accessories/AccessoriesClientPage";
import { GearClientPage } from "@/app/gear/GearClientPage";
import { SupplyClientPage } from "@/app/supplies/SupplyClientPage";
import { getSupplySectionItems } from "@/app/supplies/getSupplySectionItems";
import {
  accessoryWhereForSection,
  gearWhereForSection,
  sectionBySlug,
  supplyWhereForSection,
} from "@/lib/categories";

async function getSectionGear(where: object) {
  return prisma.gear.findMany({ where, orderBy: { name: "asc" } });
}

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

  // A section could in principle carry a gear source, a supply source and an
  // accessory source all at once. No gear-group section does today, so each
  // branch below returns early and a mixed section would silently show only
  // the first source it matches — not a case that exists today.
  const gearWhere = gearWhereForSection(section);
  if (gearWhere) {
    let items: Awaited<ReturnType<typeof getSectionGear>>;
    try {
      items = await getSectionGear(gearWhere);
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
      <GearClientPage
        items={items}
        heading={section.label}
        subheading={section.description}
      />
    );
  }

  // Cleaning is the one gear-group section backed by a supply source instead
  // of a gear or accessory one.
  const supplyWhere = supplyWhereForSection(section);
  if (supplyWhere) {
    let items: Awaited<ReturnType<typeof getSupplySectionItems>>;
    try {
      items = await getSupplySectionItems(supplyWhere);
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
      <SupplyClientPage
        items={items}
        heading={section.label}
        subheading={section.description}
      />
    );
  }

  // A gear-group section must carry a gear matcher, a supply matcher (both
  // handled above) or an accessory matcher — `?? undefined` here would
  // otherwise turn "no matcher for this source" into "no filter", pulling in
  // every accessory. Every section in the registry today has one of the
  // three, so reaching none of them is a registry defect, not a legitimate
  // empty state.
  const accessoryWhere = accessoryWhereForSection(section);
  if (!accessoryWhere) notFound();

  let accessories: Awaited<ReturnType<typeof getSectionAccessories>>;
  try {
    accessories = await getSectionAccessories(accessoryWhere);
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
