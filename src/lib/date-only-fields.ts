/**
 * The registry of which `DateTime` columns hold a calendar day rather than
 * an instant — split out of date-migration.ts into this zero-import leaf
 * module so it can be imported from a CLIENT component (src/lib/audit/summary.ts,
 * used by AuditRow/AuditList/ItemHistory) without pulling the migration
 * itself along.
 *
 * date-migration.ts has a dynamic `await import("@/lib/prisma")` — prisma.ts
 * uses `node:async_hooks` (the audit extension's AsyncLocalStorage), which
 * Turbopack's client chunking cannot resolve at all, static or dynamic
 * import; `npm run build` failed outright on
 * "the chunking context (unknown) does not support external modules" the
 * first time summary.ts imported DATE_ONLY_FIELDS straight from
 * date-migration.ts. date-migration.ts re-exports both constants from here,
 * so every existing import of them (date-migration.test.ts included) is
 * unaffected.
 */

/**
 * Every column that holds a calendar DAY rather than an instant.
 *
 * Guarded from Prisma's DMMF, not by a hand-maintained expectation:
 * date-migration.test.ts requires every `DateTime` column in the schema to
 * appear either here or in DATE_ONLY_EXCLUDED_FIELDS below, so adding a date
 * column to the schema fails the suite until somebody decides which it is.
 * Until that guard landed this list had silently fallen three columns behind
 * the schema (Supply.expirationDate, Supply.purchaseDate, Gear.acquisitionDate)
 * while its test — a hardcoded literal of the same ten names it was
 * checking — passed, which is the exact shape of the hand-maintained list
 * that caused the backup data-loss bug.
 */
// Firearm.nfaApprovalDate and Accessory.nfaApprovalDate stay registered here
// even though the field-encryption spec (docs/superpowers/specs/
// 2026-09-30-field-encryption-design.md, D1) type-changes their schema
// column from `DateTime` to `String` (src/lib/encryption/fields.ts) so
// ciphertext can live in it. Both fields are still a calendar day, not an
// instant, to every reader of this list — the audit summary's
// isDateOnlyField() (src/lib/audit/summary.ts) still needs to format a
// decrypted nfaApprovalDate as a date, not a timestamp.
// - date-migration.test.ts's schema guard counts them through the registry's
//   `kind: "date"` entries, since the DMMF no longer reports them as DateTime;
// - runLegacyDateMigration (src/lib/date-migration.ts) skips them: the
//   startup encryption migration (src/lib/encryption/startup.ts) normalises
//   them while it encrypts them.
export const DATE_ONLY_FIELDS = [
  { model: "Firearm", delegate: "firearm", field: "acquisitionDate" },
  { model: "Firearm", delegate: "firearm", field: "lastMaintenanceDate" },
  { model: "Firearm", delegate: "firearm", field: "nfaApprovalDate" },
  { model: "Accessory", delegate: "accessory", field: "acquisitionDate" },
  { model: "Accessory", delegate: "accessory", field: "lastBatteryChangeDate" },
  { model: "Accessory", delegate: "accessory", field: "nfaApprovalDate" },
  { model: "Gear", delegate: "gear", field: "acquisitionDate" },
  { model: "Gear", delegate: "gear", field: "expirationDate" },
  { model: "Supply", delegate: "supply", field: "expirationDate" },
  { model: "Supply", delegate: "supply", field: "purchaseDate" },
  { model: "AmmoStock", delegate: "ammoStock", field: "purchaseDate" },
  { model: "AmmoTransaction", delegate: "ammoTransaction", field: "purchaseDate" },
  { model: "RangeSession", delegate: "rangeSession", field: "sessionDate" },
  { model: "SessionDrill", delegate: "sessionDrill", field: "drillDate" },
  { model: "MaintenanceLog", delegate: "maintenanceLog", field: "date" },
  { model: "BatteryChangeLog", delegate: "batteryChangeLog", field: "changedAt" },
] as const;

/**
 * DateTime columns that are deliberately NOT date-only, each excluded for a
 * stated reason. The counterpart to DATE_ONLY_FIELDS: between them they must
 * account for every `DateTime` column in the schema, which is what the DMMF
 * guard in date-migration.test.ts asserts.
 *
 * Note that `@default(now())` is NOT the discriminator — BatteryChangeLog
 * .changedAt has it and IS date-only (the user picks the day a battery was
 * changed; the default is just a convenience). Each entry below is a real
 * instant because something reads its time-of-day or its ordering, not
 * because of how it is defaulted.
 */
export const DATE_ONLY_EXCLUDED_FIELDS = [
  // Row bookkeeping. Written by Prisma (@default(now()) / @updatedAt), read
  // for ordering ("recent acquisitions", "5 most recently updated"), never
  // presented as a calendar day the user chose. Converting one to local
  // midnight would reorder those lists.
  "Firearm.createdAt",
  "Firearm.updatedAt",
  "Build.createdAt",
  "Build.updatedAt",
  "Accessory.createdAt",
  "Accessory.updatedAt",
  "Gear.createdAt",
  "Gear.updatedAt",
  "Supply.createdAt",
  "Supply.updatedAt",
  "Document.createdAt",
  "Document.updatedAt",
  "AmmoStock.createdAt",
  "AmmoStock.updatedAt",
  "RangeSession.createdAt",
  "RangeSession.updatedAt",
  "RangeSessionAmmoLink.createdAt",
  "SessionDrill.createdAt",
  "AmmoTransaction.transactedAt",
  "BatteryChangeLog.createdAt",
  "MaintenanceLog.createdAt",
  "MaintenanceLog.updatedAt",
  "AppSettings.createdAt",
  "AppSettings.updatedAt",
  "DateNormalizationAudit.createdAt",
  "DateNormalizationAudit.updatedAt",
  // A log entry's own moment, not a day the user picked.
  "RoundCountLog.loggedAt",
  // Cache freshness: a true instant, compared against a TTL.
  "ImageCache.cachedAt",
  // This migration's own audit trail. `originalValue` is by definition the
  // legacy instant being preserved, and `appliedValue` is a copy of what was
  // written; normalizing either would destroy the record that lets a run with
  // a provisional zone be corrected later.
  "DateNormalizationAudit.originalValue",
  "DateNormalizationAudit.appliedValue",
  // Row bookkeeping, same reasoning as Firearm/Build/etc above: never
  // presented as a calendar day the user chose.
  "Kit.createdAt",
  "Kit.updatedAt",
  "KitItem.createdAt",
  "KitItem.updatedAt",
  // Accounts (see prisma/schema.base.prisma, model User/Session/AuthToken):
  // every one of these is a true instant that something compares or expires
  // against — never a calendar day the user picked.
  "User.createdAt",
  "User.disabledAt",
  "User.lastLoginAt",
  "Session.createdAt",
  "Session.lastSeenAt",
  "Session.expiresAt",
  "AuthToken.createdAt",
  "AuthToken.expiresAt",
  "AuthToken.usedAt",
  // The audit log's own timestamp: the moment the event happened, read for
  // ordering ("most recent activity") and never presented as a calendar day
  // the user chose.
  "AuditEvent.at",
] as const;
