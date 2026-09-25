import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/server/auth";
import { runConfiguredDateMigration } from "@/lib/date-migration";
import { BACKUP_MODELS, REQUIRED_BACKUP_KEYS } from "@/lib/backup/models";
import {
  isKnownNfaClass,
  normalizeAccessoryNfaFields,
  normalizeFirearmNfaFields,
} from "@/lib/nfa";
import { normalizeGearArmorFields } from "@/lib/gear";

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
 *
 * A firearm whose stored class is not one THIS BUILD KNOWS is passed through
 * untouched, class and paperwork alike. Normalizing it would coerce the class
 * to NONE and take mgRegistry and all five paperwork columns with it —
 * silently, on a data-recovery path, which is exactly the outcome the write
 * routes now answer 400 for rather than perform. And it is not a
 * hand-edited-file scenario: a backup written by a later build that added an
 * NFA class is the case src/lib/categories.ts's catch-all section documents
 * and deliberately accommodates ("a backup written by a later version that
 * added a class this build lacks"). Phase 1 chose "visible in the wrong-ish
 * place" over "silently altered"; restore now agrees with it. Backups whose
 * classes this build understands are still normalized, which is the hole this
 * function was written to close.
 */
function normalizeNfaGroups(rows: Record<string, unknown[]>): void {
  rows.firearms = rows.firearms.map((row) => {
    if (!isRowObject(row)) return row;
    const classIsPresent = row.nfaClass !== undefined && row.nfaClass !== null;
    if (classIsPresent && !isKnownNfaClass(row.nfaClass)) return row;
    return { ...row, ...normalizeFirearmNfaFields(row) };
  });
  rows.accessories = rows.accessories.map((row) =>
    isRowObject(row)
      ? { ...row, ...normalizeAccessoryNfaFields(row.type, row) }
      : row
  );
}

/**
 * Re-derives the armor group (`protectionLevel`, `armorSize`) on the gear rows
 * of a backup, for the same reason and by the same rule as normalizeNfaGroups
 * above: restore is an unvalidated write path, and the clearing rules have to
 * hold however the write arrives. Without this, a hand-edited backup restores
 * `{ category: "KNIFE", protectionLevel: "IV" }` — invisible on the detail
 * page, which gates the cells on the category, and PRINTED by the full-armory
 * export, which deliberately does not.
 *
 * `body: {}` means "change nothing, just re-decide": the merged category is
 * the row's own stored category, so this only ever clears, never writes a
 * rating the file did not carry.
 *
 * WHO decides "this build does not understand this category" is
 * normalizeGearArmorFields, not this function. Its gate already passes an
 * unrecognised category through untouched, and that single judgement is the
 * one the write routes use, so restore cannot drift into a second, stricter
 * copy of the rule — the mistake an earlier phase of this epic made with the
 * NFA class, silently declassifying firearms whose class came from a later
 * build. A non-string category is likewise handed back unchanged: it is not
 * something this build can judge either.
 */
function normalizeGearArmorGroups(rows: Record<string, unknown[]>): void {
  rows.gear = rows.gear.map((row) => {
    if (!isRowObject(row) || typeof row.category !== "string") return row;
    return {
      ...row,
      ...normalizeGearArmorFields({
        existing: {
          category: row.category,
          protectionLevel:
            typeof row.protectionLevel === "string" ? row.protectionLevel : null,
          armorSize: typeof row.armorSize === "string" ? row.armorSize : null,
        },
        body: {},
      }),
    };
  });
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
  normalizeGearArmorGroups(rows);

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
