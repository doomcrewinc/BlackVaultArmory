-- AlterTable
ALTER TABLE "AmmoStock" ADD COLUMN     "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "ammoStockId" TEXT,
ADD COLUMN     "kitId" TEXT,
ADD COLUMN     "supplyId" TEXT;

-- AlterTable
ALTER TABLE "Supply" ADD COLUMN     "imageUrl" TEXT;

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapturePass" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "uploadCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CapturePass_pkey" PRIMARY KEY ("id")
);

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

-- CreateIndex
CREATE INDEX "Document_ammoStockId_idx" ON "Document"("ammoStockId");

-- CreateIndex
CREATE INDEX "Document_supplyId_idx" ON "Document"("supplyId");

-- CreateIndex
CREATE INDEX "Document_kitId_idx" ON "Document"("kitId");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ammoStockId_fkey" FOREIGN KEY ("ammoStockId") REFERENCES "AmmoStock"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_firearmId_fkey" FOREIGN KEY ("firearmId") REFERENCES "Firearm"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_accessoryId_fkey" FOREIGN KEY ("accessoryId") REFERENCES "Accessory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_gearId_fkey" FOREIGN KEY ("gearId") REFERENCES "Gear"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_ammoStockId_fkey" FOREIGN KEY ("ammoStockId") REFERENCES "AmmoStock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapturePass" ADD CONSTRAINT "CapturePass_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapturePass" ADD CONSTRAINT "CapturePass_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

