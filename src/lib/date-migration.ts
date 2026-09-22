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
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
}

type Delegate = {
  findMany: (args?: unknown) => Promise<Array<Record<string, unknown> & { id: string }>>;
  update: (args: unknown) => Promise<unknown>;
};

export async function runLegacyDateMigration(
  prisma: PrismaClient,
  zone: string
): Promise<MigrationSummary> {
  const summary: MigrationSummary = { zone, normalized: 0, reconverted: 0, skippedEdited: 0 };
  const client = prisma as unknown as Record<string, Delegate> & {
    $transaction: (ops: unknown[]) => Promise<unknown>;
    dateNormalizationAudit: Delegate & { create: (args: unknown) => Promise<unknown> };
  };
  const audit = client.dateNormalizationAudit;

  for (const { model, delegate, field } of DATE_ONLY_FIELDS) {
    const table = client[delegate];
    const rows = await table.findMany({ select: { id: true, [field]: true } });
    const audits = (await audit.findMany({ where: { model, field } })) as Array<{
      id: string;
      recordId: string;
      originalValue: Date;
      appliedValue: Date;
      appliedZone: string;
    }>;
    const auditByRecord = new Map(audits.map((a) => [a.recordId, a]));

    for (const row of rows) {
      const value = row[field] as Date | null;
      if (!value) continue;
      const existing = auditByRecord.get(row.id);

      if (existing) {
        // Re-conversion: only when the zone changed, and only while the row
        // still holds what the migration wrote. A user edit always wins.
        if (existing.appliedZone === zone) continue;
        if (value.getTime() !== new Date(existing.appliedValue).getTime()) {
          summary.skippedEdited++;
          continue;
        }
        const next = normalizeInstant(new Date(existing.originalValue), zone);
        // These calls must stay un-awaited: $transaction receives the pending
        // queries and runs them atomically. Awaiting either one here would
        // execute it eagerly, outside the transaction, and break reversibility.
        await client.$transaction([
          table.update({ where: { id: row.id }, data: { [field]: next } }),
          audit.update({
            where: { id: existing.id },
            data: { appliedValue: next, appliedZone: zone },
          }),
        ]);
        summary.reconverted++;
        continue;
      }

      if (value.getTime() % DAY_MS === 0) continue; // already date-only

      const next = normalizeInstant(value, zone);
      // These calls must stay un-awaited: $transaction receives the pending
      // queries and runs them atomically. Awaiting either one here would
      // execute it eagerly, outside the transaction, and break reversibility.
      await client.$transaction([
        audit.create({
          data: {
            model,
            field,
            recordId: row.id,
            originalValue: value,
            appliedValue: next,
            appliedZone: zone,
          },
        }),
        table.update({ where: { id: row.id }, data: { [field]: next } }),
      ]);
      summary.normalized++;
    }
  }

  return summary;
}

/** Runs at server start. Never throws: a failure must not block the app. */
export async function runStartupDateMigration(): Promise<void> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
    const configured = settings?.timezone;
    const zone = configured && isValidTimeZone(configured) ? configured : "UTC";
    const summary = await runLegacyDateMigration(prisma, zone);
    if (summary.normalized || summary.reconverted || summary.skippedEdited) {
      console.log(
        `[date-migration] zone=${zone} normalized=${summary.normalized} ` +
          `reconverted=${summary.reconverted} skippedEdited=${summary.skippedEdited}`
      );
    }
    if (!configured && summary.normalized) {
      console.log(
        "[date-migration] No timezone set; used UTC provisionally. " +
          "Set your timezone in Settings to correct these dates."
      );
    }
  } catch (error) {
    console.error("[date-migration] failed; the server will continue:", error);
  }
}
