import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
  gearWhereForSection,
  kitWhereForSection,
  sectionSources,
  supplyWhereForSection,
} from "@/lib/categories";

// Counts change with every write, so never prerender or cache this.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Sequential queries — connection_limit=1 means Promise.all would deadlock
    const counts: Record<string, number> = {};
    for (const section of CATEGORY_SECTIONS) {
      let total = 0;
      // Walks the section's own declared kinds, with a `never` guard, rather
      // than probing a hand-listed set of where-builders. The old shape was
      // four unguarded `if`s over firearm/accessory/gear/supply, and phase
      // 6's `kit` source walked straight past it: every kits count would have
      // been 0 forever — a nav badge reading "0" beside a section full of
      // kits, with nothing failing. `sectionSources` reports declaration
      // order, which for every registered section is the same order the four
      // `if`s ran in, so the counts themselves are unchanged.
      for (const kind of sectionSources(section)) {
        switch (kind) {
          case "firearm": {
            const where = firearmWhereForSection(section);
            if (where) total += await prisma.firearm.count({ where });
            break;
          }
          case "accessory": {
            const where = accessoryWhereForSection(section);
            if (where) total += await prisma.accessory.count({ where });
            break;
          }
          case "gear": {
            const where = gearWhereForSection(section);
            if (where) total += await prisma.gear.count({ where });
            break;
          }
          case "supply": {
            const where = supplyWhereForSection(section);
            if (where) total += await prisma.supply.count({ where });
            break;
          }
          case "kit": {
            // `{}` — every kit, by spec. Truthy, so the count runs; see
            // UNFILTERED_SECTION_SOURCES in categories.ts.
            const where = kitWhereForSection(section);
            if (where) total += await prisma.kit.count({ where });
            break;
          }
          default: {
            const unhandled: never = kind;
            throw new Error(`Unhandled section source: ${String(unhandled)}`);
          }
        }
      }
      counts[section.slug] = total;
    }

    // Surfaced by the Machine Guns notice: rows on the legacy SMG platform that
    // nobody has classified yet. Counted, never reclassified.
    const legacySmgCount = await prisma.firearm.count({
      where: { type: "SMG", nfaClass: "NONE" },
    });

    return NextResponse.json({ counts, legacySmgCount });
  } catch (error) {
    console.error("[categories/counts] failed:", error);
    // 503 so the outage notice in DatabaseStatusProvider recognises it.
    return NextResponse.json({ error: "counts unavailable" }, { status: 503 });
  }
}
