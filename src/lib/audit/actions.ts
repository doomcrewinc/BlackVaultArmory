// ─── Audit actions ──────────────────────────────────────────────
// Backs AuditEvent.action, a String column for the same reason as every
// other enum-like column in this schema (see the comment above model User
// in prisma/schema.base.prisma): SQLite has no native enum support and the
// schema is shared by both providers.
export const AUDIT_ACTIONS = [
  "CREATE",
  "UPDATE",
  "DELETE",
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "INVITE_CREATED",
  "INVITE_REDEEMED",
  "ROLE_CHANGED",
  "USER_DISABLED",
  "USER_ENABLED",
  "RESET_LINK_ISSUED",
  "PASSWORD_CHANGED",
  "DIRECT_ACCESS_CHANGED",
  "BACKUP_CREATED",
  "RESTORE",
  "ENCRYPTION_ENABLED",
  "KEY_ROTATED",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
