/** Usernames are stored lowercase so `Jeff`, ` jeff ` and `jeff` are one account. */

const USERNAME_PATTERN = /^[a-z0-9._-]+$/;
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const DISPLAY_NAME_MAX = 64;

export function normaliseUsername(input: string): string {
  return input.trim().toLowerCase();
}

/** Validates an already-normalised username. */
export function validateUsername(u: string): string | null {
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) {
    return `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters`;
  }
  if (!USERNAME_PATTERN.test(u)) return "Username may only use lowercase letters, digits, dot, dash and underscore";
  return null;
}

/** Display names are trimmed before storing; this checks the trimmed length. */
export function validateDisplayName(d: string): string | null {
  const trimmed = d.trim();
  if (trimmed.length === 0) return "Display name is required";
  if (trimmed.length > DISPLAY_NAME_MAX) return `Display name must be at most ${DISPLAY_NAME_MAX} characters`;
  return null;
}
