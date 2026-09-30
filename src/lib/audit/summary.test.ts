import { describe, expect, it } from "vitest";
import { summarize } from "./summary";
import { REDACTED } from "./redact";
import type { AuditEventDto } from "./query";

/**
 * `summarize()` turns one AuditEventDto into the one-line description the
 * audit list and item-history views render — one case per AUDIT_ACTIONS
 * entry (16), plus redaction and pluralisation of DELETE's `_children`
 * counts. docs/superpowers/specs/2026-09-29-audit-log-design.md, "UI".
 */

const BASE: AuditEventDto = {
  id: "e1",
  at: "2026-09-29T12:00:00.000Z",
  actorId: "u1",
  actorName: "Jeff (@jeff)",
  actorIp: null,
  action: "CREATE",
  entityType: null,
  entityId: null,
  entityLabel: null,
  changes: null,
};

function event(overrides: Partial<AuditEventDto>): AuditEventDto {
  return { ...BASE, ...overrides };
}

describe("summarize — inventory writes", () => {
  it("CREATE", () => {
    const e = event({
      action: "CREATE",
      entityType: "Firearm",
      entityLabel: "Glock 19 (9mm)",
      changes: { name: "Glock 19" },
    });
    expect(summarize(e)).toBe('Created firearm "Glock 19 (9mm)"');
  });

  it("UPDATE with one changed field", () => {
    const e = event({
      action: "UPDATE",
      entityType: "Firearm",
      entityLabel: "Glock 19",
      changes: { status: ["Active", "Sold"] },
    });
    expect(summarize(e)).toBe('Changed "Glock 19": status Active → Sold');
  });

  it("UPDATE with multiple changed fields joins them", () => {
    const e = event({
      action: "UPDATE",
      entityType: "Firearm",
      entityLabel: "Glock 19",
      changes: { status: ["Active", "Sold"], notes: [null, "Sold to a friend"] },
    });
    expect(summarize(e)).toBe('Changed "Glock 19": status Active → Sold, notes — → Sold to a friend');
  });

  it("UPDATE of a redacted field never shows the value, only that it changed", () => {
    const e = event({
      action: "UPDATE",
      entityType: "Firearm",
      entityLabel: "Glock 19",
      changes: { serialNumber: [REDACTED, REDACTED] },
    });
    expect(summarize(e)).toBe('Changed "Glock 19": serial number changed');
  });

  it("UPDATE ignores the _nested key", () => {
    const e = event({
      action: "UPDATE",
      entityType: "Build",
      entityLabel: "Home Defense",
      changes: { status: ["Active", "Sold"], _nested: { slots: [] } },
    });
    expect(summarize(e)).toBe('Changed "Home Defense": status Active → Sold');
  });

  it("DELETE with no cascaded children", () => {
    const e = event({
      action: "DELETE",
      entityType: "Accessory",
      entityLabel: "Holosun 507C (OPTIC)",
      changes: { name: "Holosun 507C" },
    });
    expect(summarize(e)).toBe('Deleted accessory "Holosun 507C (OPTIC)"');
  });

  it("DELETE with one child type, pluralised", () => {
    const e = event({
      action: "DELETE",
      entityType: "Firearm",
      entityLabel: "Glock 19 (9mm)",
      changes: { name: "Glock 19", _children: { MaintenanceLog: 12 } },
    });
    expect(summarize(e)).toBe('Deleted firearm "Glock 19 (9mm)" and 12 maintenance entries');
  });

  it("DELETE with exactly one cascaded child uses the singular", () => {
    const e = event({
      action: "DELETE",
      entityType: "Firearm",
      entityLabel: "Glock 19 (9mm)",
      changes: { name: "Glock 19", _children: { MaintenanceLog: 1 } },
    });
    expect(summarize(e)).toBe('Deleted firearm "Glock 19 (9mm)" and 1 maintenance entry');
  });

  it("DELETE with multiple child types joins them", () => {
    const e = event({
      action: "DELETE",
      entityType: "Firearm",
      entityLabel: "Glock 19 (9mm)",
      changes: { name: "Glock 19", _children: { MaintenanceLog: 2, Build: 1 } },
    });
    expect(summarize(e)).toBe('Deleted firearm "Glock 19 (9mm)" and 2 maintenance entries and 1 build entry');
  });

  it("DELETE ignores zero-count children", () => {
    const e = event({
      action: "DELETE",
      entityType: "Firearm",
      entityLabel: "Glock 19",
      changes: { name: "Glock 19", _children: { MaintenanceLog: 0 } },
    });
    expect(summarize(e)).toBe('Deleted firearm "Glock 19"');
  });
});

