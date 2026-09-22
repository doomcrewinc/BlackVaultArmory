import { DB_PROVIDER, type DbProvider } from "./provider";

/**
 * A `contains` filter that ignores case on both providers.
 *
 * SQLite's LIKE is already ASCII-case-insensitive, and its Prisma client has no
 * `mode` option (passing one is a validation error). Postgres's LIKE is
 * case-sensitive, so it needs `mode: "insensitive"` (ILIKE) or search stops
 * matching on capitalisation.
 *
 * A named interface, rather than an inline object literal, so passing the
 * result where the SQLite client expects a `StringFilter` does not trip
 * excess-property checking.
 */
export interface InsensitiveFilter {
  contains: string;
  mode?: "insensitive";
}

export function containsInsensitive(value: string, provider: DbProvider = DB_PROVIDER): InsensitiveFilter {
  return provider === "postgres" ? { contains: value, mode: "insensitive" } : { contains: value };
}
