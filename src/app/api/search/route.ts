import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { containsInsensitive } from "@/lib/db/text-search";
import { GEAR_CATEGORY_LABELS, type GearCategory } from "@/lib/gear";
import {
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  type SupplyCategory,
} from "@/lib/supply";

function gearCategoryLabel(category: string): string {
  return GEAR_CATEGORY_LABELS[category as GearCategory] ?? category;
}

function supplyCategoryLabel(category: string): string {
  return SUPPLY_CATEGORY_LABELS[category as SupplyCategory] ?? category;
}

/**
 * The categories whose HUMAN LABEL matches `q`, for a `category: { in: [...] }`
 * clause.
 *
 * Needed because the column stores the token and the whole app displays the
 * label: "cbrn filter" is what the list badge, the detail page, the export and
 * this endpoint's own subtitle all show, but the stored value is
 * `CBRN_FILTER`, so a substring match against the column found nothing. The
 * comparison runs in JS over an 11-entry enum rather than in SQL, which also
 * keeps it provider-independent.
 *
 * The substring clause on the column stays alongside this, and is not
 * redundant: a restore inserts supply rows unvalidated, so a category outside
 * the enum (`SHELTER`) can be stored and has no label to match here.
 */
function supplyCategoriesMatchingLabel(q: string): SupplyCategory[] {
  const needle = q.toLowerCase();
  return SUPPLY_CATEGORIES.filter((category) =>
    SUPPLY_CATEGORY_LABELS[category].toLowerCase().includes(needle),
  );
}

export async function GET(request: NextRequest) {
  const rawQ = request.nextUrl.searchParams.get("q") ?? "";
  // Not lowercased: containsInsensitive handles case on both providers.
  const q = rawQ.trim();

  const empty = { firearms: [], accessories: [], ammo: [], builds: [], gear: [], supplies: [] };

  if (q.length < 2) {
    return NextResponse.json(empty);
  }

  // Sequential queries — SQLite connection_limit=1
  const firearms = await prisma.firearm.findMany({
    where: {
      OR: [
        { name: containsInsensitive(q) },
        { manufacturer: containsInsensitive(q) },
        { model: containsInsensitive(q) },
        { caliber: containsInsensitive(q) },
      ],
    },
    take: 5,
    select: { id: true, name: true, manufacturer: true, model: true, caliber: true, type: true },
  });

  const accessories = await prisma.accessory.findMany({
    where: {
      OR: [
        { name: containsInsensitive(q) },
        { manufacturer: containsInsensitive(q) },
        { model: containsInsensitive(q) },
        { type: containsInsensitive(q) },
      ],
    },
    take: 5,
    select: { id: true, name: true, manufacturer: true, type: true },
  });

  const ammoStocks = await prisma.ammoStock.findMany({
    where: {
      OR: [
        { brand: containsInsensitive(q) },
        { caliber: containsInsensitive(q) },
        { bulletType: containsInsensitive(q) },
      ],
    },
    take: 5,
    select: { id: true, brand: true, caliber: true, grainWeight: true },
  });

  const builds = await prisma.build.findMany({
    where: { name: containsInsensitive(q) },
    take: 5,
    select: { id: true, name: true, firearmId: true },
  });

  const gear = await prisma.gear.findMany({
    where: {
      OR: [
        { name: containsInsensitive(q) },
        { manufacturer: containsInsensitive(q) },
        { model: containsInsensitive(q) },
        { category: containsInsensitive(q) },
      ],
    },
    take: 5,
    select: { id: true, name: true, manufacturer: true, model: true, category: true },
  });

  const supplyCategoryMatches = supplyCategoriesMatchingLabel(q);
  const supplies = await prisma.supply.findMany({
    where: {
      OR: [
        { name: containsInsensitive(q) },
        { brand: containsInsensitive(q) },
        // The spec asked for notes; they were never searched.
        { notes: containsInsensitive(q) },
        { category: containsInsensitive(q) },
        // Only when something matched: an empty `in` would match no row,
        // which is harmless but noise in the query the tests assert on.
        ...(supplyCategoryMatches.length > 0
          ? [{ category: { in: supplyCategoryMatches } }]
          : []),
      ],
    },
    take: 5,
    select: { id: true, name: true, brand: true, category: true },
  });

  return NextResponse.json({
    firearms: firearms.map((f) => ({
      id: f.id,
      name: f.name,
      subtitle: `${f.manufacturer} · ${f.caliber}`,
      url: `/vault/${f.id}`,
    })),
    accessories: accessories.map((a) => ({
      id: a.id,
      name: a.name,
      subtitle: `${a.manufacturer} · ${a.type}`,
      url: `/accessories/${a.id}`,
    })),
    ammo: ammoStocks.map((a) => ({
      id: a.id,
      name: `${a.brand} ${a.caliber}`,
      subtitle: a.grainWeight ? `${a.grainWeight}gr` : a.caliber,
      url: `/ammo`,
    })),
    builds: builds.map((b) => ({
      id: b.id,
      name: b.name,
      subtitle: "Build",
      url: `/vault/${b.firearmId}`,
    })),
    gear: gear.map((g) => ({
      id: g.id,
      name: g.name,
      subtitle: g.manufacturer
        ? `${g.manufacturer} · ${gearCategoryLabel(g.category)}`
        : gearCategoryLabel(g.category),
      url: `/gear/item/${g.id}`,
    })),
    supplies: supplies.map((s) => ({
      id: s.id,
      name: s.name,
      subtitle: s.brand
        ? `${s.brand} · ${supplyCategoryLabel(s.category)}`
        : supplyCategoryLabel(s.category),
      url: `/supplies/item/${s.id}`,
    })),
  });
}
