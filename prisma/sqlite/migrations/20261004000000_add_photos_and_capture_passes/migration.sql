-- AlterTable
ALTER TABLE "AmmoStock" ADD COLUMN "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "Supply" ADD COLUMN "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "label" TEXT,
    "firearmId" TEXT,
    "accessoryId" TEXT,
    "gearId" TEXT,
    "kitId" TEXT,
    "ammoStockId" TEXT,
    "supplyId" TEXT,
    "createdById" TEXT,
    "viaPass" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Photo_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_gearId_fkey" FOREIGN KEY ("gearId") REFERENCES "Gear" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_ammoStockId_fkey" FOREIGN KEY ("ammoStockId") REFERENCES "AmmoStock" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Photo_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CapturePass" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "uploadCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CapturePass_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CapturePass_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "notes" TEXT,
    "firearmId" TEXT,
    "accessoryId" TEXT,
    "gearId" TEXT,
    "ammoStockId" TEXT,
    "supplyId" TEXT,
    "kitId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Document_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_gearId_fkey" FOREIGN KEY ("gearId") REFERENCES "Gear" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_ammoStockId_fkey" FOREIGN KEY ("ammoStockId") REFERENCES "AmmoStock" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("accessoryId", "createdAt", "fileSize", "fileUrl", "firearmId", "gearId", "id", "mimeType", "name", "notes", "type", "updatedAt") SELECT "accessoryId", "createdAt", "fileSize", "fileUrl", "firearmId", "gearId", "id", "mimeType", "name", "notes", "type", "updatedAt" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE INDEX "Document_firearmId_idx" ON "Document"("firearmId");
CREATE INDEX "Document_accessoryId_idx" ON "Document"("accessoryId");
CREATE INDEX "Document_gearId_idx" ON "Document"("gearId");
CREATE INDEX "Document_ammoStockId_idx" ON "Document"("ammoStockId");
CREATE INDEX "Document_supplyId_idx" ON "Document"("supplyId");
CREATE INDEX "Document_kitId_idx" ON "Document"("kitId");
CREATE INDEX "Document_type_idx" ON "Document"("type");
CREATE INDEX "Document_createdAt_idx" ON "Document"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Photo_fileName_key" ON "Photo"("fileName");

-- CreateIndex
CREATE INDEX "Photo_firearmId_idx" ON "Photo"("firearmId");

-- CreateIndex
CREATE INDEX "Photo_accessoryId_idx" ON "Photo"("accessoryId");

-- CreateIndex
CREATE INDEX "Photo_gearId_idx" ON "Photo"("gearId");

-- CreateIndex
CREATE INDEX "Photo_kitId_idx" ON "Photo"("kitId");

-- CreateIndex
CREATE INDEX "Photo_ammoStockId_idx" ON "Photo"("ammoStockId");

-- CreateIndex
CREATE INDEX "Photo_supplyId_idx" ON "Photo"("supplyId");

-- CreateIndex
CREATE UNIQUE INDEX "CapturePass_tokenHash_key" ON "CapturePass"("tokenHash");

-- CreateIndex
CREATE INDEX "CapturePass_entityType_entityId_idx" ON "CapturePass"("entityType", "entityId");

