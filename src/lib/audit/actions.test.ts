import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./actions";

describe("AUDIT_ACTIONS", () => {
  it("is the exact 16 action strings", () => {
    expect(AUDIT_ACTIONS).toEqual([
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
    ]);
    expect(AUDIT_ACTIONS).toHaveLength(16);
  });

  it("has unique entries", () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });
});
