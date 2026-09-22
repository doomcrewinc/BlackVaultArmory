/**
 * The single list of models that backup exports and restore replaces.
 *
 * Why this exists: backup and restore used to each keep their own hand-written
 * table list. When MaintenanceLog and BatteryChangeLog were added to the schema,
 * neither list was updated — so backups silently omitted them, and restore
 * (which deletes Firearm and Accessory) cascade-deleted every maintenance and
 * battery record while reporting success. Both routes now iterate this registry,
 * and models.test.ts fails if any schema model is neither registered here nor
 * explicitly excluded below.
 */
export interface BackupModel {
  /** Prisma model name, as in the schema. */
  model: string;
  /** Prisma client delegate (camelCase model name). */
  delegate: string;
  /** Key the rows are stored under in the backup payload. */
  key: string;
}

/** Parent-first. Restore inserts in this order and deletes in reverse. */
export const BACKUP_MODELS: BackupModel[] = [
  { model: "Firearm", delegate: "firearm", key: "firearms" },
  { model: "Accessory", delegate: "accessory", key: "accessories" },
  { model: "AmmoStock", delegate: "ammoStock", key: "ammoStocks" },
  { model: "Build", delegate: "build", key: "builds" },
  { model: "BuildSlot", delegate: "buildSlot", key: "buildSlots" },
  { model: "Document", delegate: "document", key: "documents" },
  { model: "ImageCache", delegate: "imageCache", key: "imageCache" },
  { model: "RangeSession", delegate: "rangeSession", key: "rangeSessions" },
  { model: "RangeSessionAmmoLink", delegate: "rangeSessionAmmoLink", key: "rangeSessionAmmoLinks" },
  { model: "AmmoTransaction", delegate: "ammoTransaction", key: "ammoTransactions" },
  { model: "RoundCountLog", delegate: "roundCountLog", key: "roundCountLogs" },
  { model: "SessionDrill", delegate: "sessionDrill", key: "sessionDrills" },
  { model: "MaintenanceLog", delegate: "maintenanceLog", key: "maintenanceLogs" },
  { model: "BatteryChangeLog", delegate: "batteryChangeLog", key: "batteryChangeLogs" },
  { model: "DateNormalizationAudit", delegate: "dateNormalizationAudit", key: "dateNormalizationAudits" },
];

/**
 * The first 12 registry entries are the v1.0 backup format and must be present
 * in every restore payload. Only models added after v1.0 (appended after these)
 * may be missing from an older backup. Without this, a truncated file holding
 * just `firearms` would wipe every other table and report success.
 */
export const BACKUP_V1_0_MODEL_COUNT = 12;

/** Keys every restore payload must carry as arrays. */
export const REQUIRED_BACKUP_KEYS: readonly string[] = BACKUP_MODELS.slice(0, BACKUP_V1_0_MODEL_COUNT).map(
  ({ key }) => key,
);

/** AppSettings is excluded: restore must not clobber local LAN host, paths, keys, or timezone. */
export const BACKUP_EXCLUDED_MODELS: readonly string[] = ["AppSettings"];
