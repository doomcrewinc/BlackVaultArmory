import { PASSWORD_MIN } from "@/lib/auth/password-policy";

/**
 * Client-side guard shared by SetupForm and RedeemForm, checked before the network call.
 * Length is checked before match (mirrors the order SetupForm always used): a short,
 * mismatched pair reports the length error, not the mismatch. Returns null when the
 * password is acceptable to submit.
 */
export function checkNewPassword(password: string, confirmPassword: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters`;
  if (password !== confirmPassword) return "Passwords do not match";
  return null;
}
