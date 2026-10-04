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

/**
 * `%` and `_` are LIKE wildcards and Prisma does not escape them for
 * `contains`, so a search for "50%" or "a_b" would otherwise match far more
 * than the text typed.
 *
 * PostgreSQL: `\` is LIKE's default escape character, so `\`, `%` and `_` are
 * escaped with it before the value reaches Prisma. The match is exact.
 *
 * SQLite: its LIKE has no default escape character and Prisma emits no
 * `ESCAPE` clause, so there is no way to make `contains` literal. The value is
 * passed through, so `%` and `_` stay wildcards: the filter is a superset of
 * the true matches (every real match is still returned), and already the
 * narrowest one SQL can express here. Splitting the term at its wildcards and
 * matching the literal pieces would be strictly looser, not tighter ("AB_12"
 * as a pattern excludes "AB12"; the piece "AB" does not). A term made only of
 * wildcards cannot be narrowed at all: it matches every non-null value. A
 * caller that must be exact checks `needsLiteralCheck`, then each row with
 * `matchesLiteralInsensitive`, and bounds how many rows it reads doing so.
 */
export function containsInsensitive(value: string, provider: DbProvider = DB_PROVIDER): InsensitiveFilter {
  if (provider === "postgres") {
    return { contains: value.replace(/[\\%_]/g, String.raw`\$&`), mode: "insensitive" };
  }
  return { contains: value };
}

/** True when `containsInsensitive(value)` over-matches on this provider: SQLite with a LIKE wildcard in the value. */
export function needsLiteralCheck(value: string, provider: DbProvider = DB_PROVIDER): boolean {
  return provider === "sqlite" && /[%_]/.test(value);
}

function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/**
 * The match SQLite's LIKE means by `contains`, minus the wildcards: a literal
 * substring, case-insensitive for ASCII only. (PostgreSQL's ILIKE folds case by
 * locale, so non-ASCII letters such as "É"/"é" match there and not on SQLite;
 * that difference is older than this check and is not hidden by it.)
 */
export function matchesLiteralInsensitive(text: string | null | undefined, value: string): boolean {
  return text != null && foldAscii(text).includes(foldAscii(value));
}
