export type DbProvider = "postgres" | "sqlite";

/**
 * An explicit DB_PROVIDER always wins: anything but "sqlite" is postgres, so a
 * typo must never silently fall back to SQLite. Only when DB_PROVIDER is unset
 * or empty is the provider inferred from DATABASE_URL: a `file:` URL is
 * SQLite, anything else is postgres.
 */
export function resolveProvider(raw: string | undefined, databaseUrl?: string): DbProvider {
  const explicit = raw?.trim().toLowerCase();
  if (explicit) return explicit === "sqlite" ? "sqlite" : "postgres";
  return databaseUrl?.trim().toLowerCase().startsWith("file:") ? "sqlite" : "postgres";
}

export const DB_PROVIDER: DbProvider = resolveProvider(
  process.env.DB_PROVIDER,
  process.env.DATABASE_URL,
);
