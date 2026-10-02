// Post-encryption / post-rotation compaction (final review F1). Shared by the
// app (src/lib/encryption/startup.ts, allowJs) and the plain-JS rotation CLI
// (scripts/rotate-encryption-key.mjs) — like ./core.mjs, so there is ONE copy.
//
// Why: rewriting a row leaves its OLD bytes behind. SQLite (Prisma's engine
// runs secure_delete=0) keeps them in free pages; PostgreSQL keeps them in
// dead tuples, and autovacuum's ANALYZE copies sample values into
// pg_statistic. After the startup encryption migration those old bytes are
// the PLAINTEXT serials / NFA records / audit text; after a key rotation
// they are OLD-key ciphertext. Measured in the final review (real Docker):
// - SQLite: `VACUUM` after the commit → 0 plaintext hits (125 MB in 528 ms).
//   `PRAGMA secure_delete` would also work but must go through
//   $queryRawUnsafe ($executeRawUnsafe("PRAGMA …") fails with P2010) and
//   cannot reach the pages freed by the field-encryption migration's table
//   rebuild, so VACUUM it is. Needs free disk ≈ the database size.
// - PostgreSQL: plain VACUUM erases nothing; VACUUM FULL rewrites the tables,
//   then ANALYZE + VACUUM FULL pg_statistic drops the old samples. WAL
//   segments still hold old values: documented, not fixable here.
//
// Every statement runs on the caller's raw client OUTSIDE any transaction
// (VACUUM cannot run inside one; on SQLite connection_limit=1 it is the one
// connection, idle). Callers treat a failure as a WARNING: the data is
// already encrypted and committed. AppSettings.encryptionCompactionPending
// (set inside the rewriting transaction) makes the next start retry.

/**
 * Tables whose rows the encryption migration, the audit scrub or a rotation
 * rewrites or deletes. AppSettings too: a rotation leaves the OLD-key key
 * check in a dead tuple (found by the real-Docker check of this fix wave).
 */
export const COMPACTED_TABLES = ["Firearm", "Accessory", "Gear", "AuditEvent", "DateNormalizationAudit", "AppSettings"];

const SETTINGS_ID = "singleton";

/**
 * @param {{ appSettings: { findUnique(args: unknown): Promise<unknown> } }} raw
 * @returns {Promise<boolean>} true when a committed rewrite has not been compacted yet
 */
export async function compactionPending(raw) {
  const row = /** @type {{ encryptionCompactionPending?: boolean } | null} */ (
    await raw.appSettings.findUnique({ where: { id: SETTINGS_ID }, select: { encryptionCompactionPending: true } })
  );
  return row?.encryptionCompactionPending === true;
}

/** @param {{ appSettings: { update(args: unknown): Promise<unknown> } }} raw */
export async function clearCompactionPending(raw) {
  await raw.appSettings.update({ where: { id: SETTINGS_ID }, data: { encryptionCompactionPending: false } });
}

/**
 * Erases the old values from the database files. Throws on the first
 * failing statement (the caller warns and leaves the marker set).
 *
 * @param {{ $executeRawUnsafe(q: string): Promise<unknown>; $queryRawUnsafe(q: string): Promise<unknown> }} raw
 * @param {"sqlite" | "postgres"} provider
 * @returns {Promise<{ statisticsCompacted: boolean; checkpoint: boolean }>}
 *   PostgreSQL only: whether pg_statistic was rewritten (a role that may not
 *   VACUUM it gets a WARNING from PostgreSQL, not an error — detected here by
 *   its file node not changing) and whether CHECKPOINT was allowed.
 */
export async function compactDatabase(raw, provider) {
  if (provider === "sqlite") {
    await raw.$executeRawUnsafe("VACUUM");
    return { statisticsCompacted: true, checkpoint: true };
  }
  for (const t of COMPACTED_TABLES) await raw.$executeRawUnsafe(`VACUUM FULL "${t}"`);
  for (const t of COMPACTED_TABLES) await raw.$executeRawUnsafe(`ANALYZE "${t}"`);
  const node = async () =>
    String(
      /** @type {Array<{ n: unknown }>} */ (await raw.$queryRawUnsafe("SELECT pg_relation_filenode('pg_statistic')::text AS n"))[0]?.n,
    );
  const before = await node();
  await raw.$executeRawUnsafe("VACUUM FULL pg_statistic");
  const statisticsCompacted = (await node()) !== before;
  let checkpoint = true;
  try {
    // Superuser (or pg_checkpoint) only. It only hurries the unlinking of the
    // old, already-truncated relation files; never worth a warning.
    await raw.$executeRawUnsafe("CHECKPOINT");
  } catch {
    checkpoint = false;
  }
  return { statisticsCompacted, checkpoint };
}
