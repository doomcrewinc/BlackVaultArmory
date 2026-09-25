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
import {
  DEFAULT_EXPIRY_WARNING_DAYS,
  expiryStatus,
  todayForExpiry,
} from "@/lib/supply";

// `today` is resolved once from AppSettings.timezone via todayForExpiry, the
// same boundary getSupplySectionItems and the gear detail page use — never a
// raw `new Date()`, which reads an item expiring "today" as already expired
// every evening in a negative-UTC-offset timezone. GearClientPage is a
// client component and must not compute this itself, so the status is
// resolved here and handed down per item. Two sequential awaits, not
// Promise.all — SQLite here runs with connection_limit=1.
async function getSectionGear(where: object) {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const today = todayForExpiry(settings?.timezone ?? null, new Date());
  const warningDays =
    settings?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS;

  const gear = await prisma.gear.findMany({ where, orderBy: { name: "asc" } });

  return gear.map((item) => ({
    ...item,
    expiry: expiryStatus(item.expirationDate, today, warningDays),
  }));
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
        items={result.items}
        timezoneConfigured={result.timezoneConfigured}
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
