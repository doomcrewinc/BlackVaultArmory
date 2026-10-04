import { deriveKeys, loadMasterKey, type FieldKeys } from "./core.mjs";

/**
 * The field-encryption subkeys, loaded once per process.
 *
 * Lazy on purpose: nothing here runs at import time, so importing
 * src/lib/prisma.ts — which `next build` does while collecting pages — never
 * needs a key. The key is read on the first encrypted read or write; a missing
 * or invalid key surfaces there as an EncryptionKeyError (and at startup,
 * before any request is served: ./startup.ts).
 *
 * Imports stay relative (no `@/`): src/lib/prisma.ts reaches this file and
 * scripts load that under plain ts-node, which has no path aliases.
 */

export type { FieldKeys };

let cached: FieldKeys | null = null;

/** The derived subkeys (`{ id, enc, idx }`), loaded from the key file or env on first use. */
export function getFieldKeys(): FieldKeys {
  if (!cached) cached = deriveKeys(loadMasterKey(process.env).key);
  return cached;
}

/** Forgets the cached keys, so the next call reloads from the environment. Tests only. */
export function resetFieldKeysForTests(): void {
  cached = null;
}
