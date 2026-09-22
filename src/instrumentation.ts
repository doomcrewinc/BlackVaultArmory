export async function register() {
  // Node only: the edge runtime has no Prisma. Dynamic import keeps Prisma out
  // of any edge bundle.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { runStartupDateMigration } = await import("./lib/date-migration");
  await runStartupDateMigration();
}
