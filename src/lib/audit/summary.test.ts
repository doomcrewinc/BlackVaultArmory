import { describe, expect, it } from "vitest";
import { summarize, displayValue, detailEntries } from "./summary";
import { REDACTED } from "./redact";
import { AUDIT_ACTIONS } from "./actions";
import type { AuditEventDto } from "./query";

/**
 * `summarize()` turns one AuditEventDto into the one-line description the
 * audit list and item-history views render — one case per AUDIT_ACTIONS
 * entry (18), plus redaction and pluralisation of DELETE's `_children`
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

  it("RESTORE with the backup file name", () => {
    const e = event({ action: "RESTORE", changes: { file: "blackvault-backup-2026-09-29.json", counts: { Firearm: 3 } } });
    expect(summarize(e)).toBe("Restored the database from backup blackvault-backup-2026-09-29.json");
  });

  // field-encryption spec §Restore: RESTORE's `changes` gains `sealed`.
  it("RESTORE flags an unsealed (plain) backup file", () => {
    const e = event({ action: "RESTORE", changes: { file: "old-backup.json", counts: { Firearm: 3 }, sealed: false } });
    expect(summarize(e)).toBe("Restored the database from backup old-backup.json (unsealed backup)");
  });

  it("RESTORE from a sealed backup reads the same as before — nothing to flag", () => {
    const e = event({ action: "RESTORE", changes: { file: "backup.sealed.json", counts: { Firearm: 3 }, sealed: true } });
    expect(summarize(e)).toBe("Restored the database from backup backup.sealed.json");
  });
});

describe("summarize — encryption events", () => {
  it("ENCRYPTION_ENABLED lists the per-model counts, pluralised", () => {
    const e = event({
      action: "ENCRYPTION_ENABLED",
      actorName: "system",
      changes: { counts: { Firearm: 42, Accessory: 7, Gear: 1 }, keyId: "abcd1234" },
    });
    expect(summarize(e)).toBe("Encryption enabled: 42 firearms, 7 accessories, 1 gear item");
  });

  it("ENCRYPTION_ENABLED singular forms, zero counts left out", () => {
    const e = event({ action: "ENCRYPTION_ENABLED", changes: { counts: { Firearm: 1, Accessory: 1, Gear: 0 } } });
    expect(summarize(e)).toBe("Encryption enabled: 1 firearm, 1 accessory");
  });

  it("ENCRYPTION_ENABLED without counts still reads as a sentence", () => {
    expect(summarize(event({ action: "ENCRYPTION_ENABLED", changes: null }))).toBe("Encryption enabled");
  });

  it("ENCRYPTION_ENABLED mentions scrubbed audit rows alongside the counts (Task 4b)", () => {
    const e = event({
      action: "ENCRYPTION_ENABLED",
      changes: { counts: { Firearm: 1, Accessory: 0, Gear: 0 }, keyId: "abcd1234", scrubbedAuditRows: 3 },
    });
    expect(summarize(e)).toBe("Encryption enabled: 1 firearm, 3 audit entries scrubbed");
  });

  it("ENCRYPTION_ENABLED: scrubbed audit rows alone, with every count at 0, still reads as a sentence (Task 4b)", () => {
    const e = event({
      action: "ENCRYPTION_ENABLED",
      changes: { counts: { Firearm: 0, Accessory: 0, Gear: 0 }, keyId: "abcd1234", scrubbedAuditRows: 1 },
    });
    expect(summarize(e)).toBe("Encryption enabled: 1 audit entry scrubbed");
  });

  it("ENCRYPTION_ENABLED: scrubbedAuditRows of 0 is left out, same as an absent field", () => {
    const e = event({
      action: "ENCRYPTION_ENABLED",
      changes: { counts: { Firearm: 1 }, keyId: "abcd1234", scrubbedAuditRows: 0 },
    });
    expect(summarize(e)).toBe("Encryption enabled: 1 firearm");
  });

  it("KEY_ROTATED names both key ids", () => {
    const e = event({ action: "KEY_ROTATED", changes: { from: "abcd1234", to: "ef567890", counts: { Firearm: 3 } } });
    expect(summarize(e)).toBe("Encryption key rotated (abcd1234 → ef567890)");
  });

  it("KEY_ROTATED without ids", () => {
    expect(summarize(event({ action: "KEY_ROTATED", changes: null }))).toBe("Encryption key rotated");
  });

  it("FILES_ENCRYPTED lists encrypted images and documents, moved documents and missing documents", () => {
    const e = event({
      action: "FILES_ENCRYPTED",
      changes: { counts: { images: 3, documents: 1 }, moved: 2, missing: [{ id: "d1", name: "x" }], missingTotal: 1, keyId: "abcd1234", snapshot: "/s" },
    });
    expect(summarize(e)).toBe("Files encrypted: 3 photos, 1 document; 2 documents moved; 1 document missing");
  });

  it("FILES_ENCRYPTED singular/plural, zero parts left out, missingTotal preferred over the capped list", () => {
    const e = event({
      action: "FILES_ENCRYPTED",
      changes: { counts: { images: 1, documents: 0 }, moved: 0, missing: [{ id: "d1", name: "x" }], missingTotal: 250 },
    });
    expect(summarize(e)).toBe("Files encrypted: 1 photo; 250 documents missing");
  });

  it("FILES_ENCRYPTED with only missing documents, or no changes at all, still reads as a sentence", () => {
    expect(summarize(event({ action: "FILES_ENCRYPTED", changes: { counts: { images: 0, documents: 0 }, moved: 0, missing: [], missingTotal: 2 } }))).toBe(
      "Uploaded files checked: 2 documents missing",
    );
    expect(summarize(event({ action: "FILES_ENCRYPTED", changes: null }))).toBe("Uploaded files encrypted");
  });
});

describe("summarize — exhaustiveness (Fix round 1, item 6)", () => {
  // The `default` branch silently handles any action with no dedicated case,
  // producing "<ACTION> — <who>[ — "label"]" — this iterates every real
  // action and asserts none of them fall through to it.
  it.each(AUDIT_ACTIONS)("action %s produces a real summary, not the default fallback shape", (action) => {
    const e = event({ action, entityType: "Firearm", entityLabel: "Glock 19" });
    expect(summarize(e)).not.toMatch(/^[A-Z_]+ — /);
  });
});

describe("summarize — dates render formatted, not raw ISO (Fix round 1, item 2)", () => {
  it("a date-only field's before/after render as a calendar day", () => {
    const e = event({
      action: "UPDATE",
      entityType: "Firearm",
      entityLabel: "Glock 19",
      changes: { acquisitionDate: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"] },
    });
    expect(summarize(e)).toBe('Changed "Glock 19": acquisition date Sep 1, 2026 → Sep 2, 2026');
  });

  it("a non-date-only timestamp field's before/after render as local date + time, not raw ISO", () => {
    const after = new Date(2026, 8, 29, 20, 32, 4).toISOString(); // local 8:32 PM, any zone
    const e = event({
      action: "UPDATE",
      entityType: "AppSettings",
      entityLabel: "Settings",
      changes: { cachedAt: ["2026-09-29T20:00:00.000Z", after] },
    });
    const text = summarize(e);
    expect(text).not.toContain(after);
    expect(text).toContain("8:32 PM");
  });
});

describe("displayValue (Fix round 1, item 2)", () => {
  it("renders a non-date-only ISO instant as local date + time", () => {
    expect(displayValue(new Date(2026, 8, 29, 20, 32, 4).toISOString())).toBe("Sep 29, 2026, 8:32 PM");
  });

  it("renders a date-only ISO instant as a bare calendar day", () => {
    expect(displayValue("2026-09-30T00:00:00.000Z", true)).toBe("Sep 30, 2026");
  });

  it("renders an object as compact JSON, not [object Object] (RESTORE's `counts`)", () => {
    expect(displayValue({ Firearm: 3, Accessory: 1 })).toBe(JSON.stringify({ Firearm: 3, Accessory: 1 }));
  });

  it("still renders a dash for null/empty and Yes/No for booleans", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue("")).toBe("—");
    expect(displayValue(true)).toBe("Yes");
    expect(displayValue(false)).toBe("No");
  });

  it("leaves an ordinary non-date string untouched", () => {
    expect(displayValue("Active")).toBe("Active");
  });
});

describe("detailEntries — date-kind and redaction awareness (Fix round 1, item 2 and item 1's redaction fix)", () => {
  it("flags a field the app's DATE_ONLY_FIELDS registry lists for this model", () => {
    const entries = detailEntries(
      { acquisitionDate: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"] },
      "Firearm",
    );
    expect(entries[0].dateOnly).toBe(true);
  });

  it("does not flag the same field name as date-only for a model where it isn't registered", () => {
    const entries = detailEntries({ date: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"] }, "Firearm");
    expect(entries[0].dateOnly).toBe(false);
  });

  it("classification is model-scoped: MaintenanceLog.date IS date-only", () => {
    const entries = detailEntries({ date: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"] }, "MaintenanceLog");
    expect(entries[0].dateOnly).toBe(true);
  });

  it("flags a sensitive field name as redacted even when the stored value is not literally the REDACTED sentinel (defense in depth for a row the read-path redaction in query.ts somehow missed)", () => {
    const entries = detailEntries({ serialNumber: "RAW-VALUE-THAT-SLIPPED-THROUGH" }, "Firearm");
    expect(entries[0].redacted).toBe(true);
  });

  it("RESTORE's `counts` becomes a value entry whose displayValue is compact JSON", () => {
    const entries = detailEntries({ counts: { Firearm: 3, Accessory: 1 } }, null);
    expect(entries[0].kind).toBe("value");
    expect(displayValue(entries[0].kind === "value" ? entries[0].value : undefined)).toBe(
      '{"Firearm":3,"Accessory":1}',
    );
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
