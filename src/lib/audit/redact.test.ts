import { describe, expect, it } from "vitest";
import { REDACTED, diffRecords, isRedactedField, redactRecord } from "./redact";

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
