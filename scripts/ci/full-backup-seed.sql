-- More rows for install A of scripts/ci/full-backup-linux.sh, loaded into the
-- SQLite database that scripts/ci/encryption-key-linux.sh left behind (app
-- stopped). Only models WITHOUT encrypted fields: the database is already
-- encrypted, and a plaintext serial number added now would (rightly) make the
-- backup refuse it. Counts asserted there: AmmoStock 150, RoundCountLog 40.
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150)
INSERT INTO "AmmoStock" ("id", "caliber", "brand", "grainWeight", "quantity", "notes", "createdAt", "updatedAt")
SELECT 'ci-ammo-' || i, CASE i % 3 WHEN 0 THEN '9mm' WHEN 1 THEN '5.56' ELSE '300BLK' END, 'CI Brand ' || i,
       55.5 + i, i * 10, 'note with "quotes", a comma and ünïcode ' || i, 1700000000000 + i, 1700000000000 + i
FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
INSERT INTO "RoundCountLog" ("id", "accessoryId", "roundsAdded", "previousCount", "newCount", "sessionNote", "loggedAt")
SELECT 'ci-rcl-' || i, 'ci-a1', 10, (i - 1) * 10, i * 10, 'CI session ' || i, 1700000000000 + i
FROM n;
