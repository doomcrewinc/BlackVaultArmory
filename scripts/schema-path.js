// Mirrors resolveProvider in src/lib/db/provider.ts: an explicit DB_PROVIDER
// wins; when it is unset, a file: DATABASE_URL means sqlite.
const explicit = (process.env.DB_PROVIDER || "").trim().toLowerCase();
const url = (process.env.DATABASE_URL || "").trim().toLowerCase();
const provider = explicit ? explicit : url.startsWith("file:") ? "sqlite" : "postgres";
process.stdout.write(`prisma/${provider === "sqlite" ? "sqlite" : "postgres"}/schema.prisma`);
