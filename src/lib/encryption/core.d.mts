import type { Transform } from "node:stream";

export const FIELD_PREFIX: "bv2:";
export const DEFAULT_KEY_FILE: string;
export const SEAL_FORMAT: "blackvault-sealed-backup";
export const BVB_FORMAT: "blackvault-full-backup";

export class EncryptionKeyError extends Error {
  code: "KEY_MISSING" | "KEY_INVALID" | "KEY_CONFLICT" | "KEY_MISMATCH" | "KEY_CHECK_LOST" | "MALFORMED";
  constructor(code: "KEY_MISSING" | "KEY_INVALID" | "KEY_CONFLICT" | "KEY_MISMATCH" | "KEY_CHECK_LOST" | "MALFORMED", message: string);
}

export class SealError extends Error {
  code: "WRONG_PASSPHRASE_OR_DAMAGED" | "UNSUPPORTED" | "PASSPHRASE_TOO_SHORT" | "TRUNCATED";
  constructor(code: "WRONG_PASSPHRASE_OR_DAMAGED" | "UNSUPPORTED" | "PASSPHRASE_TOO_SHORT" | "TRUNCATED", message: string);
}

export interface FieldKeys {
  id: string;
  enc: Buffer;
  idx: Buffer;
  file: Buffer;
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

export const FILE_MAGIC: "BVF1";
export function isEncryptedFile(buf: Buffer): boolean;
export function fileKeyId(buf: Buffer): string;
export function encryptFile(keys: FieldKeys, basename: string, plaintext: Buffer): Buffer;
export function decryptFile(keys: FieldKeys, basename: string, stored: Buffer): Buffer;

/** BVB1 streaming sealer: emits the length-prefixed header, then sealed 1 MiB chunks. Throws SealError PASSPHRASE_TOO_SHORT. */
export function createBackupSealer(passphrase: string): Transform;
/** BVB1 streaming opener: validates the header before deriving, then emits each chunk's plaintext
 *  only after that chunk's tag verifies. Output is NOT known to be complete or untruncated until
 *  the stream emits 'end' (a cut file yields its verified prefix, then an error) — consumers must
 *  not commit anything before 'end'. Errors with SealError WRONG_PASSPHRASE_OR_DAMAGED |
 *  UNSUPPORTED | TRUNCATED. */
export function createBackupOpener(passphrase: string): Transform;
