import { prisma } from "@/lib/prisma";

/** Whether any account exists. Once true it never goes back, so it is cached forever. */
let known = false;
let checkedAt = 0;

export async function hasAnyUser(now: number = Date.now()): Promise<boolean> {
  if (known) return true;
  if (now - checkedAt < 5_000) return false;
  checkedAt = now;
  try {
    known = (await prisma.user.count()) > 0;
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
