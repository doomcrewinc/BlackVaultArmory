#!/usr/bin/env node
// Recovery command, run inside the container: prints a one-time password-reset
// link for a user, the path back in when the only admin forgets their
// password. With --promote it also makes that user an active ADMIN.
//
// Plain JS (no ts-node in the runner image), so it cannot import the TS
// helpers directly. It mirrors them instead:
//   - token/hash format: src/lib/auth/tokens.ts (generateToken, hashToken)
//   - Prisma client selection: src/lib/prisma.ts (loadPrismaClient) via
//     createRequire, same as that file's require(".prisma/client-sqlite")
//   - username normalisation: src/lib/auth/username.ts (normaliseUsername)
//   - PUBLIC_URL origin: src/lib/server/public-url.ts (parsePublicUrl)
//
// Usage: node scripts/admin-reset-link.mjs <username> [--promote]
//   exit 0  Reset link for <username> (valid 24 hours): <origin>/reset/<token>
//   exit 1  No user named "<username>"  (or: PUBLIC_URL is misconfigured)
//   exit 2  usage error (bad/missing args)

import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// RESET token TTL — tokens.ts TOKEN_TTL_MS.RESET.
const RESET_TTL_MS = 24 * 60 * 60 * 1000;
const EXAMPLE_PUBLIC_URL = "https://vault.example.com";

function usage() {
  console.error("Usage: node scripts/admin-reset-link.mjs <username> [--promote]");
}

// Mirrors generateToken/hashToken in src/lib/auth/tokens.ts exactly.
function generateToken() {
  return randomBytes(32).toString("base64url");
}

function hashToken(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

// Mirrors normaliseUsername in src/lib/auth/username.ts exactly.
function normaliseUsername(input) {
  return input.trim().toLowerCase();
}

class PublicUrlError extends Error {}

// Mirrors parsePublicUrl in src/lib/server/public-url.ts exactly (origin only).
function publicOrigin() {
  const fail = (problem) => {
    throw new PublicUrlError(
      `BLACKVAULT_PUBLIC_URL ${problem}. Set it to the address people open BlackVault at, e.g. ${EXAMPLE_PUBLIC_URL}`,
    );
  };
  const value = (process.env.PUBLIC_URL ?? "").trim();
  if (value === "") fail("is not set");

  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`is not a valid URL ("${value}")`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") fail("must use http or https");
  if (url.username || url.password) fail("must not contain a username or password");
  if (url.pathname !== "/") fail("must not have a path (sub-path hosting is not supported)");
  if (url.search || value.includes("?")) fail("must not have a query string");
  if (url.hash || value.includes("#")) fail("must not have a fragment");

  return url.origin;
}

// Mirrors resolveProvider in src/lib/db/provider.ts exactly.
function resolveProvider(rawProvider, databaseUrl) {
  const explicit = (rawProvider ?? "").trim().toLowerCase();
  if (explicit) return explicit === "sqlite" ? "sqlite" : "postgres";
  return (databaseUrl ?? "").trim().toLowerCase().startsWith("file:") ? "sqlite" : "postgres";
}

// Mirrors loadPrismaClient in src/lib/prisma.ts exactly.
function loadPrismaClient() {
  if (resolveProvider(process.env.DB_PROVIDER, process.env.DATABASE_URL) === "sqlite") {
    return require(".prisma/client-sqlite").PrismaClient;
  }
  return require("@prisma/client").PrismaClient;
}

function parseArgs(argv) {
  const promote = argv.includes("--promote");
  const positional = argv.filter((a) => a !== "--promote");
  if (positional.length !== 1 || positional[0].startsWith("-")) return null;
  return { username: positional[0], promote };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    usage();
    process.exitCode = 2;
    return;
  }

  let origin;
  try {
    origin = publicOrigin();
  } catch (error) {
    if (!(error instanceof PublicUrlError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const username = normaliseUsername(parsed.username);
  const PrismaClient = loadPrismaClient();
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) {
      console.error(`No user named "${username}"`);
      process.exitCode = 1;
      return;
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + RESET_TTL_MS);

    await prisma.$transaction(async (tx) => {
      // createdById: null — a recovery link has no acting user (Ruling: recovery links).
      await tx.authToken.create({
        data: { kind: "RESET", tokenHash: hashToken(token), userId: user.id, createdById: null, expiresAt },
      });
      if (parsed.promote) {
        await tx.user.update({ where: { id: user.id }, data: { role: "ADMIN", disabledAt: null } });
      }
      // RESET_LINK_ISSUED, on the same transaction so it commits with the token.
      // Mirrors src/lib/audit/record.ts's writeAuditEvent shape (same column names,
      // same action string) since this plain-JS script cannot import that TS module.
      // No token or URL — only who the link is for.
      await tx.auditEvent.create({
        data: {
          actorId: null,
          actorName: "system (recovery CLI)",
          actorIp: null,
          action: "RESET_LINK_ISSUED",
          entityType: "User",
          entityId: user.id,
          entityLabel: `${user.displayName} (@${user.username})`,
          changes: null,
        },
      });
    });

    console.log(`Reset link for ${username} (valid 24 hours): ${origin}/reset/${token}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
