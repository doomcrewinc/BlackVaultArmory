export const dynamic = "force-dynamic";

import { prisma } from "@/lib/prisma";
import { SectionLoadError } from "@/components/sections/SectionLoadError";
import { AccessoriesClientPage } from "./AccessoriesClientPage";

async function getAccessories() {
  const accessories = await prisma.accessory.findMany({
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

export default async function AccessoriesPage() {
  let accessories: Awaited<ReturnType<typeof getAccessories>>;
  try {
    accessories = await getAccessories();
  } catch {
    return <SectionLoadError label="accessories" href="/accessories" />;
  }

  return <AccessoriesClientPage accessories={accessories} />;
}
