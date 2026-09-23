import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  CATEGORY_SECTIONS,
  accessoryWhereForSection,
  firearmWhereForSection,
} from "@/lib/categories";

// Counts change with every write, so never prerender or cache this.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const entries = await Promise.all(
      CATEGORY_SECTIONS.map(async (section) => {
        const firearmWhere = firearmWhereForSection(section);
        const accessoryWhere = accessoryWhereForSection(section);
        let total = 0;
        if (firearmWhere)
          total += await prisma.firearm.count({ where: firearmWhere });
        if (accessoryWhere)
          total += await prisma.accessory.count({ where: accessoryWhere });
        return [section.slug, total] as const;
      }),
    );

    // Surfaced by the Machine Guns notice: rows on the legacy SMG platform that
    // nobody has classified yet. Counted, never reclassified.
    const legacySmgCount = await prisma.firearm.count({
      where: { type: "SMG", nfaClass: "NONE" },
    });

    return NextResponse.json({
      counts: Object.fromEntries(entries),
      legacySmgCount,
    });
  } catch (error) {
    console.error("[categories/counts] failed:", error);
    // 503 so the outage notice in DatabaseStatusProvider recognises it.
    return NextResponse.json({ error: "counts unavailable" }, { status: 503 });
  }
}
