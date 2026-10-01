-- Field encryption (docs/superpowers/specs/2026-09-30-field-encryption-design.md):
-- serial fingerprint column, NFA date/tax as text (so ciphertext can live in
-- them), and the key-check column. Index name verified against
-- prisma/postgres/migrations/0_init/migration.sql: "Firearm_serialNumber_key".
DROP INDEX "Firearm_serialNumber_key";
ALTER TABLE "Firearm" ADD COLUMN "serialNumberHash" TEXT;
CREATE UNIQUE INDEX "Firearm_serialNumberHash_key" ON "Firearm"("serialNumberHash");
ALTER TABLE "Firearm" ALTER COLUMN "nfaApprovalDate" TYPE TEXT
  USING to_char("nfaApprovalDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE "Firearm" ALTER COLUMN "nfaTaxPaid" TYPE TEXT USING "nfaTaxPaid"::text;
ALTER TABLE "Accessory" ADD COLUMN "serialNumberHash" TEXT;
CREATE INDEX "Accessory_serialNumberHash_idx" ON "Accessory"("serialNumberHash");
ALTER TABLE "Accessory" ALTER COLUMN "nfaApprovalDate" TYPE TEXT
  USING to_char("nfaApprovalDate" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE "Accessory" ALTER COLUMN "nfaTaxPaid" TYPE TEXT USING "nfaTaxPaid"::text;
ALTER TABLE "Gear" ADD COLUMN "serialNumberHash" TEXT;
CREATE INDEX "Gear_serialNumberHash_idx" ON "Gear"("serialNumberHash");
ALTER TABLE "AppSettings" ADD COLUMN "encryptionKeyCheck" TEXT;
