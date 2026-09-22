-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN "timezone" TEXT;

-- CreateTable
CREATE TABLE "DateNormalizationAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "model" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "originalValue" DATETIME NOT NULL,
    "appliedValue" DATETIME NOT NULL,
    "appliedZone" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "DateNormalizationAudit_model_field_idx" ON "DateNormalizationAudit"("model", "field");

-- CreateIndex
CREATE UNIQUE INDEX "DateNormalizationAudit_model_field_recordId_key" ON "DateNormalizationAudit"("model", "field", "recordId");
