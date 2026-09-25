import { prisma } from "@/lib/prisma";
import {
  KIT_ITEM_SOURCES,
  KIT_ITEM_SOURCE_LABELS,
  KIT_ITEM_UNTRACKED_LABEL,
  type KitItemSourceField,
} from "@/lib/kit";
import {
  allocationByItem,
  allocationKey,
  allocationSourceOf,
  isOverAllocated,
  kitExpiryRollup,
  missingQuantity,
  type KitExpiryLine,
  type KitExpiryRollup,
} from "@/lib/kits/allocation";
import {
  expiryStatus,
  resolveExpiryContext,
  SUPPLY_UNIT_LABELS,
  type ExpiryStatus,
  type SupplyUnit,
} from "@/lib/supply";

/**
 * One rendered line of a kit's contents. Everything a badge needs is already
 * DECIDED here, on the server: `expiry` is a verdict, not a date to compare,
 * and `overAllocated` is a boolean, not two numbers for a component to weigh.
 * The client renders; it never computes a verdict. A browser-derived
 * "expired" and a server-derived one disagree for every user west of UTC
 * after 17:00, which is what phases 4 and 5 each had to fix.
 */
export interface KitContentLine {
  id: string;
  /** Which of the five sources this line points at; null for a label-only line. */
  source: KitItemSourceField | null;
  /** The inventory record's name, or the line's own `label` when untracked. */
  name: string;
  /** Manufacturer, model, brand, caliber — whatever else identifies it. */
  detail: string | null;
  /** The record's own detail page, where the app has one. */
  href: string | null;
  quantity: number;
  targetQuantity: number | null;
  /** From `missingQuantity`: 0 when there is no target or it is met. */
  missing: number;
  /** A supply's unit label, where the record carries one. */
  unit: string | null;
  expiry: ExpiryStatus;
  expirationDate: Date | null;
  /** This item's summed quantity across EVERY kit, not just this one. */
  allocated: number;
  /** How many are owned, or null when nothing measurable is tracked. */
  owned: number | null;
  /** From `isOverAllocated`. Flags — never blocks; see allocation.ts. */
  overAllocated: boolean;
  notes: string | null;
}

/** One labelled block of the contents list. */
export interface KitContentGroup {
  /** A source field name, or "other" for the untracked block. */
  key: KitItemSourceField | "other";
  label: string;
  lines: KitContentLine[];
}

export interface KitDetail {
  kit: {
    id: string;
    name: string;
    category: string;
    location: string | null;
    notes: string | null;
  };
  groups: KitContentGroup[];
  itemCount: number;
  /** Summed `missingQuantity` across every line. */
  missing: number;
  expiry: KitExpiryRollup;
  /** True when any line renders an expiry badge — gates the timezone notice. */
  hasExpiryBadges: boolean;
  /**
   * From the SAME AppSettings read that resolved the verdicts above, not a
   * second `Boolean(settings.timezone)`: the two disagree for a zone that is
   * set but unrecognised, and the hand-rolled predicate hid the notice on
   * exactly the install whose verdicts a zone the user did not choose decided.
   */
  timezoneConfigured: boolean;
}

/**
 * Every relation a KitItem may point at, included on the one kit read. The
 * `select`s are narrow on purpose — these rows exist to name the line, price
 * nothing, and say how many are owned and when they expire.
 */
const itemsInclude = {
  items: {
    orderBy: { createdAt: "asc" },
    include: {
      gear: {
        select: {
          id: true,
          name: true,
          manufacturer: true,
          model: true,
          quantity: true,
          expirationDate: true,
        },
      },
      supply: {
        select: {
          id: true,
          name: true,
          brand: true,
          quantity: true,
          unit: true,
          expirationDate: true,
        },
      },
      accessory: {
        select: {
          id: true,
          name: true,
          manufacturer: true,
          model: true,
          quantity: true,
        },
      },
      ammoStock: {
        select: { id: true, brand: true, caliber: true, quantity: true },
      },
      firearm: {
        select: { id: true, name: true, manufacturer: true, model: true },
      },
    },
  },
} as const;