describe("summarize — sign-ins", () => {
  it("LOGIN", () => {
    const e = event({ action: "LOGIN", entityType: "User", entityLabel: "Jeff (@jeff)" });
    expect(summarize(e)).toBe("Jeff signed in");
  });

  it("LOGIN_FAILED names the attempted username, no actor", () => {
    const e = event({
      action: "LOGIN_FAILED",
      actorId: null,
      actorName: "anonymous",
      changes: { username: "jef" },
    });
    expect(summarize(e)).toBe('Failed sign-in for "jef"');
  });

  it("LOGOUT", () => {
    const e = event({ action: "LOGOUT", entityType: "User", entityLabel: "Jeff (@jeff)" });
    expect(summarize(e)).toBe("Jeff signed out");
  });

  it("LOGOUT of every session", () => {
    const e = event({
      action: "LOGOUT",
      entityType: "User",
      entityLabel: "Jeff (@jeff)",
      changes: { allSessions: true },
    });
    expect(summarize(e)).toBe("Jeff signed out of all sessions");
  });
});

describe("summarize — security events", () => {
  it("INVITE_CREATED", () => {
    const e = event({ action: "INVITE_CREATED", actorName: "Ann (@ann)", changes: { role: "USER" } });
    expect(summarize(e)).toBe("Ann created a USER invite");
  });

  it("INVITE_REDEEMED", () => {
    const e = event({
      action: "INVITE_REDEEMED",
      entityType: "User",
      entityLabel: "Jeff (@jeff)",
      changes: { role: "USER" },
    });
    expect(summarize(e)).toBe("Jeff joined as USER");
  });

  it("ROLE_CHANGED", () => {
    const e = event({
      action: "ROLE_CHANGED",
      entityType: "User",
      entityLabel: "Jeff (@jeff)",
      changes: { from: "USER", to: "ADMIN" },
    });
    expect(summarize(e)).toBe('Changed "Jeff (@jeff)" role: USER → ADMIN');
  });

  it("USER_DISABLED", () => {
    const e = event({ action: "USER_DISABLED", entityType: "User", entityLabel: "Jeff (@jeff)" });
    expect(summarize(e)).toBe('Disabled "Jeff (@jeff)"');
  });

  it("USER_ENABLED", () => {
    const e = event({ action: "USER_ENABLED", entityType: "User", entityLabel: "Jeff (@jeff)" });
    expect(summarize(e)).toBe('Enabled "Jeff (@jeff)"');
  });

  it("RESET_LINK_ISSUED", () => {
    const e = event({ action: "RESET_LINK_ISSUED", entityType: "User", entityLabel: "Jeff (@jeff)" });
    expect(summarize(e)).toBe('Issued a reset link for "Jeff (@jeff)"');
  });

  it("PASSWORD_CHANGED", () => {
    const e = event({ action: "PASSWORD_CHANGED", entityType: "User", entityLabel: "Jeff (@jeff)" });
    expect(summarize(e)).toBe('Changed the password for "Jeff (@jeff)"');
  });

  it("DIRECT_ACCESS_CHANGED enabled", () => {
    const e = event({ action: "DIRECT_ACCESS_CHANGED", changes: { from: false, to: true } });
    expect(summarize(e)).toBe("Direct access enabled");
  });

  it("DIRECT_ACCESS_CHANGED disabled", () => {
    const e = event({ action: "DIRECT_ACCESS_CHANGED", changes: { from: true, to: false } });
    expect(summarize(e)).toBe("Direct access disabled");
  });

  it("BACKUP_CREATED", () => {
    const e = event({ action: "BACKUP_CREATED", changes: { file: "blackvault-2026-09-29.zip" } });
    expect(summarize(e)).toBe("Created backup blackvault-2026-09-29.zip");
  });

  it("RESTORE", () => {
    const e = event({ action: "RESTORE", changes: { counts: { Firearm: 3 } } });
    expect(summarize(e)).toBe("Restored the database from backup");
  });
});

describe("summarize — defensive fallback", () => {
  it("never throws on an unrecognised action, still says who and what", () => {
    const e = event({ action: "SOMETHING_NEW", entityType: "Firearm", entityLabel: "Glock 19" });
    expect(() => summarize(e)).not.toThrow();
    expect(summarize(e)).toContain("Glock 19");
  });

  it("never throws on malformed changes", () => {
    const e = event({ action: "UPDATE", entityLabel: "Glock 19", changes: "not an object" });
    expect(() => summarize(e)).not.toThrow();
  });
});
