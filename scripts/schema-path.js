const provider = (process.env.DB_PROVIDER || "").trim().toLowerCase();
process.stdout.write(`prisma/${provider === "sqlite" ? "sqlite" : "postgres"}/schema.prisma`);
