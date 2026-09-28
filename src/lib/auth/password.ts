import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Password hashing with node:crypto scrypt — no native dependency, which matters on the
 * Alpine image. The stored string carries its own parameters so they can be raised later
 * and old hashes still verify (verifyPassword reports needsRehash). Format:
 *   scrypt$N$r$p$<salt base64>$<hash base64>
 */

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;

type Params = { N: number; r: number; p: number };
// Chosen so one verify takes roughly 50–100 ms on the maintainer's hardware; the
// measured value is recorded in the task report.
const CURRENT: Params = { N: 65536, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function scrypt(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 128 * params.N * params.r * 2 };
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize("NFC"), salt, KEY_LENGTH, options, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters`;
  return null;
}

export async function hashPassword(password: string, params: Params = CURRENT): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function parse(stored: string): { params: Params; salt: Buffer; key: Buffer } | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map((v) => (/^\d+$/.test(v) ? Number(v) : NaN));
  const salt = Buffer.from(parts[4], "base64");
  const key = Buffer.from(parts[5], "base64");
  if (![N, r, p].every(Number.isSafeInteger) || salt.length === 0 || key.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt, key };
}

export async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; needsRehash: boolean }> {
  const parsed = parse(stored);
  if (!parsed) return { ok: false, needsRehash: false };
  let candidate: Buffer;
  try {
    candidate = await scrypt(password, parsed.salt, parsed.params);
  } catch {
    return { ok: false, needsRehash: false };
  }
  const ok = timingSafeEqual(candidate, parsed.key);
  const { N, r, p } = parsed.params;
  const needsRehash = ok && (N < CURRENT.N || r < CURRENT.r || p < CURRENT.p);
  return { ok, needsRehash };
}

const DUMMY_SALT = randomBytes(SALT_BYTES);

/** Spends the same time as a real verify, so an unknown username is not faster to reject. */
export async function dummyVerify(password: string): Promise<void> {
  await scrypt(password, DUMMY_SALT, CURRENT);
}
