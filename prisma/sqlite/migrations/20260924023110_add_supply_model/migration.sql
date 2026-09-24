-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "expiryWarningDays" INTEGER;

-- CreateTable
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "brand" TEXT,
    "category" TEXT NOT NULL,
    "quantity" REAL NOT NULL DEFAULT 0,
    "unit" TEXT NOT NULL,
    "lowStockAlert" REAL,
    "expirationDate" DATETIME,
    "purchasePrice" REAL,
    "purchaseDate" DATETIME,
    "storageLocation" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Supply_category_idx" ON "Supply"("category");

-- CreateIndex
CREATE INDEX "Supply_expirationDate_idx" ON "Supply"("expirationDate");
