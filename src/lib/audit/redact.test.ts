import { describe, expect, it } from "vitest";
import { REDACTED, diffRecords, isRedactedField, redactRecord, redactStoredChanges } from "./redact";

describe("isRedactedField", () => {
  it("redacts known-sensitive field names", () => {
    for (const field of ["serialNumber", "passwordHash", "tokenHash", "googleCseApiKey", "apiSecret", "resetToken"]) {
      expect(isRedactedField(field), field).toBe(true);
    }
  });

  it("does not redact ordinary fields", () => {
    for (const field of ["name", "caliber"]) {
      expect(isRedactedField(field), field).toBe(false);
    }
  });

  it("redacts the NFA fields (field-encryption D1): control number, registered-to, transfer method, approval date, tax paid", () => {
    for (const field of [
      "nfaControlNumber",
      "nfaRegisteredTo",
      "nfaTransferMethod",
      "nfaApprovalDate",
      "nfaTaxPaid",
    ]) {
      expect(isRedactedField(field), field).toBe(true);
    }
  });
});

describe("redactRecord", () => {
  it("replaces sensitive fields with the redacted marker and leaves the rest", () => {
    const row = { name: "Glock 19", serialNumber: "ABC123", caliber: "9mm" };
    expect(redactRecord(row)).toEqual({ name: "Glock 19", serialNumber: REDACTED, caliber: "9mm" });
  });
});

describe("diffRecords", () => {
  it("returns only changed keys, ignoring updatedAt", () => {
    const before = { a: 1, b: 2, updatedAt: "x" };
    const after = { a: 1, b: 3, updatedAt: "y" };
    expect(diffRecords(before, after)).toEqual({ b: [2, 3] });
  });

  it("returns an empty object for equal records", () => {
    expect(diffRecords({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({});
  });

  it("redacts both sides of a changed sensitive field", () => {
    expect(diffRecords({ serialNumber: "ABC" }, { serialNumber: "XYZ" })).toEqual({
      serialNumber: [REDACTED, REDACTED],
    });
  });

  it("compares Dates by value, not identity", () => {
    const before = { at: new Date("2026-01-01T00:00:00.000Z") };
    const after = { at: new Date("2026-01-01T00:00:00.000Z") };
    expect(diffRecords(before, after)).toEqual({});
  });

  it("treats a changed Date value as a diff", () => {
    const before = { at: new Date("2026-01-01T00:00:00.000Z") };
    const after = { at: new Date("2026-01-02T00:00:00.000Z") };
    expect(diffRecords(before, after)).toEqual({
      at: [before.at, after.at],
    });
  });

  it("treats null and undefined as equal", () => {
    expect(diffRecords({ a: null }, { a: undefined })).toEqual({});
    expect(diffRecords({ a: undefined }, { a: null })).toEqual({});
  });
});

describe("redactStoredChanges", () => {
  // The write path (recordCreate/recordUpdate/recordDelete in extension.ts,
  // and diffRecords above) already redacts every sensitive field before a row
  // is ever written. This function exists for the case the write path's
  // guarantee doesn't cover: a row from before this rule existed, or one
  // written outside the audited client, storing a RAW value under a
  // sensitive field name. The read path (query.ts's toDto) must not trust
  // the stored row — it re-applies the same rule on the way out.

  it("redacts a bare (CREATE/DELETE-shaped) sensitive value the write path somehow missed", () => {
    const changes = { serialNumber: "REAL-SERIAL-123", name: "Glock 19" };
    expect(redactStoredChanges(changes)).toEqual({ serialNumber: REDACTED, name: "Glock 19" });
  });

  it("redacts both sides of a raw (UPDATE-shaped) diff pair, keeping the [before, after] shape", () => {
    const changes = { serialNumber: ["OLD-123", "NEW-456"] };
    expect(redactStoredChanges(changes)).toEqual({ serialNumber: [REDACTED, REDACTED] });
  });

  it("is a no-op on an already-redacted diff pair", () => {
    const changes = { serialNumber: [REDACTED, REDACTED] };
    expect(redactStoredChanges(changes)).toEqual({ serialNumber: [REDACTED, REDACTED] });
  });

  it("leaves non-sensitive fields untouched", () => {
    const changes = { status: ["Active", "Sold"], notes: "hello" };
    expect(redactStoredChanges(changes)).toEqual({ status: ["Active", "Sold"], notes: "hello" });
  });

  it("recurses into a nested object (e.g. _nested writes) without redacting the _children counts", () => {
    const changes = {
      _nested: { accessories: { create: [{ serialNumber: "RAW-1" }] } },
      _children: { MaintenanceLog: 3 },
    };
    expect(redactStoredChanges(changes)).toEqual({
      _nested: { accessories: { create: [{ serialNumber: REDACTED }] } },
      _children: { MaintenanceLog: 3 },
    });
  });

  it("passes through non-object values (null, primitives) unchanged", () => {
    expect(redactStoredChanges(null)).toBeNull();
    expect(redactStoredChanges("plain string")).toBe("plain string");
    expect(redactStoredChanges(42)).toBe(42);
  });
});
