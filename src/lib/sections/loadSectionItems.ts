import { prisma } from "@/lib/prisma";
import {
  accessoryWhereForSection,
  firearmWhereForSection,
  gearWhereForSection,
  kitWhereForSection,
  sectionSources,
  supplyWhereForSection,
  type CategorySection,
} from "@/lib/categories";
import {
  kitExpiryRollup,
  missingQuantity,
  type KitExpiryLine,
  type KitExpiryRollup,
} from "@/lib/kits/allocation";
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
/**
 * A kit's scalars plus the three rollups the card renders. The `items`
 * relation is deliberately NOT part of this: the loader includes it to do the
 * maths and then drops it, so a KitItem's five nullable foreign keys and its
 * joined gear/supply rows are not serialized across the server/client
 * boundary for a card that only ever shows three numbers.
 */
type KitSectionItem = Awaited<
  ReturnType<typeof prisma.kit.findMany>
>[number] & {
  /** How many KitItem lines the kit holds, packed or not. */
  itemCount: number;
  /** Summed `missingQuantity` across its lines: 0 when nothing has a target. */
  missing: number;
  expiry: KitExpiryRollup;
};

export type SectionPayload =
  | { kind: "firearm"; items: FirearmSectionItem[] }
  | { kind: "accessory"; items: AccessorySectionItem[] }
  | { kind: "gear"; items: GearSectionItem[]; timezoneConfigured: boolean }
  | { kind: "supply"; items: SupplySectionItem[]; timezoneConfigured: boolean }
  | { kind: "kit"; items: KitSectionItem[]; timezoneConfigured: boolean };

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
 * gear, supply AND kit branches so no two lists on one page can disagree
 * about what "today" is. The kit branch rolls its contents up through
 * `kitExpiryRollup`, which calls the same `expiryStatus` the other two use,
 * rather than deriving "expired" a third time.
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
      case "kit": {
        // `{}` for the kits section — all kits, by spec — and that is
        // truthy, so this does NOT continue. Only a section with no kit
        // matcher at all gets null here and is skipped. The distinction is
        // the whole reason `kitWhereForSection` ends in `?? null`; see
        // UNFILTERED_SECTION_SOURCES in categories.ts.
        const where = kitWhereForSection(section);
        if (!where) continue;
        // The SAME resolution the gear and supply branches use, not a second
        // one. Two `today` values on one page is how two lists come to
        // disagree about what day it is.
        const { today, warningDays, configured } = await loadExpiryContext();
        // ONE query with an include rather than a query per kit: sqlite here
        // runs connection_limit=1, so N+1 would serialize into N round trips.
        // Only `expirationDate` is selected off the joined rows — the rollup
        // needs nothing else, and Gear and Supply are the only two sources a
        // KitItem can point at that carry one (Accessory, AmmoStock and
        // Firearm have no expiry, and a label-only line has no row to join).
        const rows = await prisma.kit.findMany({
          where,
          orderBy: { name: "asc" },
          include: {
            items: {
              select: {
                quantity: true,
                targetQuantity: true,
                gear: { select: { expirationDate: true } },
                supply: { select: { expirationDate: true } },
              },
            },
          },
        });
        payloads.push({
          kind: "kit",
          items: rows.map((row) => {
            // `items` is destructured OUT: see KitSectionItem. Spreading the
            // included row would put a field on the payload at runtime that
            // its type does not declare.
            const { items, ...kit } = row;
            let missing = 0;
            const lines: KitExpiryLine[] = [];
            for (const item of items) {
              missing += missingQuantity(item);
              // A KitItem sets at most one source, so at most one of these
              // is non-null; `??` picks whichever it is.
              const expirationDate =
                item.gear?.expirationDate ??
                item.supply?.expirationDate ??
                null;
              if (expirationDate) lines.push({ expirationDate });
            }
            return {
              ...kit,
              itemCount: items.length,
              missing,
              // `kitExpiryRollup` from @/lib/kits/allocation rather than
              // expiryStatus inline: one implementation of "expired", shared
              // with the API and the dashboard.
              expiry: kitExpiryRollup(lines, today, warningDays),
            };
          }),
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
