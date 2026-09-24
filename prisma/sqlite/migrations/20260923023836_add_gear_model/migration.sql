-- CreateTable
CREATE TABLE "Gear" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "serialNumber" TEXT,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "purchasePrice" REAL,
    "currentValue" REAL,
    "acquisitionDate" DATETIME,
    "storageLocation" TEXT,
    "notes" TEXT,
    "imageUrl" TEXT,
    "imageSource" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Document_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Document_gearId_fkey" FOREIGN KEY ("gearId") REFERENCES "Gear" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("accessoryId", "createdAt", "fileSize", "fileUrl", "firearmId", "id", "mimeType", "name", "notes", "type", "updatedAt") SELECT "accessoryId", "createdAt", "fileSize", "fileUrl", "firearmId", "id", "mimeType", "name", "notes", "type", "updatedAt" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE INDEX "Document_firearmId_idx" ON "Document"("firearmId");
CREATE INDEX "Document_accessoryId_idx" ON "Document"("accessoryId");
CREATE INDEX "Document_type_idx" ON "Document"("type");
CREATE INDEX "Document_createdAt_idx" ON "Document"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Gear_category_idx" ON "Gear"("category");

