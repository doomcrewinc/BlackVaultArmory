export async function register() {
  // Deliberately OUTSIDE the never-throw blocks below: those exist so a failed
  // migration cannot block startup, and this check exists to block it. Skipped
  // during `next build`, which CI runs without a public URL.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { parsePublicUrl, PublicUrlError } = await import("./lib/server/public-url");
    try {
      parsePublicUrl(process.env.PUBLIC_URL);
    } catch (error) {
      if (!(error instanceof PublicUrlError)) throw error;
      console.error(`[startup] ${error.message}`);
      process.exit(1);
      return;
    }

    // Field encryption at rest (docs/superpowers/specs/2026-09-30-field-encryption-design.md
    // §2): load and verify the key, then encrypt any pre-encryption data in
    // one transaction. Refuses to start on ANY failure, in every NODE_ENV
    // — same mechanism as the public-URL check above. Runs
    // BEFORE the date migration: reads through the app client are strict
    // (plaintext at rest throws), so nothing may use it on Firearm /
    // Accessory / Gear until this has run.
    const { runEncryptionStartup, startupFailureLine } = await import("./lib/encryption/startup");
    try {
      await runEncryptionStartup();
    } catch (error) {
      console.error(startupFailureLine(error));
      process.exit(1);
      return;
    }
  }

  // Next awaits register() before serving and rethrows anything it throws, so
  // nothing here may ever escape: a failed migration must not block the app.
  try {
    // Node only: the edge runtime has no Prisma. Dynamic import keeps Prisma out
    // of any edge bundle.
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { runStartupDateMigration } = await import("./lib/date-migration");
    await runStartupDateMigration();
  } catch (error) {
    console.error("[date-migration] startup hook failed; the server will continue:", error);
  }
  try {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    // Log-only warning: PostgreSQL active, vault.db has data, no .migrated.
    const { runSplitBrainGuard } = await import("./lib/db/split-brain-guard");
    await runSplitBrainGuard();
  } catch (error) {
    console.error("[split-brain-guard] startup hook failed; the server will continue:", error);
  }
  try {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    const { seedDirectAccessSetting } = await import("./lib/server/direct-access");
    await seedDirectAccessSetting();
  } catch (error) {
    console.error("[direct-access] startup seed failed; the server will continue:", error);
  }
  try {
    if (process.env.NEXT_RUNTIME !== "nodejs") return;
    // `next build` must not mint a token (or print one into the build log).
    if (process.env.NEXT_PHASE === "phase-production-build") return;
    // While no user exists, mint a fresh one-time setup code and print it for the operator.
    const { ensureSetupToken } = await import("./lib/auth/tokens");
    const { getPublicUrl } = await import("./lib/server/public-url");
    const code = await ensureSetupToken();
    if (code) console.log(`[auth] Setup token: ${code} — create the first admin at ${getPublicUrl().origin}/setup`);
  } catch (error) {
    console.error("[auth] setup token failed; the server will continue:", error);
  }
}