type KitWithItems = NonNullable<
  Awaited<
    ReturnType<
      typeof prisma.kit.findUnique<{
        where: { id: string };
        include: typeof itemsInclude;
      }>
    >
  >
>;
type KitItemRow = KitWithItems["items"][number];

function joinDetail(...parts: (string | null | undefined)[]): string | null {
  const joined = parts.filter(Boolean).join(" · ");
  return joined === "" ? null : joined;
}

function unitLabel(unit: string): string {
  return SUPPLY_UNIT_LABELS[unit as SupplyUnit] ?? unit;
}

/**
 * What the line shows for whichever source it set: a name, a sub-line, a link
 * to the record, how many are owned and when it expires.
 *
 * `owned` is the honest answer per table, and the differences are not
 * oversights:
 *   - Gear, Supply, Accessory and AmmoStock each carry a `quantity` column.
 *   - Firearm carries NONE — a firearm row is one physical object — so owned
 *     is 1. That makes packing the same rifle in two kits read "2 of 1
 *     assigned", which is the true and useful answer, not a false alarm.
 *   - A label-only line has no record at all, so owned is null and
 *     `isOverAllocated` never flags it. Nothing measurable to exceed.
 *
 * Only Gear and Supply carry an `expirationDate`; the other three have no
 * expiry to report, so those lines render no badge rather than a "fine" one.
 */
function describeSource(item: KitItemRow, field: KitItemSourceField | null) {
  switch (field) {
    case "gearId":
      if (!item.gear) break;
      return {
        name: item.gear.name,
        detail: joinDetail(item.gear.manufacturer, item.gear.model),
        href: `/gear/item/${item.gear.id}`,
        owned: item.gear.quantity as number | null,
        unit: null as string | null,
        expirationDate: item.gear.expirationDate,
      };
    case "supplyId":
      if (!item.supply) break;
      return {
        name: item.supply.name,
        detail: item.supply.brand,
        href: `/supplies/item/${item.supply.id}`,
        owned: item.supply.quantity as number | null,
        unit: unitLabel(item.supply.unit),
        expirationDate: item.supply.expirationDate,
      };
    case "accessoryId":
      if (!item.accessory) break;
      return {
        name: item.accessory.name,
        detail: joinDetail(item.accessory.manufacturer, item.accessory.model),
        href: `/accessories/${item.accessory.id}`,
        owned: item.accessory.quantity as number | null,
        unit: null,
        expirationDate: null,
      };
    case "ammoStockId":
      if (!item.ammoStock) break;
      return {
        name: `${item.ammoStock.brand} ${item.ammoStock.caliber}`,
        detail: null,
        // No /ammo/[id] route exists, so no link rather than a dead one.
        href: null,
        owned: item.ammoStock.quantity as number | null,
        unit: "rounds",
        expirationDate: null,
      };
    case "firearmId":
      if (!item.firearm) break;
      return {
        name: item.firearm.name,
        detail: joinDetail(item.firearm.manufacturer, item.firearm.model),
        href: `/vault/${item.firearm.id}`,
        // See above: a Firearm row has no quantity column and stands for one
        // physical object.
        owned: 1,
        unit: null,
        expirationDate: null,
      };
    case null:
      break;
  }

  // Either a label-only line, or — not reachable through the API, but the
  // database does not forbid it — a foreign key whose row has since gone.
  // Both must render as something rather than vanishing from a packing list.
  return {
    name: item.label?.trim() || "Untracked item",
    detail: null,
    href: null,
    owned: null as number | null,
    unit: null as string | null,
    expirationDate: null as Date | null,
  };
}

