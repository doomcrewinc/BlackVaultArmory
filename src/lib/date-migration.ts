/**
 * Converts date-only values the old code stored as true instants into the
 * calendar day their author meant.
 *
 * Before the date-only fix, some writers stored `new Date()` into date-only
 * fields. The old browser-local display made those rows look right to their
 * author; pinning display to UTC shifts them. This migration re-expresses each
 * such instant as UTC midnight of its calendar day in the owner's timezone.
 *
 * Every write after the fix goes through toDateOnlyUTC(), so a value NOT at
 * exact UTC midnight can only be legacy — detection is exact and idempotent.
 *
 * Every original is recorded in DateNormalizationAudit before it is changed, so
 * a run with a provisional zone (UTC) can later be corrected from the originals.
 */
import type { PrismaClient } from "@prisma/client";

const DAY_MS = 86_400_000;

/**
 * Audit sentinel: the user has edited this row since the migration wrote it,
 * so it is theirs now and must never be re-converted. Not a valid IANA zone,
 * so it can never equal a real one.
 */
export const USER_EDITED = "user-edited";

export const DATE_ONLY_FIELDS = [
  { model: "Firearm", delegate: "firearm", field: "acquisitionDate" },
  { model: "Firearm", delegate: "firearm", field: "lastMaintenanceDate" },
  { model: "Accessory", delegate: "accessory", field: "acquisitionDate" },
  { model: "Accessory", delegate: "accessory", field: "lastBatteryChangeDate" },
  { model: "AmmoStock", delegate: "ammoStock", field: "purchaseDate" },
  { model: "AmmoTransaction", delegate: "ammoTransaction", field: "purchaseDate" },
  { model: "RangeSession", delegate: "rangeSession", field: "sessionDate" },
  { model: "SessionDrill", delegate: "sessionDrill", field: "drillDate" },
  { model: "MaintenanceLog", delegate: "maintenanceLog", field: "date" },
  { model: "BatteryChangeLog", delegate: "batteryChangeLog", field: "changedAt" },
] as const;

export interface MigrationSummary {
  zone: string;
  normalized: number;
  reconverted: number;
  skippedEdited: number;
  /** Rows that changed between read and write (e.g. an edit from another device); left alone. */
  skippedConcurrent: number;
  /** Rows whose processing threw; logged and left for the next run. */
  failed: number;
}

