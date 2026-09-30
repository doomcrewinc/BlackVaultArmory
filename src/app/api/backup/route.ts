import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/server/auth";
import { BACKUP_MODELS } from "@/lib/backup/models";
import { recordEventBestEffort } from "@/lib/audit/events";
import fs from "fs";
import path from "path";

type ReadDelegate = { findMany: () => Promise<unknown[]> };
const delegates = prisma as unknown as Record<string, ReadDelegate>;

export async function POST() {
  const auth = await requireAdmin();
  if (auth) return auth;

  try {
    // Sequential queries — connection_limit=1 means Promise.all would deadlock
    const backupData: Record<string, unknown[]> = {};
    for (const { delegate, key } of BACKUP_MODELS) {
      backupData[key] = await delegates[delegate].findMany();
    }
    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

    const meta = {
      version: "1.1",
      createdAt: now.toISOString(),
      includeUploads: settings?.includeUploadsInBackup ?? true,
      counts: Object.fromEntries(Object.entries(backupData).map(([k, v]) => [k, v.length])),
    };

    const payload = { meta, ...backupData };
    const json = JSON.stringify(payload, null, 2);
    const sizeMB = (Buffer.byteLength(json, "utf8") / 1_048_576).toFixed(2);

    const filename = `blackvault-backup-${timestamp}.json`;

    // Optional server-side save — non-fatal if it fails
    let savedToPath: string | undefined;
    if (settings?.backupDestinationPath) {
      try {
        const destDir = settings.backupDestinationPath;
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        const fullPath = path.join(destDir, filename);
        fs.writeFileSync(fullPath, json, "utf8");
        savedToPath = fullPath;
      } catch (fsErr) {
        console.warn("Could not write backup to disk:", fsErr);
      }
    }

    await recordEventBestEffort(null, { action: "BACKUP_CREATED", entityLabel: filename, changes: { file: filename } });

    return NextResponse.json({
      success: true,
      filename,
      meta,
      data: backupData,
      savedToPath,
      sizeMB,
    });
  } catch (error) {
    console.error("POST /api/backup error:", error);
    return NextResponse.json({ error: "Failed to generate backup" }, { status: 500 });
  }
}
