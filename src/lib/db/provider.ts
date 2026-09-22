export type DbProvider = "postgres" | "sqlite";

/** Anything but an explicit "sqlite" is postgres: a typo must never silently fall back to SQLite. */
export function resolveProvider(raw: string | undefined): DbProvider {
  return raw?.trim().toLowerCase() === "sqlite" ? "sqlite" : "postgres";
}

export const DB_PROVIDER: DbProvider = resolveProvider(process.env.DB_PROVIDER);
