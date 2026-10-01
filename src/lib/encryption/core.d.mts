export const FIELD_PREFIX: "bv2:";
export const DEFAULT_KEY_FILE: string;
export const SEAL_FORMAT: "blackvault-sealed-backup";

export class EncryptionKeyError extends Error {
  code: "KEY_MISSING" | "KEY_INVALID" | "KEY_CONFLICT" | "KEY_MISMATCH" | "KEY_CHECK_LOST" | "MALFORMED";
  constructor(code: "KEY_MISSING" | "KEY_INVALID" | "KEY_CONFLICT" | "KEY_MISMATCH" | "KEY_CHECK_LOST" | "MALFORMED", message: string);
}

export class SealError extends Error {
  code: "WRONG_PASSPHRASE_OR_DAMAGED" | "UNSUPPORTED" | "PASSPHRASE_TOO_SHORT";
  constructor(code: "WRONG_PASSPHRASE_OR_DAMAGED" | "UNSUPPORTED" | "PASSPHRASE_TOO_SHORT", message: string);
}

export interface FieldKeys {
  id: string;
  enc: Buffer;
  idx: Buffer;
}

export interface FileSystem {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}

export function parseKeyHex(text: string): Buffer;
export function loadMasterKey(env?: Record<string, string | undefined>, fsImpl?: FileSystem): { key: Buffer; source: string };
export function generateKeyHex(): string;
export function keyId(key: Buffer): string;
export function deriveKeys(key: Buffer): FieldKeys;
export function encryptValue(keys: FieldKeys, aad: string, plaintext: string): string;
export function decryptValue(keys: FieldKeys, aad: string, stored: string): string;
export function isEncrypted(v: unknown): v is string;
export function envelopeKeyId(stored: string): string;
export function fingerprint(keys: FieldKeys, value: string): string;
export function sealBackup(passphrase: string, json: string): string;
export function isSealedBackup(obj: unknown): boolean;
export function openBackup(passphrase: string, envelope: unknown): string;
