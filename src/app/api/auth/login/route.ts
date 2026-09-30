export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { dummyVerify, hashPassword, PASSWORD_MAX, verifyPassword } from "@/lib/auth/password";
import { loginThrottle } from "@/lib/auth/throttle";
import { safeNextPath } from "@/lib/auth/next-path";
import { normaliseUsername } from "@/lib/auth/username";
import { trustsForwardedHeaders } from "@/lib/server/request-gate";
import { INVALID_REQUEST, readJsonObject, signInResponse } from "@/lib/auth/route-helpers";
import { recordEventBestEffort } from "@/lib/audit/events";

// One body for unknown user, wrong password and disabled account — never tell them apart.
const LOGIN_FAILED = { error: "Invalid username or password" };

function throttleKeys(request: NextRequest, username: string): string[] {
  const keys = [`u:${username}`];
  if (trustsForwardedHeaders()) {
    // The LAST X-Forwarded-For entry, not the first: a proxy that appends (nginx
    // $proxy_add_x_forwarded_for, Traefik, Caddy) keeps whatever the client sent in front,
    // so the first entry is attacker-chosen and could be rotated to dodge the throttle. The
    // last entry is the address our single trusted proxy actually saw.
    const ip = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
    if (ip) keys.push(`ip:${ip}`);
  }
  return keys;
}

export async function POST(request: NextRequest) {
  const body = await readJsonObject(request);
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return NextResponse.json(INVALID_REQUEST, { status: 400 });
  }
  const username = normaliseUsername(body.username);
  const password = body.password;
  const keys = throttleKeys(request, username);

  const waits = keys.map((k) => loginThrottle.check(k)).flatMap((c) => (c.allowed ? [] : [c.retryAfterSeconds]));
  if (waits.length > 0) {
    return NextResponse.json(
      { error: "Too many attempts" },
      { status: 429, headers: { "Retry-After": String(Math.max(...waits)) } },
    );
  }

  // Every failure path (unknown user, wrong password, disabled account, an over-long
  // password) goes through here, so the extra write costs the same regardless of which
  // one it was — it must never become a signal that distinguishes them.
  const fail = async () => {
    keys.forEach((k) => loginThrottle.fail(k));
    // actorOverride, not the default resolveActor(): a request that already carries a
    // valid session cookie (re-logging in, or signed in as one account and POSTing
    // credentials for another) would otherwise have getCurrentUser() attribute this
    // failed attempt to whoever that cookie belongs to. A LOGIN_FAILED always means no
    // actor, regardless of what the request's own cookie says.
    await recordEventBestEffort(null, {
      action: "LOGIN_FAILED",
      changes: { username: username.slice(0, 64) },
      actorOverride: { actorId: null, actorName: "anonymous" },
    });
    return NextResponse.json(LOGIN_FAILED, { status: 401 });
  };

  // No stored password is longer than PASSWORD_MAX, so a longer one cannot match; the
  // dummy verify on a truncated copy keeps the timing and bounds the scrypt input.
  if (password.length > PASSWORD_MAX) {
    await dummyVerify(password.slice(0, PASSWORD_MAX));
    return fail();
  }

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    await dummyVerify(password);
    return fail();
  }
  // Verify even for a disabled account so it costs the same as any other failure.
  const { ok, needsRehash } = await verifyPassword(password, user.passwordHash);
  if (!ok || user.disabledAt) return fail();

  keys.forEach((k) => loginThrottle.succeed(k));
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date(), ...(needsRehash ? { passwordHash: await hashPassword(password) } : {}) },
  });
  const actorName = `${user.displayName} (@${user.username})`;
  // The session cookie is not set yet (signInResponse creates it below), so
  // resolveActor() would see no cookie and report anonymous — override with the
  // user who just proved their password.
  await recordEventBestEffort(null, {
    action: "LOGIN",
    entityType: "User",
    entityId: user.id,
    entityLabel: actorName,
    actorOverride: { actorId: user.id, actorName },
  });
  const next = safeNextPath(typeof body.next === "string" ? body.next : null);
  return signInResponse(request, user.id, { next });
}
