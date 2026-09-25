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
  { model: "Gear", delegate: "gear", key: "gear" },
  { model: "Supply", delegate: "supply", key: "supplies" },
  { model: "Build", delegate: "build", key: "builds" },
  { model: "BuildSlot", delegate: "buildSlot", key: "buildSlots" },
  { model: "Document", delegate: "document", key: "documents" },
  { model: "ImageCache", delegate: "imageCache", key: "imageCache" },
  { model: "RangeSession", delegate: "rangeSession", key: "rangeSessions" },
  {
    model: "RangeSessionAmmoLink",
    delegate: "rangeSessionAmmoLink",
    key: "rangeSessionAmmoLinks",
  },
  {
    model: "AmmoTransaction",
    delegate: "ammoTransaction",
    key: "ammoTransactions",
  },
  { model: "RoundCountLog", delegate: "roundCountLog", key: "roundCountLogs" },
  { model: "SessionDrill", delegate: "sessionDrill", key: "sessionDrills" },
  {
    model: "MaintenanceLog",
    delegate: "maintenanceLog",
    key: "maintenanceLogs",
  },
  {
    model: "BatteryChangeLog",
    delegate: "batteryChangeLog",
    key: "batteryChangeLogs",
  },
  {
    model: "DateNormalizationAudit",
    delegate: "dateNormalizationAudit",
    key: "dateNormalizationAudits",
  },
  { model: "Kit", delegate: "kit", key: "kits" },
  { model: "KitItem", delegate: "kitItem", key: "kitItems" },
];

/**
 * The v1.0 backup format's models, named explicitly rather than taken from
 * BACKUP_MODELS' first N entries.
 *
 * Restore order (above) and required-ness (here) are different concerns and
 * can't both be derived from array position: Gear (added after v1.0) has a
 * child, Document, that predates it, so Gear must sit before Document above
 * for FK-safe restore — which lands it ahead of position 12. A positional
 * "first N are required" rule would then silently evict SessionDrill (a real
 * v1.0 model) from the required set and wrongly require Gear in every old
 * backup. Naming the v1.0 set by model name avoids that.
 */
const V1_0_MODEL_NAMES: ReadonlySet<string> = new Set([
  "Firearm",
  "Accessory",
  "AmmoStock",
  "Build",
  "BuildSlot",
  "Document",
  "ImageCache",
  "RangeSession",
  "RangeSessionAmmoLink",
  "AmmoTransaction",
  "RoundCountLog",
  "SessionDrill",
]);

/**
 * Keys every restore payload must carry as arrays. Derived by NAME, never by
 * count or array position: a truncated file holding just `firearms` must be
 * rejected rather than wiping every other table and reporting success, and only
 * models added after v1.0 may legitimately be missing from an older backup.
 */
export const REQUIRED_BACKUP_KEYS: readonly string[] = BACKUP_MODELS.filter(
  ({ model }) => V1_0_MODEL_NAMES.has(model),
).map(({ key }) => key);

/** AppSettings is excluded: restore must not clobber local LAN host, paths, keys, or timezone. */
export const BACKUP_EXCLUDED_MODELS: readonly string[] = ["AppSettings"];
