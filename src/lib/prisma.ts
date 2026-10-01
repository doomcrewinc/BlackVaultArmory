import type { PrismaClient } from "@prisma/client";
import { resolveProvider } from "./db/provider";
import { withAudit } from "./audit/extension";
import { withEncryption } from "./encryption/extension";
import type { AppPrismaClient } from "./encryption/app-client-types";

export type { AppPrismaClient, AppTransactionClient } from "./encryption/app-client-types";

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

/**
 * A client with NO extensions (ruling R1): neither encryption nor audit. Only
 * for startup steps that must see and rewrite the stored form itself — the
 * key check and the one-time encryption migration (src/lib/encryption/
 * startup.ts). Each call opens its own connection pool; the caller must
 * `$disconnect()` it. Never use it to serve requests.
 */
export function createRawPrismaClient(): PrismaClient {
  return new (loadPrismaClient())({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { prisma: AppPrismaClient | undefined };

/**
 * The app client: `base → encryption → audit` (field-encryption spec, D7).
 * - It records every write on an audited model in the audit log
 *   (src/lib/audit/extension.ts).
 * - It encrypts the registered fields on write, decrypts them on read, and
 *   looks serials up by fingerprint (src/lib/encryption/extension.ts). The key
 *   loads on the first encrypted read or write, never at import.
 * Typed as AppPrismaClient: the generated client with nfaApprovalDate /
 * nfaTaxPaid as Date / number (src/lib/encryption/app-client-types.ts).
 *
 * Scripts and the migrator that construct their own PrismaClient are neither
 * audited nor encrypted.
 */
export const prisma: AppPrismaClient =
  globalForPrisma.prisma ??
  (withAudit(
    withEncryption(
      new (loadPrismaClient())({
        log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
      }),
    ),
  ) as unknown as AppPrismaClient);

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
