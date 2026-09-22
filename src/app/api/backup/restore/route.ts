import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/server/auth";
import { runConfiguredDateMigration } from "@/lib/date-migration";
import { BACKUP_MODELS } from "@/lib/backup/models";

type WriteDelegate = {
  deleteMany: () => Promise<unknown>;
  createMany: (args: { data: unknown[] }) => Promise<unknown>;
};

type BackupBody = { meta: { version: string } } & Record<string, unknown>;

/**
 * A backup needs `meta.version` and at least one registered key. Every registered key
 * that is present must be an array; a missing key (e.g. a v1.0 backup predating
 * MaintenanceLog) restores as empty.
 */
function isValidBackup(body: unknown): body is BackupBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (!b.meta || typeof (b.meta as Record<string, unknown>).version !== "string") return false;
  const present = BACKUP_MODELS.filter(({ key }) => b[key] !== undefined);
  return present.length > 0 && present.every(({ key }) => Array.isArray(b[key]));
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (auth) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!isValidBackup(body)) {
    return NextResponse.json(
      { error: "Invalid backup file. Missing required fields or wrong format." },
      { status: 400 }
    );
  }

  const rows: Record<string, unknown[]> = Object.fromEntries(
    BACKUP_MODELS.map(({ key }) => [key, (body[key] as unknown[] | undefined) ?? []])
  );

  try {
    await prisma.$transaction(
      async (tx) => {
        const delegates = tx as unknown as Record<string, WriteDelegate>;
        // Sequential throughout — SQLite connection_limit=1 deadlocks on Promise.all.
        // Delete children before parents (registry reversed), then insert parent-first.
        // AppSettings is not in the registry, so it is never touched — preserves LAN/path config.
        for (const { delegate } of [...BACKUP_MODELS].reverse()) {
          await delegates[delegate].deleteMany();
        }
        for (const { delegate, key } of BACKUP_MODELS) {
          if (rows[key].length) await delegates[delegate].createMany({ data: rows[key] });
        }
      },
      { timeout: 30000 }
    );
  } catch (error) {
    console.error("POST /api/backup/restore error:", error);
    return NextResponse.json(
      { error: "Restore failed. Your data has not been modified." },
      { status: 500 }
    );
  }

  // A pre-upgrade backup brings legacy date-only values back; normalize them now
  // rather than at the next restart. The restore has already succeeded, so a
  // migration failure is only logged and never changes the response.
  try {
    await runConfiguredDateMigration("restore");
  } catch (error) {
    console.error("[date-migration] failed after restore:", error);
  }

  return NextResponse.json({
    success: true,
    counts: Object.fromEntries(BACKUP_MODELS.map(({ key }) => [key, rows[key].length])),
  });
}
