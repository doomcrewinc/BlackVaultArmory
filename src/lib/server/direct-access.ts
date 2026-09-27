import { prisma } from "@/lib/prisma";

/**
 * Whether BlackVault serves requests that bypass the reverse proxy
 * (http://<ip>:<port>). ALLOW_DIRECT_ACCESS=true is the break-glass override;
 * otherwise AppSettings.allowDirectAccess decides, seeded once at first boot
 * from DIRECT_ACCESS_INITIAL. The TCP gate and proxy.ts both read it, on every
 * connection / request, so it is cached.
 */

export type DirectAccessState = { allowed: boolean; source: "env" | "setting" };

const TTL_MS = 5_000;
let cache: { value: boolean; at: number } | null = null;
let lastKnown: boolean | null = null;

export function envForcesDirectAccess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_DIRECT_ACCESS === "true";
}

function seedValue(env: NodeJS.ProcessEnv): boolean {
  return env.DIRECT_ACCESS_INITIAL?.trim().toLowerCase() === "on";
}

export async function seedDirectAccessSetting(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const value = seedValue(env);
  // Conditional: only a still-null value is written, so a later decision (the
  // settings UI, spec 2) is never overwritten by a stale seed left in .env.
  const { count } = await prisma.appSettings.updateMany({
    where: { id: "singleton", allowDirectAccess: null },
    data: { allowDirectAccess: value },
  });
  if (count > 0) return;
  const existing = await prisma.appSettings.findUnique({ where: { id: "singleton" }, select: { id: true } });
  if (!existing) await prisma.appSettings.create({ data: { id: "singleton", allowDirectAccess: value } });
}

export async function readStoredDirectAccess(now: number = Date.now()): Promise<boolean> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  try {
    const row = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { allowDirectAccess: true },
    });
    const value = row?.allowDirectAccess ?? false;
    cache = { value, at: now };
    lastKnown = value;
    return value;
  } catch (error) {
    console.error("[direct-access] settings read failed; using the last known value:", error);
    return lastKnown ?? false;
  }
}

export async function getDirectAccessState(env: NodeJS.ProcessEnv = process.env): Promise<DirectAccessState> {
  if (envForcesDirectAccess(env)) return { allowed: true, source: "env" };
  return { allowed: await readStoredDirectAccess(), source: "setting" };
}

export function resetDirectAccessCacheForTests(): void {
  cache = null;
  lastKnown = null;
}
