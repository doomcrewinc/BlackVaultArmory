export async function register() {
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
}
