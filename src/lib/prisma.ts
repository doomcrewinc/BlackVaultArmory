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
 * Review (Task 5 fix round 2, M1): the plain-string `log` form (`["error"]`)
 * makes Prisma print each event straight to stdout/stderr ITSELF — Prisma's
 * own doing, not this app's `console.error` calls. For a
 * `PrismaClientValidationError` that printed text is the full
 * pretty-printed invocation: every field of every row in the failing write
 * (reproduced directly against the SQLite client; see
 * src/app/api/backup/restore/route.ts's `logRestoreError` for the same
 * finding at the route-error-handling layer, fixed in round 1 — this is the
 * SEPARATE leak at the Prisma-client-construction layer that round 1 missed).
 *
 * The object form (`{ emit: "event", level: "error" }`) suppresses that
 * automatic printing and instead emits an `'error'` event on the client,
 * handled below. Prisma's `LogEvent` (node_modules/@prisma/client/runtime/
 * library.d.ts) is `{ timestamp, message, target }` — there is no `model` or
 * `code` at this layer (those exist only on a caught
 * `PrismaClientKnownRequestError`, which call sites like the restore route
 * already log safely). `message` is exactly the unsafe string above and is
 * NEVER logged here; only `target` (an engine-internal component tag, never
 * row data) is.
 */
function logPrismaErrorEventSafely(client: { $on(event: "error", listener: (e: { message: string; target: string }) => void): void }): void {
  client.$on("error", (e) => {
    console.error(`[prisma] query engine error (target: ${e.target})`);
  });
}

/** Every client this module constructs shares one log config: no automatic row-carrying stdout/stderr output (review M1). */
const SAFE_LOG_CONFIG = [{ emit: "event", level: "error" }] as const;

/**
 * A client with NO extensions (ruling R1): neither encryption nor audit. Only
 * for startup steps that must see and rewrite the stored form itself — the
 * key check and the one-time encryption migration (src/lib/encryption/
 * startup.ts). Each call opens its own connection pool; the caller must
 * `$disconnect()` it. Never use it to serve requests.
 */
export function createRawPrismaClient(): PrismaClient {
  const client = new (loadPrismaClient())({ log: [...SAFE_LOG_CONFIG] });
  logPrismaErrorEventSafely(client as unknown as Parameters<typeof logPrismaErrorEventSafely>[0]);
  return client;
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
function buildAppClient(): AppPrismaClient {
  const base = new (loadPrismaClient())({ log: [...SAFE_LOG_CONFIG] });
  logPrismaErrorEventSafely(base as unknown as Parameters<typeof logPrismaErrorEventSafely>[0]);
  return withAudit(withEncryption(base)) as unknown as AppPrismaClient;
}

export const prisma: AppPrismaClient = globalForPrisma.prisma ?? buildAppClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
