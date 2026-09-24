-- AlterTable
ALTER TABLE "Accessory" ADD COLUMN "nfaApprovalDate" DATETIME;
ALTER TABLE "Accessory" ADD COLUMN "nfaControlNumber" TEXT;
ALTER TABLE "Accessory" ADD COLUMN "nfaRegisteredTo" TEXT;
ALTER TABLE "Accessory" ADD COLUMN "nfaTaxPaid" REAL;
ALTER TABLE "Accessory" ADD COLUMN "nfaTransferMethod" TEXT;

-- AlterTable
ALTER TABLE "Firearm" ADD COLUMN "nfaApprovalDate" DATETIME;
ALTER TABLE "Firearm" ADD COLUMN "nfaControlNumber" TEXT;
ALTER TABLE "Firearm" ADD COLUMN "nfaRegisteredTo" TEXT;
ALTER TABLE "Firearm" ADD COLUMN "nfaTaxPaid" REAL;
ALTER TABLE "Firearm" ADD COLUMN "nfaTransferMethod" TEXT;

