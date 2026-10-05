/**
 * Which schema models the audit log records, and why the rest are not.
 *
 * Why this exists: the same shape of bug that hit BACKUP_MODELS (see
 * src/lib/backup/models.ts) can hit an audit log — a model added to the
 * schema and never wired into the write path silently goes unaudited.
 * registry.test.ts fails if any schema model is neither registered here nor
 * explicitly excluded below, the same guard as models.test.ts.
 */
export const AUDITED_MODELS: readonly string[] = [
  "Firearm",
  "Accessory",
  "AmmoStock",
  "AmmoTransaction",
  "Gear",
  "Supply",
  "Kit",
  "KitItem",
  "Build",
  "BuildSlot",
  "Document",
  "Photo",
  "MaintenanceLog",
  "BatteryChangeLog",
  "RangeSession",
  "RangeSessionAmmoLink",
  "SessionDrill",
  "RoundCountLog",
  "AppSettings",
];

/** Model name -> why it is never written to the audit log. */
export const AUDIT_EXCLUDED_MODELS: Record<string, string> = {
  Session: "Session churn (every request bumps lastSeenAt) is not an inventory change; it would flood the log with noise.",
  AuthToken: "Issuance and redemption are already recorded as their own audit actions (INVITE_CREATED, INVITE_REDEEMED, RESET_LINK_ISSUED); the token row itself holds only hashes.",
  User: "Account changes are recorded as their own audit actions (ROLE_CHANGED, USER_DISABLED, USER_ENABLED, PASSWORD_CHANGED, LOGIN, LOGIN_FAILED, LOGOUT) rather than generic CREATE/UPDATE/DELETE on the User row.",
  ImageCache: "Fetch/cache housekeeping, not user inventory data.",
  DateNormalizationAudit: "Its own migration audit trail; auditing it would audit the auditor.",
  CapturePass: "Creation and closing are recorded as their own audit actions (CAPTURE_PASS_CREATED, CAPTURE_PASS_CLOSED); the row holds only a token hash and a counter.",
  AuditEvent: "The audit log itself is append-only and never updated or deleted; auditing it would recurse forever.",
};

export function isAudited(model: string): boolean {
  return AUDITED_MODELS.includes(model);
}
