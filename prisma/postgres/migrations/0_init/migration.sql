-- CreateTable
CREATE TABLE "Firearm" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "caliber" TEXT NOT NULL,
    "compatibleCalibers" TEXT,
    "serialNumber" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "nfaClass" TEXT NOT NULL DEFAULT 'NONE',
    "mgRegistry" TEXT,
    "nfaTransferMethod" TEXT,
    "nfaControlNumber" TEXT,
    "nfaApprovalDate" TIMESTAMP(3),
    "nfaTaxPaid" DOUBLE PRECISION,
    "nfaRegisteredTo" TEXT,
    "acquisitionDate" TIMESTAMP(3) NOT NULL,
    "purchasePrice" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "notes" TEXT,
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "lastMaintenanceDate" TIMESTAMP(3),
    "maintenanceIntervalDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Firearm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Build" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "firearmId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuildSlot" (
    "id" TEXT NOT NULL,
    "buildId" TEXT NOT NULL,
    "slotType" TEXT NOT NULL,
    "accessoryId" TEXT,
    "positionX" DOUBLE PRECISION,
    "positionY" DOUBLE PRECISION,
    "scaleX" DOUBLE PRECISION DEFAULT 1.0,
    "scaleY" DOUBLE PRECISION DEFAULT 1.0,
    "layerIndex" INTEGER DEFAULT 0,

    CONSTRAINT "BuildSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Accessory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "model" TEXT,
    "serialNumber" TEXT,
    "type" TEXT NOT NULL,
    "caliber" TEXT,
    "purchasePrice" DOUBLE PRECISION,
    "acquisitionDate" TIMESTAMP(3),
    "notes" TEXT,
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "roundCount" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "compatibleFirearmTypes" TEXT,
    "compatibleCalibers" TEXT,
    "hasBattery" BOOLEAN NOT NULL DEFAULT false,
    "batteryType" TEXT,
    "lastBatteryChangeDate" TIMESTAMP(3),
    "replacementIntervalDays" INTEGER,
    "nfaTransferMethod" TEXT,
    "nfaControlNumber" TEXT,
    "nfaApprovalDate" TIMESTAMP(3),
    "nfaTaxPaid" DOUBLE PRECISION,
    "nfaRegisteredTo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Accessory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gear" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "purchasePrice" DOUBLE PRECISION,
    "currentValue" DOUBLE PRECISION,
    "acquisitionDate" TIMESTAMP(3),
    "expirationDate" TIMESTAMP(3),
    "protectionLevel" TEXT,
    "armorSize" TEXT,
    "storageLocation" TEXT,
    "notes" TEXT,
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "lowStockAlert" DOUBLE PRECISION,
    "expirationDate" TIMESTAMP(3),
    "purchasePrice" DOUBLE PRECISION,
    "purchaseDate" TIMESTAMP(3),
    "storageLocation" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "notes" TEXT,
    "firearmId" TEXT,
    "accessoryId" TEXT,
    "gearId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundCountLog" (
    "id" TEXT NOT NULL,
    "accessoryId" TEXT NOT NULL,
    "roundsAdded" INTEGER NOT NULL,
    "previousCount" INTEGER NOT NULL,
    "newCount" INTEGER NOT NULL,
    "sessionNote" TEXT,
    "loggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoundCountLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmmoStock" (
    "id" TEXT NOT NULL,
    "caliber" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "grainWeight" DOUBLE PRECISION,
    "bulletType" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "purchasePrice" DOUBLE PRECISION,
    "pricePerRound" DOUBLE PRECISION,
    "purchaseDate" TIMESTAMP(3),
    "storageLocation" TEXT,
    "lowStockAlert" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmmoStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RangeSession" (
    "id" TEXT NOT NULL,
    "sessionDate" TIMESTAMP(3) NOT NULL,
    "location" TEXT NOT NULL,
    "firearmId" TEXT NOT NULL,
    "buildId" TEXT,
    "roundsFired" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RangeSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RangeSessionAmmoLink" (
    "id" TEXT NOT NULL,
    "rangeSessionId" TEXT NOT NULL,
    "ammoStockId" TEXT,
    "roundsUsed" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RangeSessionAmmoLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionDrill" (
    "id" TEXT NOT NULL,
    "rangeSessionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "setNumber" INTEGER NOT NULL DEFAULT 1,
    "timeSeconds" DOUBLE PRECISION,
    "points" DOUBLE PRECISION,
    "penalties" DOUBLE PRECISION,
    "hits" INTEGER,
    "hitFactor" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "drillDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionDrill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmmoTransaction" (
    "id" TEXT NOT NULL,
    "stockId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "previousQty" INTEGER NOT NULL,
    "newQty" INTEGER NOT NULL,
    "note" TEXT,
    "transactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purchasePrice" DOUBLE PRECISION,
    "pricePerRound" DOUBLE PRECISION,
    "purchaseDate" TIMESTAMP(3),

    CONSTRAINT "AmmoTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageCache" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "searchQuery" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "width" INTEGER,
    "height" INTEGER,
    "cachedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImageCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatteryChangeLog" (
    "id" TEXT NOT NULL,
    "accessoryId" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batteryType" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatteryChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceLog" (
    "id" TEXT NOT NULL,
    "firearmId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "notes" TEXT NOT NULL,
    "roundCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaintenanceLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DateNormalizationAudit" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "originalValue" TIMESTAMP(3) NOT NULL,
    "appliedValue" TIMESTAMP(3) NOT NULL,
    "appliedZone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DateNormalizationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "googleCseApiKey" TEXT,
    "googleCseSearchEngineId" TEXT,
    "enableImageSearch" BOOLEAN NOT NULL DEFAULT false,
    "includeUploadsInBackup" BOOLEAN NOT NULL DEFAULT true,
    "autoBackupEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoBackupCadence" TEXT NOT NULL DEFAULT 'weekly',
    "backupDestinationPath" TEXT,
    "manualLanHost" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "appPassword" TEXT,
    "defaultAmmoAlertThreshold" INTEGER,
    "expiryWarningDays" INTEGER,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Kit" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "location" TEXT,
    "notes" TEXT,
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Kit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KitItem" (
    "id" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    "gearId" TEXT,
    "supplyId" TEXT,
    "accessoryId" TEXT,
    "ammoStockId" TEXT,
    "firearmId" TEXT,
    "label" TEXT,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "targetQuantity" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KitItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Firearm_serialNumber_key" ON "Firearm"("serialNumber");

-- CreateIndex
CREATE INDEX "Firearm_caliber_idx" ON "Firearm"("caliber");

-- CreateIndex
CREATE INDEX "Firearm_type_idx" ON "Firearm"("type");

-- CreateIndex
CREATE INDEX "Firearm_nfaClass_idx" ON "Firearm"("nfaClass");

-- CreateIndex
CREATE INDEX "Build_firearmId_idx" ON "Build"("firearmId");

-- CreateIndex
CREATE INDEX "Build_isActive_idx" ON "Build"("isActive");

-- CreateIndex
CREATE INDEX "BuildSlot_buildId_idx" ON "BuildSlot"("buildId");

-- CreateIndex
CREATE INDEX "BuildSlot_accessoryId_idx" ON "BuildSlot"("accessoryId");

-- CreateIndex
CREATE UNIQUE INDEX "BuildSlot_buildId_slotType_key" ON "BuildSlot"("buildId", "slotType");

-- CreateIndex
CREATE INDEX "Accessory_type_idx" ON "Accessory"("type");

-- CreateIndex
CREATE INDEX "Accessory_roundCount_idx" ON "Accessory"("roundCount");

-- CreateIndex
CREATE INDEX "Gear_category_idx" ON "Gear"("category");

-- CreateIndex
CREATE INDEX "Gear_expirationDate_idx" ON "Gear"("expirationDate");

-- CreateIndex
CREATE INDEX "Supply_category_idx" ON "Supply"("category");

-- CreateIndex
CREATE INDEX "Supply_expirationDate_idx" ON "Supply"("expirationDate");

-- CreateIndex
CREATE INDEX "Document_firearmId_idx" ON "Document"("firearmId");

-- CreateIndex
CREATE INDEX "Document_accessoryId_idx" ON "Document"("accessoryId");

-- CreateIndex
CREATE INDEX "Document_gearId_idx" ON "Document"("gearId");

-- CreateIndex
CREATE INDEX "Document_type_idx" ON "Document"("type");

-- CreateIndex
CREATE INDEX "Document_createdAt_idx" ON "Document"("createdAt");

-- CreateIndex
CREATE INDEX "RoundCountLog_accessoryId_idx" ON "RoundCountLog"("accessoryId");

-- CreateIndex
CREATE INDEX "RoundCountLog_loggedAt_idx" ON "RoundCountLog"("loggedAt");

-- CreateIndex
CREATE INDEX "AmmoStock_caliber_idx" ON "AmmoStock"("caliber");

-- CreateIndex
CREATE INDEX "RangeSession_sessionDate_idx" ON "RangeSession"("sessionDate");

-- CreateIndex
CREATE INDEX "RangeSession_firearmId_idx" ON "RangeSession"("firearmId");

-- CreateIndex
CREATE INDEX "RangeSession_buildId_idx" ON "RangeSession"("buildId");

-- CreateIndex
CREATE INDEX "RangeSessionAmmoLink_rangeSessionId_idx" ON "RangeSessionAmmoLink"("rangeSessionId");

-- CreateIndex
CREATE INDEX "RangeSessionAmmoLink_ammoStockId_idx" ON "RangeSessionAmmoLink"("ammoStockId");

-- CreateIndex
CREATE INDEX "SessionDrill_rangeSessionId_idx" ON "SessionDrill"("rangeSessionId");

-- CreateIndex
CREATE INDEX "AmmoTransaction_stockId_idx" ON "AmmoTransaction"("stockId");

-- CreateIndex
CREATE INDEX "AmmoTransaction_transactedAt_idx" ON "AmmoTransaction"("transactedAt");

-- CreateIndex
CREATE INDEX "ImageCache_entityType_entityId_idx" ON "ImageCache"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "BatteryChangeLog_accessoryId_idx" ON "BatteryChangeLog"("accessoryId");

-- CreateIndex
CREATE INDEX "BatteryChangeLog_changedAt_idx" ON "BatteryChangeLog"("changedAt");

-- CreateIndex
CREATE INDEX "MaintenanceLog_firearmId_idx" ON "MaintenanceLog"("firearmId");

-- CreateIndex
CREATE INDEX "MaintenanceLog_date_idx" ON "MaintenanceLog"("date");

-- CreateIndex
CREATE INDEX "DateNormalizationAudit_model_field_idx" ON "DateNormalizationAudit"("model", "field");

-- CreateIndex
CREATE UNIQUE INDEX "DateNormalizationAudit_model_field_recordId_key" ON "DateNormalizationAudit"("model", "field", "recordId");

-- CreateIndex
CREATE INDEX "Kit_category_idx" ON "Kit"("category");

-- CreateIndex
CREATE INDEX "KitItem_kitId_idx" ON "KitItem"("kitId");

-- AddForeignKey
ALTER TABLE "Build" ADD CONSTRAINT "Build_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildSlot" ADD CONSTRAINT "BuildSlot_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuildSlot" ADD CONSTRAINT "BuildSlot_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_gearId_fkey" FOREIGN KEY ("gearId") REFERENCES "Gear"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoundCountLog" ADD CONSTRAINT "RoundCountLog_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeSession" ADD CONSTRAINT "RangeSession_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeSession" ADD CONSTRAINT "RangeSession_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "Build"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeSessionAmmoLink" ADD CONSTRAINT "RangeSessionAmmoLink_rangeSessionId_fkey" FOREIGN KEY ("rangeSessionId") REFERENCES "RangeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RangeSessionAmmoLink" ADD CONSTRAINT "RangeSessionAmmoLink_ammoStockId_fkey" FOREIGN KEY ("ammoStockId") REFERENCES "AmmoStock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionDrill" ADD CONSTRAINT "SessionDrill_rangeSessionId_fkey" FOREIGN KEY ("rangeSessionId") REFERENCES "RangeSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmmoTransaction" ADD CONSTRAINT "AmmoTransaction_stockId_fkey" FOREIGN KEY ("stockId") REFERENCES "AmmoStock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatteryChangeLog" ADD CONSTRAINT "BatteryChangeLog_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceLog" ADD CONSTRAINT "MaintenanceLog_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_gearId_fkey" FOREIGN KEY ("gearId") REFERENCES "Gear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_ammoStockId_fkey" FOREIGN KEY ("ammoStockId") REFERENCES "AmmoStock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KitItem" ADD CONSTRAINT "KitItem_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

