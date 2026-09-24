import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/server/auth";
import { runConfiguredDateMigration } from "@/lib/date-migration";
import { BACKUP_MODELS, REQUIRED_BACKUP_KEYS } from "@/lib/backup/models";
import {
  normalizeAccessoryNfaFields,
  normalizeFirearmNfaFields,
} from "@/lib/nfa";

type WriteDelegate = {
  deleteMany: () => Promise<unknown>;
  createMany: (args: { data: unknown[] }) => Promise<unknown>;
};

type BackupBody = { meta: { version: string } } & Record<string, unknown>;

/**
 * A backup needs `meta.version` and all 12 v1.0 keys as arrays. Only keys added
 * after v1.0 (maintenanceLogs, batteryChangeLogs, dateNormalizationAudits) may be
 * missing; they restore as empty. Any registered key that is present must be an
 * array. Restore replaces every table, so a partial payload must never pass.
 */
function isValidBackup(body: unknown): body is BackupBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  if (!b.meta || typeof (b.meta as Record<string, unknown>).version !== "string") return false;
  if (!REQUIRED_BACKUP_KEYS.every((key) => Array.isArray(b[key]))) return false;
  return BACKUP_MODELS.every(({ key }) => b[key] === undefined || Array.isArray(b[key]));
}

function isRowObject(row: unknown): row is Record<string, unknown> {
  return typeof row === "object" && row !== null && !Array.isArray(row);
}

/**
 * Re-derives the NFA group on the firearm and accessory rows of a backup.
 *
 * The spec requires the clearing rules to hold "however the write arrives",
 * and restore is a write path: it hands uploaded JSON straight to createMany
 * with no per-row validation beyond "is it an array". So a hand-edited or
 * foreign backup carrying
 * `{ nfaClass: "NONE", nfaTransferMethod: "FORM_4", nfaControlNumber: "12345" }`
 * restored exactly that, and the row then showed a full NFA card on
 * /vault/[id] and exported paperwork under a Title I platform.
 *
 * Running the same normalizers the write routes use makes the rules hold by
 * construction rather than by trusting the file. Only the NFA group is
 * touched; every other column is copied verbatim, because a restore is meant
 * to be faithful and the rows it replaces came from a database these routes
 * kept consistent.
 *
 * The SQLite→Postgres migrator deliberately does NOT do this: a faithful
 * whole-row copy is its entire job, and it verifies the rows it wrote.
 */
function normalizeNfaGroups(rows: Record<string, unknown[]>): void {
  rows.firearms = rows.firearms.map((row) =>
    isRowObject(row) ? { ...row, ...normalizeFirearmNfaFields(row) } : row
  );
  rows.accessories = rows.accessories.map((row) =>
    isRowObject(row)
      ? { ...row, ...normalizeAccessoryNfaFields(row.type, row) }
      : row
  );
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
  normalizeNfaGroups(rows);

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
