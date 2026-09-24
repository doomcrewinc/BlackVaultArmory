import { describe, expect, it } from "vitest";
import {
  normalizeAccessoryNfaFields,
  normalizeFirearmClassFields,
  normalizeFirearmNfaFields,
} from "./nfa";

describe("normalizeFirearmClassFields", () => {
  it("defaults to NONE with no registry", () => {
    expect(normalizeFirearmClassFields({})).toEqual({
      nfaClass: "NONE",
      mgRegistry: null,
    });
  });

  it("keeps a machine gun's registry", () => {
    expect(
      normalizeFirearmClassFields({
        nfaClass: "MACHINE_GUN",
        mgRegistry: "PRE_SAMPLE",
      }),
    ).toEqual({ nfaClass: "MACHINE_GUN", mgRegistry: "PRE_SAMPLE" });
  });

  it("clears the registry when the class is not MACHINE_GUN", () => {
    expect(
      normalizeFirearmClassFields({
        nfaClass: "SBR",
        mgRegistry: "TRANSFERABLE",
      }),
    ).toEqual({ nfaClass: "SBR", mgRegistry: null });
    expect(
      normalizeFirearmClassFields({
        nfaClass: "NONE",
        mgRegistry: "TRANSFERABLE",
      }),
    ).toEqual({ nfaClass: "NONE", mgRegistry: null });
  });

  it("rejects an unknown class by falling back to NONE", () => {
    expect(normalizeFirearmClassFields({ nfaClass: "MADE_UP" })).toEqual({
      nfaClass: "NONE",
      mgRegistry: null,
    });
  });

  it("rejects an unknown registry rather than storing it", () => {
    expect(
      normalizeFirearmClassFields({
        nfaClass: "MACHINE_GUN",
        mgRegistry: "MADE_UP",
      }),
    ).toEqual({ nfaClass: "MACHINE_GUN", mgRegistry: null });
  });

  it("trims and upper-cases what the client sends", () => {
    expect(
      normalizeFirearmClassFields({
        nfaClass: " machine_gun ",
        mgRegistry: " post_sample ",
      }),
    ).toEqual({ nfaClass: "MACHINE_GUN", mgRegistry: "POST_SAMPLE" });
  });

  it("ignores non-string input", () => {
    expect(
      normalizeFirearmClassFields({ nfaClass: 7, mgRegistry: {} }),
    ).toEqual({
      nfaClass: "NONE",
      mgRegistry: null,
    });
  });
});

const FULL = {
  nfaClass: "SBR",
  mgRegistry: "TRANSFERABLE",
  nfaTransferMethod: "FORM_4",
  nfaControlNumber: "12345",
  nfaApprovalDate: "2024-03-12",
  nfaTaxPaid: 200,
  nfaRegisteredTo: "Doe Family Trust",
};

describe("normalizeFirearmNfaFields", () => {
  it("keeps a full Form 4 record on an SBR, minus the registry", () => {
    const result = normalizeFirearmNfaFields(FULL);
    expect(result.nfaClass).toBe("SBR");
    expect(result.mgRegistry).toBeNull(); // only machine guns
    expect(result.nfaTransferMethod).toBe("FORM_4");
    expect(result.nfaControlNumber).toBe("12345");
    expect(result.nfaTaxPaid).toBe(200);
    expect(result.nfaRegisteredTo).toBe("Doe Family Trust");
    expect(result.nfaApprovalDate?.toISOString().slice(0, 10)).toBe(
      "2024-03-12",
    );
  });

  it("keeps the registry on a machine gun", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaClass: "MACHINE_GUN",
    });
    expect(result.mgRegistry).toBe("TRANSFERABLE");
  });

  it("clears the ENTIRE group when the class drops to NONE", () => {
    const result = normalizeFirearmNfaFields({ ...FULL, nfaClass: "NONE" });
    expect(result).toEqual({
      nfaClass: "NONE",
      mgRegistry: null,
      nfaTransferMethod: null,
      nfaControlNumber: null,
      nfaApprovalDate: null,
      nfaTaxPaid: null,
      nfaRegisteredTo: null,
    });
  });

  it("clears the stamp fields on a 4473 transfer but keeps the owner", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaTransferMethod: "FORM_4473",
    });
    expect(result.nfaTransferMethod).toBe("FORM_4473");
    expect(result.nfaControlNumber).toBeNull();
    expect(result.nfaApprovalDate).toBeNull();
    expect(result.nfaTaxPaid).toBeNull();
    expect(result.nfaRegisteredTo).toBe("Doe Family Trust");
  });

  it("rejects an unknown method rather than storing it", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaTransferMethod: "FORM_9" })
        .nfaTransferMethod,
    ).toBeNull();
  });

  it("trims and upper-cases the method, and trims the text fields", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaTransferMethod: " form_1 ",
      nfaControlNumber: "  A-77  ",
      nfaRegisteredTo: "  Trust  ",
    });
    expect(result.nfaTransferMethod).toBe("FORM_1");
    expect(result.nfaControlNumber).toBe("A-77");
    expect(result.nfaRegisteredTo).toBe("Trust");
  });

  it("stores a blank tax as null, not zero", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaTaxPaid: "" }).nfaTaxPaid,
    ).toBeNull();
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaTaxPaid: "200" }).nfaTaxPaid,
    ).toBe(200);
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaTaxPaid: -5 }).nfaTaxPaid,
    ).toBeNull();
  });

  it("stores a blank control number and owner as null, not empty strings", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaControlNumber: "  ",
      nfaRegisteredTo: "",
    });
    expect(result.nfaControlNumber).toBeNull();
    expect(result.nfaRegisteredTo).toBeNull();
  });

  it("refuses a malformed approval date rather than guessing", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaApprovalDate: "not-a-date" })
        .nfaApprovalDate,
    ).toBeNull();
  });
});

describe("normalizeAccessoryNfaFields", () => {
  it("keeps the group on a suppressor", () => {
    const result = normalizeAccessoryNfaFields("SUPPRESSOR", FULL);
    expect(result.nfaTransferMethod).toBe("FORM_4");
    expect(result.nfaControlNumber).toBe("12345");
  });

  it("clears the group on any other type", () => {
    for (const type of ["OPTIC", "MAGAZINE", "BARREL", "", "ZZ_JUNK"]) {
      expect(normalizeAccessoryNfaFields(type, FULL), `type ${type}`).toEqual({
        nfaTransferMethod: null,
        nfaControlNumber: null,
        nfaApprovalDate: null,
        nfaTaxPaid: null,
        nfaRegisteredTo: null,
      });
    }
  });

  it("applies the 4473 rule on a suppressor too", () => {
    const result = normalizeAccessoryNfaFields("SUPPRESSOR", {
      ...FULL,
      nfaTransferMethod: "FORM_4473",
    });
    expect(result.nfaControlNumber).toBeNull();
    expect(result.nfaRegisteredTo).toBe("Doe Family Trust");
  });
});
