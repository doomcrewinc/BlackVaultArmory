-- AlterTable
ALTER TABLE "Gear" ADD COLUMN "serialNumberHash" TEXT;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "encryptionKeyCheck" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Firearm" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "caliber" TEXT NOT NULL,
    "compatibleCalibers" TEXT,
    "serialNumber" TEXT NOT NULL,
    "serialNumberHash" TEXT,
    "type" TEXT NOT NULL,
    "nfaClass" TEXT NOT NULL DEFAULT 'NONE',
    "mgRegistry" TEXT,
    "nfaTransferMethod" TEXT,
    "nfaControlNumber" TEXT,
    "nfaApprovalDate" TEXT,
    "nfaTaxPaid" TEXT,
    "nfaRegisteredTo" TEXT,
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
INSERT INTO "new_Firearm" ("acquisitionDate", "caliber", "compatibleCalibers", "createdAt", "currentValue", "id", "imageSource", "imageUrl", "lastMaintenanceDate", "maintenanceIntervalDays", "manufacturer", "mgRegistry", "model", "name", "nfaApprovalDate", "nfaClass", "nfaControlNumber", "nfaRegisteredTo", "nfaTaxPaid", "nfaTransferMethod", "notes", "purchasePrice", "serialNumber", "type", "updatedAt") SELECT "acquisitionDate", "caliber", "compatibleCalibers", "createdAt", "currentValue", "id", "imageSource", "imageUrl", "lastMaintenanceDate", "maintenanceIntervalDays", "manufacturer", "mgRegistry", "model", "name", "nfaApprovalDate", "nfaClass", "nfaControlNumber", "nfaRegisteredTo", "nfaTaxPaid", "nfaTransferMethod", "notes", "purchasePrice", "serialNumber", "type", "updatedAt" FROM "Firearm";
DROP TABLE "Firearm";
ALTER TABLE "new_Firearm" RENAME TO "Firearm";
CREATE UNIQUE INDEX "Firearm_serialNumberHash_key" ON "Firearm"("serialNumberHash");
CREATE INDEX "Firearm_caliber_idx" ON "Firearm"("caliber");
CREATE INDEX "Firearm_type_idx" ON "Firearm"("type");
CREATE INDEX "Firearm_nfaClass_idx" ON "Firearm"("nfaClass");
CREATE TABLE "new_Accessory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT,
    "serialNumber" TEXT,
    "serialNumberHash" TEXT,
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
    "nfaTransferMethod" TEXT,
    "nfaControlNumber" TEXT,
    "nfaApprovalDate" TEXT,
    "nfaTaxPaid" TEXT,
    "nfaRegisteredTo" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Accessory" ("acquisitionDate", "batteryType", "caliber", "compatibleCalibers", "compatibleFirearmTypes", "createdAt", "hasBattery", "id", "imageSource", "imageUrl", "lastBatteryChangeDate", "manufacturer", "model", "name", "nfaApprovalDate", "nfaControlNumber", "nfaRegisteredTo", "nfaTaxPaid", "nfaTransferMethod", "notes", "purchasePrice", "quantity", "replacementIntervalDays", "roundCount", "serialNumber", "type", "updatedAt") SELECT "acquisitionDate", "batteryType", "caliber", "compatibleCalibers", "compatibleFirearmTypes", "createdAt", "hasBattery", "id", "imageSource", "imageUrl", "lastBatteryChangeDate", "manufacturer", "model", "name", "nfaApprovalDate", "nfaControlNumber", "nfaRegisteredTo", "nfaTaxPaid", "nfaTransferMethod", "notes", "purchasePrice", "quantity", "replacementIntervalDays", "roundCount", "serialNumber", "type", "updatedAt" FROM "Accessory";
DROP TABLE "Accessory";
ALTER TABLE "new_Accessory" RENAME TO "Accessory";
CREATE INDEX "Accessory_type_idx" ON "Accessory"("type");
CREATE INDEX "Accessory_roundCount_idx" ON "Accessory"("roundCount");
CREATE INDEX "Accessory_serialNumberHash_idx" ON "Accessory"("serialNumberHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Gear_serialNumberHash_idx" ON "Gear"("serialNumberHash");

