-- AlterTable
ALTER TABLE "Gear" ADD COLUMN "armorSize" TEXT;
ALTER TABLE "Gear" ADD COLUMN "expirationDate" DATETIME;
ALTER TABLE "Gear" ADD COLUMN "protectionLevel" TEXT;

-- CreateIndex
CREATE INDEX "Gear_expirationDate_idx" ON "Gear"("expirationDate");

