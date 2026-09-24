import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
  gearWhereForSection,
  supplyWhereForSection,
} from "@/lib/categories";

// Counts change with every write, so never prerender or cache this.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // Sequential queries — connection_limit=1 means Promise.all would deadlock
    const counts: Record<string, number> = {};
    for (const section of CATEGORY_SECTIONS) {
      const firearmWhere = firearmWhereForSection(section);
      const accessoryWhere = accessoryWhereForSection(section);
      const gearWhere = gearWhereForSection(section);
      const supplyWhere = supplyWhereForSection(section);
      let total = 0;
      if (firearmWhere)
        total += await prisma.firearm.count({ where: firearmWhere });
      if (accessoryWhere)
        total += await prisma.accessory.count({ where: accessoryWhere });
      if (gearWhere) total += await prisma.gear.count({ where: gearWhere });
      if (supplyWhere)
        total += await prisma.supply.count({ where: supplyWhere });
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
