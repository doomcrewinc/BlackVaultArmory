-- Plaintext inventory, as a release before field encryption stored it.
-- Loaded by scripts/ci/encryption-key-linux.sh into the SQLite database
-- before the first start that has a key, so real Linux Docker exercises the
-- app's pre-encryption snapshot, the startup encryption, and a rotation of
-- real rows. Counts asserted there: Firearm 3, Accessory 2, Gear 2.
INSERT INTO "Firearm" ("id", "name", "manufacturer", "model", "caliber", "serialNumber", "type", "acquisitionDate", "updatedAt",
  "nfaControlNumber", "nfaRegisteredTo", "nfaTransferMethod", "nfaApprovalDate", "nfaTaxPaid")
VALUES
  ('ci-f1', 'CI Rifle', 'Acme', 'R1', '5.56', 'CI-SERIAL-F1', 'RIFLE', 1700000000000, 1700000000000,
   'CTRL-F1', 'CI Trust', 'Form 4', '2023-11-14T00:00:00.000Z', '200'),
  ('ci-f2', 'CI Pistol', 'Acme', 'P1', '9mm', 'CI-SERIAL-F2', 'PISTOL', 1700000000000, 1700000000000,
   NULL, NULL, NULL, NULL, NULL),
  ('ci-f3', 'CI SBR', 'Acme', 'S1', '300BLK', 'CI-SERIAL-F3', 'RIFLE', 1700000000000, 1700000000000,
   'CTRL-F3', 'CI Owner', 'Form 1', '1700006400000', '200');
INSERT INTO "Accessory" ("id", "name", "manufacturer", "type", "updatedAt", "serialNumber",
  "nfaControlNumber", "nfaRegisteredTo", "nfaTransferMethod", "nfaApprovalDate", "nfaTaxPaid")
VALUES
  ('ci-a1', 'CI Suppressor', 'Acme', 'SUPPRESSOR', 1700000000000, 'CI-SERIAL-A1',
   'CTRL-A1', 'CI Trust', 'Form 4', '2023-11-14T00:00:00.000Z', '200'),
  ('ci-a2', 'CI Optic', 'Acme', 'OPTIC', 1700000000000, 'CI-SERIAL-A2', NULL, NULL, NULL, NULL, NULL);
INSERT INTO "Gear" ("id", "name", "category", "updatedAt", "serialNumber")
VALUES
  ('ci-g1', 'CI Plate Carrier', 'ARMOR', 1700000000000, 'CI-SERIAL-G1'),
  ('ci-g2', 'CI Radio', 'COMMS', 1700000000000, 'CI-SERIAL-G2');
