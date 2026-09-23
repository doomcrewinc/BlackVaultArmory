-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Accessory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT,
    "serialNumber" TEXT,
    "type" TEXT NOT NULL,
    "caliber" TEXT,
    "purchasePrice" REAL,
    "acquisitionDate" DATETIME,
    "notes" TEXT,
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "roundCount" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "compatibleFirearmTypes" TEXT,
    "compatibleCalibers" TEXT,
    "hasBattery" BOOLEAN NOT NULL DEFAULT false,
    "batteryType" TEXT,
    "lastBatteryChangeDate" DATETIME,
    "replacementIntervalDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Accessory" ("acquisitionDate", "batteryType", "caliber", "compatibleCalibers", "compatibleFirearmTypes", "createdAt", "hasBattery", "id", "imageSource", "imageUrl", "lastBatteryChangeDate", "manufacturer", "model", "name", "notes", "purchasePrice", "replacementIntervalDays", "roundCount", "serialNumber", "type", "updatedAt") SELECT "acquisitionDate", "batteryType", "caliber", "compatibleCalibers", "compatibleFirearmTypes", "createdAt", "hasBattery", "id", "imageSource", "imageUrl", "lastBatteryChangeDate", "manufacturer", "model", "name", "notes", "purchasePrice", "replacementIntervalDays", "roundCount", "serialNumber", "type", "updatedAt" FROM "Accessory";
DROP TABLE "Accessory";
ALTER TABLE "new_Accessory" RENAME TO "Accessory";
CREATE INDEX "Accessory_type_idx" ON "Accessory"("type");
CREATE INDEX "Accessory_roundCount_idx" ON "Accessory"("roundCount");
CREATE TABLE "new_Firearm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "caliber" TEXT NOT NULL,
    "compatibleCalibers" TEXT,
    "serialNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "nfaClass" TEXT NOT NULL DEFAULT 'NONE',
    "mgRegistry" TEXT,
    "acquisitionDate" DATETIME NOT NULL,
    "purchasePrice" REAL,
    "currentValue" REAL,
    "notes" TEXT,
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "lastMaintenanceDate" DATETIME,
    "maintenanceIntervalDays" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Firearm" ("acquisitionDate", "caliber", "compatibleCalibers", "createdAt", "currentValue", "id", "imageSource", "imageUrl", "lastMaintenanceDate", "maintenanceIntervalDays", "manufacturer", "model", "name", "notes", "purchasePrice", "serialNumber", "type", "updatedAt") SELECT "acquisitionDate", "caliber", "compatibleCalibers", "createdAt", "currentValue", "id", "imageSource", "imageUrl", "lastMaintenanceDate", "maintenanceIntervalDays", "manufacturer", "model", "name", "notes", "purchasePrice", "serialNumber", "type", "updatedAt" FROM "Firearm";
DROP TABLE "Firearm";
ALTER TABLE "new_Firearm" RENAME TO "Firearm";
CREATE UNIQUE INDEX "Firearm_serialNumber_key" ON "Firearm"("serialNumber");
CREATE INDEX "Firearm_caliber_idx" ON "Firearm"("caliber");
CREATE INDEX "Firearm_type_idx" ON "Firearm"("type");
CREATE INDEX "Firearm_nfaClass_idx" ON "Firearm"("nfaClass");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
