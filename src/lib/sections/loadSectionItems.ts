import { prisma } from "@/lib/prisma";
import {
  accessoryWhereForSection,
  firearmWhereForSection,
  gearWhereForSection,
  sectionSources,
  supplyWhereForSection,
  type CategorySection,
} from "@/lib/categories";
import {
  expiryStatus,
  resolveExpiryContext,
  type ExpiryStatus,
} from "@/lib/supply";
import {
  mapSupplyRow,
  type SupplySectionItem,
} from "@/app/supplies/getSupplySectionItems";

/**
 * Loads the accessories of one section, with the build each is currently
 * mounted on resolved.
 *
 * Moved unchanged from `/gear/[slug]/page.tsx` — the `buildSlots` include,
 * the `roundCount` ordering and the `currentBuild` mapping are what
 * AccessoriesClientPage renders, so they belong with the loader rather than
 * beside one of its callers.
 */
export async function loadSectionAccessories(where: object) {
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

/**
 * The item types are derived from the Prisma delegates rather than written
 * out, so a schema change updates them automatically. Hand-written row
 * interfaces are the shape that fell behind the schema in DATE_ONLY_FIELDS.
 */
type FirearmSectionItem = Awaited<
  ReturnType<typeof prisma.firearm.findMany>
>[number];
type AccessorySectionItem = Awaited<
  ReturnType<typeof loadSectionAccessories>
>[number];
type GearSectionItem = Awaited<
  ReturnType<typeof prisma.gear.findMany>
>[number] & { expiry: ExpiryStatus };

export type SectionPayload =
  | { kind: "firearm"; items: FirearmSectionItem[] }
  | { kind: "accessory"; items: AccessorySectionItem[] }
  | { kind: "gear"; items: GearSectionItem[]; timezoneConfigured: boolean }
  | { kind: "supply"; items: SupplySectionItem[]; timezoneConfigured: boolean };

/**
 * Loads every source a section declares, in declaration order.
 *
 * Replaces the single-source early return both [slug] pages used to carry.
 * `/prep/[slug]` handled ONLY supply sources, so a gear-backed prep section
 * (armor, shelter & clothing) 404'd; `/gear/[slug]` returned after its first
 * source, so a mixed section (medical, food & water) silently showed one of
 * its lists.
 *
 * The `switch` below is exhaustive over SectionSource with no `default`, so a
 * source kind added to the registry is a tsc error here rather than a section
 * that renders one fewer list than it claims. That is the guard the
 * reachability test cannot express.
 *
 * Sequential awaits throughout — sqlite here runs with connection_limit=1 —
 * and the expiry timezone is resolved at most once per call, shared by the
 * gear and supply branches so the two lists on one page cannot disagree about
 * what "today" is.
 */
export async function loadSectionItems(
  section: CategorySection,
): Promise<SectionPayload[]> {
  const payloads: SectionPayload[] = [];
  let expiryContext: {
    today: Date;
    warningDays: number;
    configured: boolean;
  } | null = null;

  const loadExpiryContext = async () => {
    if (expiryContext) return expiryContext;
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });
    // Never a raw `new Date()`: its UTC day is already tomorrow every evening
    // west of UTC, which reads an item expiring today as expired.
    //
    // `configured` comes off the same resolution as `today` rather than a
    // second Boolean(settings.timezone). The two disagree for a zone that is
    // SET BUT UNRECOGNISED: resolveExpiryTimeZone discards it and computes in
    // UTC, so the notice has to appear — the hand-rolled predicate said
    // "configured", hiding it on exactly the install whose verdicts were
    // decided by a zone the user did not choose.
    const { today, warningDays, timezoneFromSetting } = resolveExpiryContext(
      settings,
      new Date(),
    );
    expiryContext = { today, warningDays, configured: timezoneFromSetting };
    return expiryContext;
  };

  for (const kind of sectionSources(section)) {
    switch (kind) {
      // Every branch `continue`s on a null where. A `?? undefined` here would
      // turn "this section has no matcher for this source" into "no filter",
      // pulling in every row of the table; that coercion has caused two live
      // bugs in this epic.
      case "firearm": {
        const where = firearmWhereForSection(section);
        if (!where) continue;
        const rows = await prisma.firearm.findMany({
          where,
          orderBy: { name: "asc" },
        });
        payloads.push({ kind: "firearm", items: rows });
        continue;
      }
      case "accessory": {
        const where = accessoryWhereForSection(section);
        if (!where) continue;
        payloads.push({
          kind: "accessory",
          items: await loadSectionAccessories(where),
        });
        continue;
      }
      case "gear": {
        const where = gearWhereForSection(section);
        if (!where) continue;
        const { today, warningDays, configured } = await loadExpiryContext();
        const rows = await prisma.gear.findMany({
          where,
          orderBy: { name: "asc" },
        });
        payloads.push({
          kind: "gear",
          items: rows.map((row) => ({
            ...row,
            expiry: expiryStatus(row.expirationDate, today, warningDays),
          })),
          timezoneConfigured: configured,
        });
        continue;
      }
      case "supply": {
        const where = supplyWhereForSection(section);
        if (!where) continue;
        const { today, warningDays, configured } = await loadExpiryContext();
        const rows = await prisma.supply.findMany({
          where,
          orderBy: { name: "asc" },
        });
        payloads.push({
          kind: "supply",
          items: rows.map((row) => mapSupplyRow(row, today, warningDays)),
          timezoneConfigured: configured,
        });
        continue;
      }
    }

    // Unreachable while the switch above covers every SectionSource: each
    // case `continue`s, so `kind` narrows to `never` here. There is no
    // `default` on purpose — a source kind added to the registry widens this
    // back to that kind and TS2322 fires on this line, at compile time,
    // instead of the new source silently rendering one fewer list than the
    // section declares. Phase 6's `kit` source relies on this firing.
    const unhandled: never = kind;
    throw new Error(`Unhandled section source: ${String(unhandled)}`);
  }

  return payloads;
}
