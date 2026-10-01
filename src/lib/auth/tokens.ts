import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AUTH_TOKEN_KINDS, ROLES, type AuthTokenKind, type Role } from "@/lib/accounts";

/** Single-use invite, reset and setup tokens. Only SHA-256 hashes are stored. */

export type TokenKind = AuthTokenKind;
export type RoleName = Role;

export const TOKEN_TTL_MS = { INVITE: 7 * 86_400_000, RESET: 86_400_000 } as const;
const SETUP_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateSetupCode(): string {
  const chars = Array.from({ length: 16 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

/** Setup codes are typed by hand: ignore case, spaces and dashes. */
export function normaliseSetupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export async function createInvite(opts: { role: RoleName; createdById: string; now?: Date }) {
  const now = opts.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS.INVITE);
  await prisma.authToken.create({
    data: { kind: "INVITE", tokenHash: hashToken(token), role: opts.role, createdById: opts.createdById, expiresAt },
  });
  return { token, expiresAt };
}

export async function createResetLink(opts: { userId: string; createdById: string | null; now?: Date }) {
  const now = opts.now ?? new Date();
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS.RESET);
  await prisma.authToken.create({
    data: { kind: "RESET", tokenHash: hashToken(token), userId: opts.userId, createdById: opts.createdById, expiresAt },
  });
  return { token, expiresAt };
}

export async function ensureSetupToken(): Promise<string | null> {
  if ((await prisma.user.count()) > 0) return null;
  const code = generateSetupCode();
  await prisma.authToken.deleteMany({ where: { kind: "SETUP", usedAt: null } });
  await prisma.authToken.create({
    data: { kind: "SETUP", tokenHash: hashToken(normaliseSetupCode(code)), expiresAt: null },
  });
  return code;
}

function unexpired(now: Date) {
  return [{ expiresAt: null }, { expiresAt: { gt: now } }];
}

/**
 * An invite is only as good as its issuer (ruling A13): it is redeemable only while the admin who
 * minted it is still an active ADMIN. Otherwise a disabled or demoted admin could redeem their own
 * outstanding ADMIN invite and come back as a new admin. changeRoleOrStatus also burns such links,
 * but this check holds even for links it missed (e.g. rows written before that rule existed).
 */
const ISSUER_IS_ACTIVE_ADMIN = { is: { role: "ADMIN", disabledAt: null } } as const;

function issuerIsActiveAdmin(issuer: { role: string; disabledAt: Date | null } | null | undefined): boolean {
  return !!issuer && issuer.role === "ADMIN" && issuer.disabledAt === null;
}

export async function peekToken(raw: string, now: Date = new Date()) {
  const row = await prisma.authToken.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { createdBy: { select: { role: true, disabledAt: true } } },
  });
  if (!row || row.usedAt || (row.expiresAt && row.expiresAt <= now)) return null;

  // Narrow string values to known enums
  if (!AUTH_TOKEN_KINDS.includes(row.kind as AuthTokenKind)) return null;
  const kind = row.kind as AuthTokenKind;
  // Same rule consumeToken enforces, so the invite page and /api/auth/redeem agree.
  if (kind === "INVITE" && !issuerIsActiveAdmin(row.createdBy)) return null;

  const role = row.role ? (ROLES.includes(row.role as Role) ? (row.role as Role) : null) : null;

  return { kind, role, userId: row.userId ?? null };
}

/**
 * Atomic single use: two concurrent redemptions cannot both see count 1. For an INVITE the
 * issuer-is-an-active-admin check is part of the same conditional update, so it is decided inside
 * the caller's transaction and a refused invite is left unused.
 */
// `tx` is only the delegate this uses, so both the app's transaction client
// (AppTransactionClient, src/lib/prisma.ts) and a plain Prisma one fit.
export async function consumeToken(raw: string, kind: TokenKind, tx: Pick<Prisma.TransactionClient, "authToken">, now: Date = new Date()) {
  const tokenHash = hashToken(raw);
  const where: Prisma.AuthTokenWhereInput = { tokenHash, kind, usedAt: null, OR: unexpired(now) };
  if (kind === "INVITE") where.createdBy = ISSUER_IS_ACTIVE_ADMIN;
  const { count } = await tx.authToken.updateMany({ where, data: { usedAt: now } });
  if (count !== 1) return null;
  const row = await tx.authToken.findUnique({ where: { tokenHash } });
  const role = row?.role ? (ROLES.includes(row.role as Role) ? (row.role as Role) : null) : null;
  return { role, userId: row?.userId ?? null };
}
