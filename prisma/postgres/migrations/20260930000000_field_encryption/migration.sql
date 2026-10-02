-- Field encryption (docs/superpowers/specs/2026-09-30-field-encryption-design.md):
-- serial fingerprint column, NFA date/tax as text (so ciphertext can live in
-- them), and the key-check column. Index name verified against
-- prisma/postgres/migrations/0_init/migration.sql: "Firearm_serialNumber_key".
--
-- nfaApprovalDate is TIMESTAMP(3) — WITHOUT time zone — so it is formatted
-- directly with to_char(), never through `AT TIME ZONE 'UTC'`. That cast
-- reinterprets the naive value as a timestamptz and to_char() then renders it
-- in the session's TimeZone while still appending a literal "Z", silently
-- shifting every date (and sometimes its calendar day) on any server whose
-- session TimeZone isn't UTC (fix round 1, review I1).
DROP INDEX "Firearm_serialNumber_key";
ALTER TABLE "Firearm" ADD COLUMN "serialNumberHash" TEXT;
CREATE UNIQUE INDEX "Firearm_serialNumberHash_key" ON "Firearm"("serialNumberHash");
ALTER TABLE "Firearm" ALTER COLUMN "nfaApprovalDate" TYPE TEXT
  USING to_char("nfaApprovalDate", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE "Firearm" ALTER COLUMN "nfaTaxPaid" TYPE TEXT USING "nfaTaxPaid"::text;
ALTER TABLE "Accessory" ADD COLUMN "serialNumberHash" TEXT;
CREATE INDEX "Accessory_serialNumberHash_idx" ON "Accessory"("serialNumberHash");
ALTER TABLE "Accessory" ALTER COLUMN "nfaApprovalDate" TYPE TEXT
  USING to_char("nfaApprovalDate", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
ALTER TABLE "Accessory" ALTER COLUMN "nfaTaxPaid" TYPE TEXT USING "nfaTaxPaid"::text;
ALTER TABLE "Gear" ADD COLUMN "serialNumberHash" TEXT;
CREATE INDEX "Gear_serialNumberHash_idx" ON "Gear"("serialNumberHash");
ALTER TABLE "AppSettings" ADD COLUMN "encryptionKeyCheck" TEXT;