export function isValidTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** UTC midnight of `instant`'s calendar day as seen in `zone`. */
export function normalizeInstant(instant: Date, zone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // Not Date.UTC: it maps years 0-99 into the 1900s.
  const d = new Date(0);
  d.setUTCFullYear(part("year"), part("month") - 1, part("day"));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

type Delegate = {
  findMany: (args?: unknown) => Promise<Array<Record<string, unknown> & { id: string }>>;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
  create: (args: unknown) => Promise<unknown>;
};

type Client = Record<string, Delegate> & {
  $transaction: <T>(fn: (tx: Record<string, Delegate>) => Promise<T>) => Promise<T>;
};

type Audit = {
  id: string;
  recordId: string;
  originalValue: Date;
  appliedValue: Date;
  appliedZone: string;
};

type Outcome = "normalized" | "reconverted" | "skippedEdited" | "skippedConcurrent" | null;

export async function runLegacyDateMigration(
  prisma: PrismaClient,
  zone: string
): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    zone,
    normalized: 0,
    reconverted: 0,
    skippedEdited: 0,
    skippedConcurrent: 0,
    failed: 0,
  };
  const client = prisma as unknown as Client;

  for (const { model, delegate, field } of DATE_ONLY_FIELDS) {
    const rows = await client[delegate].findMany({ select: { id: true, [field]: true } });
    const audits = (await client.dateNormalizationAudit.findMany({
      where: { model, field },
    })) as unknown as Audit[];
    const auditByRecord = new Map(audits.map((a) => [a.recordId, a]));

    for (const row of rows) {
      const value = row[field] as Date | null;
      if (!value) continue;
      const existing = auditByRecord.get(row.id);

      /**
       * Writes `next` only if the row still holds `value`, the value we read, then
       * runs `onWritten` (the audit write) in the same transaction. If the row
       * changed under us - an edit saved from another device - nothing is
       * written and it is left for the user.
       */
      const writeIfUnchanged = (
        next: Date,
        onWritten: (tx: Record<string, Delegate>) => Promise<unknown>
      ) =>
        client.$transaction(async (tx) => {
          const { count } = await tx[delegate].updateMany({
            where: { id: row.id, [field]: value },
            data: { [field]: next },
          });
          if (count !== 1) return false;
          await onWritten(tx);
          return true;
        });

      try {
        let outcome: Outcome = null;

        if (existing && value.getTime() % DAY_MS !== 0) {
          // A non-midnight value is always legacy (every current writer stores UTC
          // midnight), so this is not a user edit: a pre-upgrade backup was restored
          // over an audited row. Normalize it afresh from the value now in the row,
          // and reset the audit to it - even if the row had been released.
          const next = normalizeInstant(value, zone);
          const written = await writeIfUnchanged(next, (tx) =>
            tx.dateNormalizationAudit.update({
              where: { id: existing.id },
              data: { originalValue: value, appliedValue: next, appliedZone: zone },
            })
          );
          outcome = written ? "normalized" : "skippedConcurrent";
        } else if (existing) {
          if (existing.appliedZone === USER_EDITED) continue; // released to the user, permanently
          // Re-conversion: only when the zone changed, and only while the row
          // still holds what the migration wrote. A user edit always wins.
          if (existing.appliedZone === zone) continue;
          if (value.getTime() !== new Date(existing.appliedValue).getTime()) {
            // The user changed it after migration. Release the row so no later run can
            // re-convert it - even if they edit it back to the value we once wrote.
            await client.dateNormalizationAudit.update({
              where: { id: existing.id },
              data: { appliedZone: USER_EDITED },
            });
            outcome = "skippedEdited";
          } else {
            const next = normalizeInstant(new Date(existing.originalValue), zone);
            const written = await writeIfUnchanged(next, (tx) =>
              tx.dateNormalizationAudit.update({
                where: { id: existing.id },
                data: { appliedValue: next, appliedZone: zone },
              })
            );
            outcome = written ? "reconverted" : "skippedConcurrent";
          }
        } else {
          if (value.getTime() % DAY_MS === 0) continue; // already date-only
          const next = normalizeInstant(value, zone);
          const written = await writeIfUnchanged(next, (tx) =>
            tx.dateNormalizationAudit.create({
              data: {
                model,
                field,
                recordId: row.id,
                originalValue: value,
                appliedValue: next,
                appliedZone: zone,
              },
            })
          );
          outcome = written ? "normalized" : "skippedConcurrent";
        }

        if (outcome) summary[outcome]++;
      } catch (error) {
        // One bad row must not abort the run; it is retried on the next one.
        console.error(`[date-migration] row failed: ${model}.${field} ${row.id}:`, error);
        summary.failed++;
      }
    }
  }

  return summary;
}

/**
 * Runs the migration with the configured zone, or UTC provisionally when none
 * is set; skips it when the configured zone is invalid. Never throws: a failure
 * must not block the caller.
 */
export async function runConfiguredDateMigration(trigger: string): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
    const configured = settings?.timezone;
    // Only a genuinely unset zone falls back to UTC. A set-but-invalid zone would
    // otherwise convert every legacy row to UTC days under a zone the user never chose.
    if (configured && !isValidTimeZone(configured)) {
      console.log(`[date-migration] configured timezone "${configured}" is invalid; skipping migration`);
      return;
    }
    const zone = configured || "UTC";
    const summary = await runLegacyDateMigration(prisma, zone);
    if (
      summary.normalized ||
      summary.reconverted ||
      summary.skippedEdited ||
      summary.skippedConcurrent ||
      summary.failed
    ) {
      console.log(
        `[date-migration] trigger=${trigger} zone=${zone} normalized=${summary.normalized} ` +
          `reconverted=${summary.reconverted} skippedEdited=${summary.skippedEdited} ` +
          `skippedConcurrent=${summary.skippedConcurrent} failed=${summary.failed}`
      );
    }
    if (!configured && summary.normalized) {
      console.log(
        "[date-migration] No timezone set; used UTC provisionally. " +
          "Set your timezone in Settings to correct these dates."
      );
    }
  } catch (error) {
    console.error(`[date-migration] ${trigger} run failed; continuing:`, error);
  }
}

/** Runs at server start. Never throws: a failure must not block the app. */
export async function runStartupDateMigration(): Promise<void> {
  await runConfiguredDateMigration("startup");
}
