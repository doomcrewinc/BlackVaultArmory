/**
 * The full backup's `manifest.json` — the first entry in the plaintext ustar
 * stream (spec §1 "Plaintext stream"). It records what a restore should find
 * inside the archive: per-model row counts, and every file's path, size and
 * sha256, plus any file that vanished mid-backup (`skipped`).
 *
 * `buildManifest` and `parseManifest` share the same field validators, so a
 * manifest `buildManifest` produces is guaranteed to pass `parseManifest` —
 * there is exactly one definition of "a valid manifest" in this file.
 *
 * No crypto, no filesystem access here. `keyIdAtBackup` is a plain string the
 * caller already derived (via `keyId()` in `core.mjs`) — this module never
 * touches key material, matching the rule that crypto lives only in
 * `core.mjs`.
 */

/** Bumped only if the manifest shape changes incompatibly. `parseManifest` rejects anything else. */
export const MANIFEST_FORMAT_VERSION = 1;

export interface ManifestFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ManifestSkippedEntry {
  path: string;
  reason: string;
}

export interface Manifest {
  formatVersion: number;
  appVersion: string;
  createdAt: string;
  keyIdAtBackup: string;
  counts: Record<string, number>;
  files: ManifestFileEntry[];
  skipped: ManifestSkippedEntry[];
}

export interface BuildManifestInput {
  appVersion: string;
  /** Defaults to `new Date()` when omitted. Accepts a Date or an already-ISO string. */
  createdAt?: Date | string;
  keyIdAtBackup: string;
  counts: Record<string, number>;
  files: ManifestFileEntry[];
  skipped?: ManifestSkippedEntry[];
}

export class ManifestError extends Error {}

function fail(message: string): never {
  throw new ManifestError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`manifest.${field} must be a non-empty string`);
  return value;
}

function validateIsoDate(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`manifest.${field} must be an ISO 8601 date string`);
  }
  return value;
}

function validateCounts(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) fail("manifest.counts must be an object");
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      fail(`manifest.counts.${key} must be a non-negative integer`);
    }
    counts[key] = count;
  }
  return counts;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function validateFileEntry(value: unknown, index: number): ManifestFileEntry {
  if (!isPlainObject(value)) fail(`manifest.files[${index}] must be an object`);
  const path = validateNonEmptyString(value.path, `files[${index}].path`);
  const size = value.size;
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
    fail(`manifest.files[${index}].size must be a non-negative integer`);
  }
  const sha256 = value.sha256;
  if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
    fail(`manifest.files[${index}].sha256 must be a 64-character lowercase hex string`);
  }
  return { path, size, sha256 };
}

function validateSkippedEntry(value: unknown, index: number): ManifestSkippedEntry {
  if (!isPlainObject(value)) fail(`manifest.skipped[${index}] must be an object`);
  const path = validateNonEmptyString(value.path, `skipped[${index}].path`);
  const reason = validateNonEmptyString(value.reason, `skipped[${index}].reason`);
  return { path, reason };
}

function validateFiles(value: unknown): ManifestFileEntry[] {
  if (!Array.isArray(value)) fail("manifest.files must be an array");
  return value.map((entry, i) => validateFileEntry(entry, i));
}

function validateSkipped(value: unknown): ManifestSkippedEntry[] {
  if (!Array.isArray(value)) fail("manifest.skipped must be an array");
  return value.map((entry, i) => validateSkippedEntry(entry, i));
}

/** Builds a manifest, validating every field the same way `parseManifest` will. */
export function buildManifest(input: BuildManifestInput): Manifest {
  const createdAtRaw = input.createdAt instanceof Date ? input.createdAt.toISOString() : input.createdAt ?? new Date().toISOString();

  const manifest: Manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    appVersion: validateNonEmptyString(input.appVersion, "appVersion"),
    createdAt: validateIsoDate(createdAtRaw, "createdAt"),
    keyIdAtBackup: validateNonEmptyString(input.keyIdAtBackup, "keyIdAtBackup"),
    counts: validateCounts(input.counts),
    files: validateFiles(input.files),
    skipped: validateSkipped(input.skipped ?? []),
  };
  return manifest;
}

/** Parses and validates `manifest.json`'s bytes (or text). Rejects malformed JSON, a wrong shape, and any `formatVersion` other than the one this build understands. */
export function parseManifest(data: Buffer | string): Manifest {
  const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fail(`manifest.json is not valid JSON: ${(err as Error).message}`);
  }

  if (!isPlainObject(parsed)) fail("manifest.json must be a JSON object");

  const formatVersion = parsed.formatVersion;
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
    fail("manifest.formatVersion must be an integer");
  }
  if (formatVersion !== MANIFEST_FORMAT_VERSION) {
    fail(`unsupported manifest formatVersion ${formatVersion} (this build understands ${MANIFEST_FORMAT_VERSION})`);
  }

  return {
    formatVersion,
    appVersion: validateNonEmptyString(parsed.appVersion, "appVersion"),
    createdAt: validateIsoDate(parsed.createdAt, "createdAt"),
    keyIdAtBackup: validateNonEmptyString(parsed.keyIdAtBackup, "keyIdAtBackup"),
    counts: validateCounts(parsed.counts),
    files: validateFiles(parsed.files),
    skipped: validateSkipped(parsed.skipped),
  };
}