/**
 * Loads one kit with its contents grouped by source, every verdict resolved.
 *
 * THREE QUERIES, WHATEVER THE LINE COUNT — a 1-line kit and a 20-line kit
 * both issue exactly these, sequentially (SQLite here runs with
 * connection_limit=1, so `Promise.all` would only queue):
 *
 *   1. AppSettings, for the timezone and the expiry warning window.
 *   2. The kit, with all five relations included — one round trip, not one
 *      per line.
 *   3. EVERY KitItem's source keys and quantity, six columns and no `where`.
 *
 * Query 3 is the one worth explaining. "N of M assigned across kits" is a sum
 * across every kit in the database, not this one, so a per-line lookup would
 * be 20 queries for a 20-line kit. Instead the whole allocation table comes
 * back once and `allocationByItem` sums it in memory. KitItem rows are a
 * packing list, not a ledger — a few hundred at the outside, six narrow
 * columns each — so this is cheaper than the per-source-kind alternative the
 * brief budgeted for, and it is a constant rather than a function of the
 * page.
 *
 * Returns null for a missing kit so the page can `notFound()`; it throws on a
 * real database failure, which the page turns into SectionLoadError.
 */
export async function getKitDetail(id: string): Promise<KitDetail | null> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  // Never a raw `new Date()`: its UTC day is already tomorrow every evening
  // west of UTC, which reads an item expiring today as expired. Resolved ONCE
  // per request and shared by every line below, so no two badges on this page
  // can disagree about what day it is.
  const { today, warningDays, timezoneFromSetting } = resolveExpiryContext(
    settings,
    new Date(),
  );

  const kit = await prisma.kit.findUnique({
    where: { id },
    include: itemsInclude,
  });
  if (!kit) return null;

  const allocationRows = await prisma.kitItem.findMany({
    select: {
      gearId: true,
      supplyId: true,
      accessoryId: true,
      ammoStockId: true,
      firearmId: true,
      quantity: true,
    },
  });
  const allocation = allocationByItem(allocationRows);

  // Groups are built in KIT_ITEM_SOURCES order with "other" last, so the
  // blocks appear in the same order on every kit, and an empty group is
  // dropped rather than rendering a heading above nothing.
  const buckets = new Map<KitItemSourceField | "other", KitContentLine[]>();
  const expiryLines: KitExpiryLine[] = [];
  let missing = 0;
  let hasExpiryBadges = false;

  for (const item of kit.items) {
    // The SAME rule allocationByItem keys on, not a second reading of "which
    // source is this" — see allocationSourceOf.
    const source = allocationSourceOf(item);
    const field = source?.field ?? null;
    const described = describeSource(item, field);

    const allocated = source ? (allocation.get(allocationKey(source)) ?? 0) : 0;
    const lineMissing = missingQuantity(item);
    missing += lineMissing;

    const expiry = expiryStatus(described.expirationDate, today, warningDays);
    if (expiry !== "none") hasExpiryBadges = true;
    if (described.expirationDate) {
      expiryLines.push({ expirationDate: described.expirationDate });
    }

    const line: KitContentLine = {
      id: item.id,
      source: field,
      name: described.name,
      detail: described.detail,
      href: described.href,
      quantity: item.quantity,
      targetQuantity: item.targetQuantity,
      missing: lineMissing,
      unit: described.unit,
      expiry,
      expirationDate: described.expirationDate,
      allocated,
      owned: described.owned,
      overAllocated: isOverAllocated({
        allocated,
        owned: described.owned,
      }),
      notes: item.notes,
    };

    const key = field ?? "other";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(line);
    else buckets.set(key, [line]);
  }

  const groups: KitContentGroup[] = [];
  for (const field of KIT_ITEM_SOURCES) {
    const lines = buckets.get(field);
    if (lines?.length) {
      groups.push({ key: field, label: KIT_ITEM_SOURCE_LABELS[field], lines });
    }
  }
  const other = buckets.get("other");
  if (other?.length) {
    groups.push({ key: "other", label: KIT_ITEM_UNTRACKED_LABEL, lines: other });
  }

  return {
    kit: {
      id: kit.id,
      name: kit.name,
      category: kit.category,
      location: kit.location,
      notes: kit.notes,
    },
    groups,
    itemCount: kit.items.length,
    missing,
    // The same `kitExpiryRollup` the section cards use, against the same
    // `today` — one implementation of "expired", so the card and the page it
    // links to cannot disagree.
    expiry: kitExpiryRollup(expiryLines, today, warningDays),
    hasExpiryBadges,
    timezoneConfigured: timezoneFromSetting,
  };
}
