import { validateEntryPath } from "./tar";

/**
 * The full backup's `manifest.json` — the LAST entry in the plaintext ustar
 * stream (order: db.json, files/..., manifest.json; controller ruling in fix
 * round 1, overriding the spec's "first", so the engine can hash files while
 * streaming them and record files that vanish mid-run). It records what a restore should find
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

/**
 * Upper bound on `manifest.json`'s size. `readTar` allows entries up to
 * ~8 GiB, so callers must check the entry's declared tar size against this
 * BEFORE buffering it; `parseManifest` also refuses anything larger.
 */
export const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/** Every `files[].path` lives under one of these. */
const FILE_PATH_ROOTS = ["files/images/", "files/documents/"] as const;

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

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Exactly the shape `Date.prototype.toISOString()` produces, and a real date (no Feb 30). */
function validateIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`manifest.${field} must be a full ISO-8601 UTC timestamp like 2026-10-02T12:00:00.000Z`);
  }
  return value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateCounts(value: unknown): Record<string, number> {
  if (!isPlainObject(value)) fail("manifest.counts must be an object");
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    // JSON.parse makes "__proto__" an own key; assigning it below would set
    // the prototype instead (silently dropping the count). Reject it.
    if (key === "__proto__") fail("manifest.counts must not contain a __proto__ key");
    if (!isNonNegativeSafeInteger(count)) {
      fail(`manifest.counts.${key} must be a non-negative safe integer`);
    }
    counts[key] = count;
  }
  return counts;
}

/** The tar reader's path rule, plus: the path must sit under files/images/ or files/documents/. */
function validateFilePath(value: unknown, field: string): string {
  const path = validateNonEmptyString(value, field);
  try {
    validateEntryPath(path);
  } catch (err) {
    fail(`manifest.${field} is not a valid archive path: ${(err as Error).message}`);
  }
  if (!FILE_PATH_ROOTS.some((root) => path.startsWith(root))) {
    fail(`manifest.${field} must start with ${FILE_PATH_ROOTS.join(" or ")}: ${path}`);
  }
  return path;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function validateFileEntry(value: unknown, index: number): ManifestFileEntry {
  if (!isPlainObject(value)) fail(`manifest.files[${index}] must be an object`);
  const path = validateFilePath(value.path, `files[${index}].path`);
  const size = value.size;
  if (!isNonNegativeSafeInteger(size)) {
    fail(`manifest.files[${index}].size must be a non-negative safe integer`);
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
  const files = value.map((entry, i) => validateFileEntry(entry, i));
  const seen = new Set<string>();
  files.forEach((file, i) => {
    if (seen.has(file.path)) fail(`manifest.files[${i}].path is a duplicate: ${file.path}`);
    seen.add(file.path);
  });
  return files;
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
    createdAt: validateIsoTimestamp(createdAtRaw, "createdAt"),
    keyIdAtBackup: validateNonEmptyString(input.keyIdAtBackup, "keyIdAtBackup"),
    counts: validateCounts(input.counts),
    files: validateFiles(input.files),
    skipped: validateSkipped(input.skipped ?? []),
  };
  return manifest;
}

/** Parses and validates `manifest.json`'s bytes (or text). Rejects input over `MAX_MANIFEST_BYTES`, malformed JSON, a wrong shape, and any `formatVersion` other than the one this build understands. */
export function parseManifest(data: Buffer | string): Manifest {
  const byteLength = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data, "utf8");
  if (byteLength > MAX_MANIFEST_BYTES) {
    fail(`manifest.json is too large (${byteLength} bytes, over MAX_MANIFEST_BYTES ${MAX_MANIFEST_BYTES})`);
  }
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
    createdAt: validateIsoTimestamp(parsed.createdAt, "createdAt"),
    keyIdAtBackup: validateNonEmptyString(parsed.keyIdAtBackup, "keyIdAtBackup"),
    counts: validateCounts(parsed.counts),
    files: validateFiles(parsed.files),
    skipped: validateSkipped(parsed.skipped),
  };
}
