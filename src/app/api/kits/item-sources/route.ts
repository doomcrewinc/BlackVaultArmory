import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { containsInsensitive } from "@/lib/db/text-search";
import {
  KIT_ITEM_SOURCES,
  KIT_ITEM_SOURCE_LABELS,
  type KitItemSourceField,
} from "@/lib/kit";
import {
  AMMO_UNIT_LABEL,
  FIREARM_OWNED_QUANTITY,
  joinKitSourceDetail,
  kitSupplyUnitLabel,
  type KitSourceGroup,
  type KitSourceResult,
} from "@/lib/kits/sourceDisplay";
import { expiryStatus, resolveExpiryContext } from "@/lib/supply";

export const dynamic = "force-dynamic";

/**
 * `GET /api/kits/item-sources?q=` — what the kit line picker searches.
 *
 * WHY THIS IS NOT `/api/search`. That endpoint was checked first, and it is
 * the right endpoint for the command palette it feeds; it is not what a
 * picker needs:
 *
 *   1. NO QUANTITY, in any of its six groups. Every `select` there lists
 *      identity columns only, so nothing in its response can say how many are
 *      owned — the number the picker shows and the number over-allocation is
 *      measured against.
 *   2. NO UNIT. A supply packed by the gallon and one packed by the box read
 *      identically in its payload.
 *   3. IT RETURNS `builds`, which is not one of KIT_ITEM_SOURCES. A KitItem
 *      cannot point at a Build, so a fifth of its groups is unpickable noise.
 *   4. ITS SHAPE IS A NAVIGATION SHAPE: `{ id, name, subtitle, url }` per
 *      group, aimed at "jump to this page". `GlobalSearch` consumes exactly
 *      that, so widening the selects to carry a quantity would change the
 *      payload of the app's global search for an unrelated consumer, and
 *      would have to invent a quantity for firearms, whose table has no such
 *      column.
 *
 * So: a purpose-built endpoint, sharing `/api/search`'s two properties that
 * matter. `containsInsensitive` (one implementation of case-insensitive
 * matching, Postgres included) and EXPLICIT NARROW SELECTS — which is why a
 * serial number has never leaked through a search response in this app, and
 * must stay true here: no `include`, no bare `findMany`.
 *
 * Route precedence: a static segment resolves before a sibling dynamic one in
 * the App Router, so `item-sources` is never swallowed by `/api/kits/[id]`.
 *
 * SEQUENTIAL QUERIES — six of them, whatever the query string: AppSettings
 * plus one per source kind. SQLite runs with connection_limit=1 here, so a
 * `Promise.all` would only queue them behind each other while making a
 * failure harder to attribute.
 */
const TAKE_PER_KIND = 8;

/** Matching the command palette: one letter is every row in the database. */
const MIN_QUERY_LENGTH = 2;

function emptyGroups(): KitSourceGroup[] {
  return [];
}

