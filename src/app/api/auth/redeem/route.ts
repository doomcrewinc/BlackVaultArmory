export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, validatePassword } from "@/lib/auth/password";
import { consumeToken, peekToken } from "@/lib/auth/tokens";
import { loginThrottle } from "@/lib/auth/throttle";
import { normaliseUsername, validateDisplayName, validateUsername } from "@/lib/auth/username";
import { INVALID_REQUEST, isUniqueViolation, readJsonObject, signInResponse } from "@/lib/auth/route-helpers";
import { recordEvent } from "@/lib/audit/events";

const GONE = { error: "Link expired or already used" };
const gone = () => NextResponse.json(GONE, { status: 404 });

/**
 * Redeem an invite (create the account with the invite's role) or a reset link (set a new
 * password and end every session of that user), then sign in. Single use is enforced by
 * consumeToken inside the transaction; peekToken only picks which form of body to validate.
 */
export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json(INVALID_REQUEST, { status: 400 });
  const { token } = body;
  if (typeof token !== "string" || token === "") return gone();

  const peeked = await peekToken(token);
  if (!peeked) return gone();
  if (peeked.kind === "INVITE") return redeemInvite(request, token, body);
  if (peeked.kind === "RESET") return redeemReset(request, token, body);
  return gone(); // SETUP codes are redeemed only by /api/auth/setup.
}

async function redeemInvite(request: NextRequest, token: string, body: Record<string, unknown>) {
  const { username: rawUsername, displayName: rawDisplayName, password } = body;
  if (typeof rawUsername !== "string" || typeof rawDisplayName !== "string" || typeof password !== "string") {
    return NextResponse.json({ error: "Username, display name and password are required" }, { status: 400 });
  }
  const username = normaliseUsername(rawUsername);
  const displayName = rawDisplayName.trim();
  const invalid = validateUsername(username) ?? validateDisplayName(displayName) ?? validatePassword(password);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const passwordHash = await hashPassword(password);
  const now = new Date();
  let userId: string | null;
  try {
    userId = await prisma.$transaction(async (tx) => {
      const consumed = await consumeToken(token, "INVITE", tx, now);
      if (!consumed) return null;
      // A duplicate username throws P2002 HERE, inside the callback, so the transaction rolls
      // back and the invite stays unused. Catching it inside would commit the consumption.
      const user = await tx.user.create({
        data: { username, displayName, passwordHash, role: consumed.role ?? "USER", lastLoginAt: now },
      });
      // No session cookie exists yet — the new account itself is the actor.
      const actorName = `${user.displayName} (@${user.username})`;
      await recordEvent(tx, {
        action: "INVITE_REDEEMED",
        entityType: "User",
        entityId: user.id,
        entityLabel: actorName,
        changes: { role: user.role },
        actorOverride: { actorId: user.id, actorName },
      });
      return user.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return NextResponse.json({ error: "Username taken" }, { status: 409 });
    throw error;
  }
  if (!userId) return gone();
  return signInResponse(request, userId, { next: "/" });
}

async function redeemReset(request: NextRequest, token: string, body: Record<string, unknown>) {
  const { password } = body;
  if (typeof password !== "string") return NextResponse.json({ error: "Password is required" }, { status: 400 });
  const invalid = validatePassword(password);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  const passwordHash = await hashPassword(password);
  const now = new Date();
  const user = await prisma.$transaction(async (tx) => {
    const consumed = await consumeToken(token, "RESET", tx, now);
    if (!consumed?.userId) return null;
    const updated = await tx.user.update({
      where: { id: consumed.userId },
      data: { passwordHash, lastLoginAt: now },
    });
    await tx.session.deleteMany({ where: { userId: consumed.userId } });
    // Reached via a single-use link, not a signed-in session — the account
    // whose password just changed is the actor.
    const actorName = `${updated.displayName} (@${updated.username})`;
    await recordEvent(tx, {
      action: "PASSWORD_CHANGED",
      entityType: "User",
      entityId: updated.id,
      entityLabel: actorName,
      actorOverride: { actorId: updated.id, actorName },
    });
    return updated;
  });
  if (!user) return gone();
  // A fresh password clears any failed-login backoff on the account.
  loginThrottle.succeed(`u:${user.username}`);
  return signInResponse(request, user.id, { next: "/" });
}
