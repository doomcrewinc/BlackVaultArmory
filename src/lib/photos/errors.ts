/** The error's class name and `code` when it has one: enough to diagnose, never its message. */
export function describeError(e: unknown): string {
  const name = e instanceof Error ? e.name : typeof e;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" || typeof code === "number" ? `${name} ${code}` : name;
}

/** The answer for an upload that failed because the uploads folder is not writable. */
export const UPLOADS_NOT_WRITABLE_MESSAGE =
  "The server cannot write to its uploads folder. Ask the person who runs this BlackVault to check the folder's permissions.";

const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

/** The error text to send for a failed upload: the permission message when the cause was one, else `fallback`. */
export function uploadFailureMessage(e: unknown, fallback: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && PERMISSION_CODES.has(code) ? UPLOADS_NOT_WRITABLE_MESSAGE : fallback;
}
