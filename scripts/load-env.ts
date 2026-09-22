/**
 * Load the repo's .env for standalone scripts, the way Next and the Prisma CLI
 * already do for the app and `prisma db seed`. Without it DB_PROVIDER never
 * reaches src/lib/prisma, which then defaults to Postgres. Variables already set
 * in the environment win. Import this before anything that imports src/lib/prisma.
 */
import fs from "fs";
import path from "path";

const envFile = path.join(__dirname, "..", ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
