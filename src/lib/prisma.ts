import type { PrismaClient } from "@prisma/client";
import { resolveProvider } from "./db/provider";

/**
 * Both Prisma clients ship in the image; this is the only place that chooses.
 * `@prisma/client` is the Postgres client and the canonical type source — the
 * SQLite client is generated from a schema with identical models, so it is
 * structurally the same type.
 */
function loadPrismaClient(): new (options?: object) => PrismaClient {
  if (resolveProvider(process.env.DB_PROVIDER) === "sqlite") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(".prisma/client-sqlite").PrismaClient;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("@prisma/client").PrismaClient;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

export const prisma =
  globalForPrisma.prisma ??
  new (loadPrismaClient())({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
