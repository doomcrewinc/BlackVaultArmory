import { prisma } from "@/lib/prisma";

/** Whether any account exists. Once true it never goes back, so it is cached forever. */
let known = false;
let checkedAt = 0;

export async function hasAnyUser(now: number = Date.now()): Promise<boolean> {
  if (known) return true;
  if (now - checkedAt < 5_000) return false;
  checkedAt = now;
  try {
    // Only ever SET known to true from a positive count — never assign it
    // false. A concurrent markUsersExist() (another request's setup flow
    // finishing while this count() is in flight) can otherwise be clobbered
    // by this call's now-stale 0, flipping known back to false and trapping
    // the brand-new admin in a `/` <-> `/setup` redirect loop for up to 5s.
    if ((await prisma.user.count()) > 0) known = true;
  } catch (error) {
    console.error("[auth] user count failed:", error);
    return false;
  }
  return known;
}

export function markUsersExist() {
  known = true;
}

export function resetSetupStateForTests() {
  known = false;
  checkedAt = 0;
}
