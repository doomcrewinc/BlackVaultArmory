import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { uploadsRoot } from "@/lib/files/storage";

const IMAGE_FOLDERS = ["firearms", "accessories", "ammo", "builds"];

/**
 * Staging/migration artifacts that are never real images: a write in
 * progress (`.tmp`), rotation staging (`.rot`), or a pre-encryption snapshot
 * directory (`.pre-encryption-*`, which would only ever appear misplaced
 * here, but is excluded defensively all the same).
 */
function isStagingOrSnapshotEntry(name: string): boolean {
  return name.endsWith(".tmp") || name.endsWith(".rot") || name.startsWith(".pre-encryption-");
}

export async function GET() {
  try {
    const root = path.join(uploadsRoot(), "images");
    const images = [] as Array<{ id: string; url: string; folder: string; updatedAt: string }>;

    for (const folder of IMAGE_FOLDERS) {
      const dir = path.join(root, folder);
      await fs.mkdir(dir, { recursive: true });
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (isStagingOrSnapshotEntry(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        const stat = await fs.stat(filePath);
        images.push({
          id: `${folder}/${entry.name}`,
          url: `/uploads/images/${folder}/${entry.name}`,
          folder,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }

    images.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return NextResponse.json({ images });
  } catch (error) {
    console.error("GET /api/images/library error:", error);
    return NextResponse.json({ error: "Failed to load image library" }, { status: 500 });
  }
}
