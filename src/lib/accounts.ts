// ─── Roles ──────────────────────────────────────────────────────
// Backs User.role and AuthToken.role, which are String columns in the
// schema — see the comment in prisma/schema.base.prisma above model User
// for why (SQLite has no native enum support and the schema is shared by
// both providers).
export const ROLES = ["ADMIN", "USER"] as const;

export type Role = (typeof ROLES)[number];

// ─── Auth token kinds ──────────────────────────────────────────
// Backs AuthToken.kind, a String column for the same reason as Role above.
export const AUTH_TOKEN_KINDS = ["INVITE", "RESET", "SETUP"] as const;

export type AuthTokenKind = (typeof AUTH_TOKEN_KINDS)[number];
