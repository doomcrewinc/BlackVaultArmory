export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, validatePassword } from "@/lib/auth/password";
import { consumeToken, normaliseSetupCode } from "@/lib/auth/tokens";
import { markUsersExist } from "@/lib/auth/setup-state";
import { normaliseUsername, validateDisplayName, validateUsername } from "@/lib/auth/username";
import { INVALID_REQUEST, readJsonObject, signInResponse } from "@/lib/auth/route-helpers";

const INVALID_CODE = { error: "Invalid setup code" };
const NOT_FOUND = { error: "Not found" };

/** Thrown inside the transaction to roll back the code's consumption when a user already exists. */
class UsersExist extends Error {}

/** Create the first ADMIN with the one-time setup code printed at startup. 404 once any user exists. */
export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body) return NextResponse.json(INVALID_REQUEST, { status: 400 });

  if ((await prisma.user.count()) > 0) return NextResponse.json(NOT_FOUND, { status: 404 });

  const { setupCode, username: rawUsername, displayName: rawDisplayName, password } = body;
  if (typeof setupCode !== "string" || normaliseSetupCode(setupCode) === "") {
    return NextResponse.json(INVALID_CODE, { status: 403 });
  }
  if (typeof rawUsername !== "string" || typeof rawDisplayName !== "string" || typeof password !== "string") {
    return NextResponse.json(INVALID_REQUEST, { status: 400 });
  }
  const username = normaliseUsername(rawUsername);
  const displayName = rawDisplayName.trim();
  const invalid = validateUsername(username) ?? validateDisplayName(displayName) ?? validatePassword(password);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

  // Hash outside the transaction: scrypt is slow and SQLite holds its write lock for the tx.
  const passwordHash = await hashPassword(password);
  const now = new Date();

  let created: { id: string } | null;
  try {
    created = await prisma.$transaction(async (tx) => {
      if (!(await consumeToken(normaliseSetupCode(setupCode), "SETUP", tx, now))) return null;
      if ((await tx.user.count()) !== 0) throw new UsersExist();
      return tx.user.create({ data: { username, displayName, passwordHash, role: "ADMIN", lastLoginAt: now } });
    });
  } catch (error) {
    if (error instanceof UsersExist) return NextResponse.json(NOT_FOUND, { status: 404 });
    throw error;
  }
  if (!created) return NextResponse.json(INVALID_CODE, { status: 403 });

  markUsersExist();
  // Explicit fields: never echo passwordHash.
  const user = { id: created.id, username, displayName, role: "ADMIN" as const };
  return signInResponse(request, user.id, { user }, 201);
}
