import type { PrismaClient } from "@prisma/client";
import { resolveProvider } from "./db/provider";
import { withAudit } from "./audit/extension";

/**
 * Both Prisma clients ship in the image; this is the only place that chooses.
 * `@prisma/client` is the Postgres client and the canonical type source — the
 * SQLite client is generated from a schema with identical models, so it is
 * structurally the same type.
 */
function loadPrismaClient(): new (options?: object) => PrismaClient {
  if (resolveProvider(process.env.DB_PROVIDER, process.env.DATABASE_URL) === "sqlite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(".prisma/client-sqlite").PrismaClient;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@prisma/client").PrismaClient;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/**
 * The app client records every write on an audited model in the audit log
 * (src/lib/audit/extension.ts). Scripts and the migrator that construct their
 * own PrismaClient are not audited.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  withAudit(
    new (loadPrismaClient())({
      log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    }),
  );

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
