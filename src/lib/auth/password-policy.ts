/**
 * Client-safe password policy constants. Kept separate from password.ts because that
 * module imports node:crypto (scrypt) and must never end up in a client bundle — this
 * file has no such import, so client components (LoginForm/SetupForm/RedeemForm) can
 * import PASSWORD_MIN directly for client-side validation.
 */
export const PASSWORD_MIN = 12;