export async function GET(request: NextRequest) {
  try {
    // Not lowercased: containsInsensitive handles case on both providers.
    const q = (request.nextUrl.searchParams.get("q") ?? "").trim();

    if (q.length < MIN_QUERY_LENGTH) {
      return NextResponse.json({ groups: emptyGroups() });
    }

    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
    });
    // ONCE per request, shared by every result below, and through
    // `resolveExpiryContext` rather than a raw `new Date()` or a second
    // reading of the timezone setting — the same resolution the kit detail
    // page uses, so a supply that reads EXPIRED in the picker reads EXPIRED
    // on the line it becomes.
    const { today, warningDays } = resolveExpiryContext(settings, new Date());

    const gear = await prisma.gear.findMany({
      where: {
        OR: [
          { name: containsInsensitive(q) },
          { manufacturer: containsInsensitive(q) },
          { model: containsInsensitive(q) },
        ],
      },
      orderBy: { name: "asc" },
      take: TAKE_PER_KIND,
      select: {
        id: true,
        name: true,
        manufacturer: true,
        model: true,
        quantity: true,
        expirationDate: true,
      },
    });

    const supplies = await prisma.supply.findMany({
      where: {
        OR: [
          { name: containsInsensitive(q) },
          { brand: containsInsensitive(q) },
        ],
      },
      orderBy: { name: "asc" },
      take: TAKE_PER_KIND,
      select: {
        id: true,
        name: true,
        brand: true,
        quantity: true,
        unit: true,
        expirationDate: true,
      },
    });

    const accessories = await prisma.accessory.findMany({
      where: {
        OR: [
          { name: containsInsensitive(q) },
          { manufacturer: containsInsensitive(q) },
          { model: containsInsensitive(q) },
        ],
      },
      orderBy: { name: "asc" },
      take: TAKE_PER_KIND,
      select: {
        id: true,
        name: true,
        manufacturer: true,
        model: true,
        quantity: true,
      },
    });

    const ammoStocks = await prisma.ammoStock.findMany({
      where: {
        OR: [
          { brand: containsInsensitive(q) },
          { caliber: containsInsensitive(q) },
        ],
      },
      orderBy: { brand: "asc" },
      take: TAKE_PER_KIND,
      select: { id: true, brand: true, caliber: true, quantity: true },
    });

    // No serialNumber in this select, deliberately — see the note above.
    const firearms = await prisma.firearm.findMany({
      where: {
        OR: [
          { name: containsInsensitive(q) },
          { manufacturer: containsInsensitive(q) },
          { model: containsInsensitive(q) },
        ],
      },
      orderBy: { name: "asc" },
      take: TAKE_PER_KIND,
      select: { id: true, name: true, manufacturer: true, model: true },
    });

    // A Record keyed by the source field, so a sixth entry added to
    // KIT_ITEM_SOURCES is a tsc error here rather than a source kind the
    // picker silently cannot offer.
    const byField: Record<KitItemSourceField, KitSourceResult[]> = {
      gearId: gear.map((row) => ({
        field: "gearId" as const,
        id: row.id,
        name: row.name,
        detail: joinKitSourceDetail(row.manufacturer, row.model),
        owned: row.quantity,
        unit: null,
        expiry: expiryStatus(row.expirationDate, today, warningDays),
      })),
      supplyId: supplies.map((row) => ({
        field: "supplyId" as const,
        id: row.id,
        name: row.name,
        detail: row.brand,
        owned: row.quantity,
        unit: kitSupplyUnitLabel(row.unit),
        expiry: expiryStatus(row.expirationDate, today, warningDays),
      })),
      accessoryId: accessories.map((row) => ({
        field: "accessoryId" as const,
        id: row.id,
        name: row.name,
        detail: joinKitSourceDetail(row.manufacturer, row.model),
        owned: row.quantity,
        unit: null,
        // Accessory carries no expirationDate column: no badge, rather than
        // a reassuring "fine" the table cannot support.
        expiry: "none" as const,
      })),
      ammoStockId: ammoStocks.map((row) => ({
        field: "ammoStockId" as const,
        id: row.id,
        name: `${row.brand} ${row.caliber}`,
        detail: null,
        owned: row.quantity,
        unit: AMMO_UNIT_LABEL,
        expiry: "none" as const,
      })),
      firearmId: firearms.map((row) => ({
        field: "firearmId" as const,
        id: row.id,
        name: row.name,
        detail: joinKitSourceDetail(row.manufacturer, row.model),
        // A Firearm row is one physical object and has no quantity column.
        owned: FIREARM_OWNED_QUANTITY,
        unit: null,
        expiry: "none" as const,
      })),
    };

    // KIT_ITEM_SOURCES order, and an empty kind is dropped rather than
    // rendering a heading above nothing — the same rule getKitDetail's groups
    // follow, so the picker's blocks and the packed list's blocks appear in
    // the same order.
    const groups: KitSourceGroup[] = [];
    for (const field of KIT_ITEM_SOURCES) {
      const results = byField[field];
      if (results.length > 0) {
        groups.push({
          field,
          label: KIT_ITEM_SOURCE_LABELS[field],
          results,
        });
      }
    }

    return NextResponse.json({ groups });
  } catch (error) {
    console.error("GET /api/kits/item-sources error:", error);
    return NextResponse.json(
      { error: "Failed to search inventory" },
      { status: 500 },
    );
  }
}
