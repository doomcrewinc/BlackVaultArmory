import "./load-env";
import { prisma } from "../src/lib/prisma";
import { BACKUP_MODELS } from "../src/lib/backup/models";
import { withoutRowAudit } from "../src/lib/audit/context";
import * as readline from "readline";

async function confirm(): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("This will permanently delete ALL data. Type CONFIRM to proceed: ", (answer) => {
      rl.close();
      resolve(answer.trim() === "CONFIRM");
    });
  });
}

async function main() {
  const ok = await confirm();
  if (!ok) {
    console.log("Aborted.");
    process.exit(0);
  }

  // Children before parents: the backup registry is parent-first, so walk it in
  // reverse. Driven by the registry so a new model can never be missed here.
  // AppSettings is not in the registry, so settings are preserved. Neither is
  // AuditEvent (BACKUP_EXCLUDED_MODELS): the audit log is append-only and
  // survives a reset. The wipe itself is not row-audited — one entry per
  // deleted row would bury the log.
  const delegates = prisma as unknown as Record<string, { deleteMany: () => Promise<{ count: number }> }>;
  await withoutRowAudit(async () => {
    for (const { model, delegate } of [...BACKUP_MODELS].reverse()) {
      const result = await delegates[delegate].deleteMany();
      console.log(`Deleted ${result.count} rows from ${model}`);
    }
  });

  console.log("✓ Database reset complete. Ready for V1 release.");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
