import { describe, expect, it, vi } from "vitest";
import {
  isKnownNfaClass,
  normalizeAccessoryNfaFields,
  normalizeFirearmNfaFields,
} from "./nfa";

// normalizeFirearmClassFields was deleted once the firearms routes switched to
// normalizeFirearmNfaFields (which wraps the same class/registry logic
// internally); its class/registry edge cases — default-to-NONE, registry only
// surviving on MACHINE_GUN, unknown-value rejection, trim/upper-case, and
// non-string input — are exercised below through that wrapper instead.

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

  // The fallback itself is deliberate for ABSENT input. It is destructive for
  // junk input, which is why the write routes gate on isKnownNfaClass and
  // answer 400 before ever reaching this function.
  it("rejects an unknown class by falling back to NONE, clearing the group", () => {
    const result = normalizeFirearmNfaFields({ ...FULL, nfaClass: "MADE_UP" });
    expect(result.nfaClass).toBe("NONE");
    expect(result.mgRegistry).toBeNull();
    expect(result.nfaTransferMethod).toBeNull();
  });

  it("rejects an unknown registry rather than storing it", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaClass: "MACHINE_GUN",
      mgRegistry: "MADE_UP",
    });
    expect(result.mgRegistry).toBeNull();
  });

  it("trims and upper-cases the class and registry", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaClass: " machine_gun ",
      mgRegistry: " post_sample ",
    });
    expect(result.nfaClass).toBe("MACHINE_GUN");
    expect(result.mgRegistry).toBe("POST_SAMPLE");
  });

  it("ignores non-string class/registry input", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaClass: 7,
      mgRegistry: {},
    });
    expect(result.nfaClass).toBe("NONE");
    expect(result.mgRegistry).toBeNull();
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

// A blank field must read as absent no matter which of the module's shapes it
// arrives in — an empty string, or the whitespace a human actually types when
// they clear a form field with a trailing space or a stray tab. The bug this
// module was written to close (normalizeMoney testing `value === ""`, so
// `Number(" ")` — which is 0, not NaN — slipped a fabricated "$0 tax paid"
// past it) has now shipped THREE times in this repo under three different
// names (the accessories create form, the gear create form, and this
// module), always because the check tested exact-empty-string rather than
// blank-after-trim. So this covers every string-ish field in the group at
// once, not just nfaTaxPaid, on the theory that a bug that recurs three times
// is a class of bug, not an instance.
describe("whitespace-only input reads as blank everywhere in the group", () => {
  const WHITESPACE = "   ";

  it("nfaTaxPaid: a whitespace-only tax field is null, not a fabricated $0 [FAILS pre-fix: Number('   ') is 0]", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaTaxPaid: WHITESPACE }).nfaTaxPaid,
    ).toBeNull();
  });

  it("nfaControlNumber: a whitespace-only control number is null, not '   '", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaControlNumber: WHITESPACE })
        .nfaControlNumber,
    ).toBeNull();
  });

  it("nfaRegisteredTo: a whitespace-only owner is null, not '   '", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaRegisteredTo: WHITESPACE })
        .nfaRegisteredTo,
    ).toBeNull();
  });

  // Now guarded explicitly in normalizeDateOnly rather than only because
  // toDateOnlyUTC's regex rejects a blank and the catch swallowed the throw.
  it("nfaApprovalDate: a whitespace-only date is null, not a thrown/guessed date", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaApprovalDate: WHITESPACE })
        .nfaApprovalDate,
    ).toBeNull();
  });

  it("nfaTransferMethod: a whitespace-only method is null, not an accidental match", () => {
    expect(
      normalizeFirearmNfaFields({ ...FULL, nfaTransferMethod: WHITESPACE })
        .nfaTransferMethod,
    ).toBeNull();
  });

  it("nfaClass: a whitespace-only class falls back to NONE, clearing the group, not a crash or a stray class", () => {
    const result = normalizeFirearmNfaFields({
      ...FULL,
      nfaClass: WHITESPACE,
    });
    expect(result.nfaClass).toBe("NONE");
    expect(result.mgRegistry).toBeNull();
    expect(result.nfaTransferMethod).toBeNull();
  });

  it("mgRegistry: a whitespace-only registry on a machine gun is null, not '   '", () => {
    expect(
      normalizeFirearmNfaFields({
        ...FULL,
        nfaClass: "MACHINE_GUN",
        mgRegistry: WHITESPACE,
      }).mgRegistry,
    ).toBeNull();
  });

  it("normalizeAccessoryNfaFields: a whitespace-only type is treated as ineligible, clearing the group", () => {
    expect(normalizeAccessoryNfaFields(WHITESPACE, FULL)).toEqual({
      nfaTransferMethod: null,
      nfaControlNumber: null,
      nfaApprovalDate: null,
      nfaTaxPaid: null,
      nfaRegisteredTo: null,
    });
  });

  it("normalizeAccessoryNfaFields: whitespace-only paperwork fields on an eligible SUPPRESSOR are null, not stored verbatim", () => {
    const result = normalizeAccessoryNfaFields("SUPPRESSOR", {
      ...FULL,
      nfaTaxPaid: WHITESPACE,
      nfaControlNumber: WHITESPACE,
      nfaRegisteredTo: WHITESPACE,
      nfaApprovalDate: WHITESPACE,
    });
    expect(result.nfaTaxPaid).toBeNull();
    expect(result.nfaControlNumber).toBeNull();
    expect(result.nfaRegisteredTo).toBeNull();
    expect(result.nfaApprovalDate).toBeNull();
  });
});

// The guard the firearm write routes use to turn that destructive fallback
// into a 400.
describe("isKnownNfaClass", () => {
  it("accepts every class in the enum, trimmed and in any case", () => {
    expect(isKnownNfaClass("NONE")).toBe(true);
    expect(isKnownNfaClass("SBR")).toBe(true);
    expect(isKnownNfaClass("machine_gun")).toBe(true);
    expect(isKnownNfaClass("  AOW  ")).toBe(true);
  });

  it("rejects anything else, including the shapes a hand-rolled request sends", () => {
    expect(isKnownNfaClass("SHORT_BARRELED_RIFLE")).toBe(false);
    expect(isKnownNfaClass("")).toBe(false);
    expect(isKnownNfaClass("   ")).toBe(false);
    expect(isKnownNfaClass(null)).toBe(false);
    expect(isKnownNfaClass(undefined)).toBe(false);
    expect(isKnownNfaClass(7)).toBe(false);
  });
});

// normalizeDateOnly only turns a date THAT IS WRONG into null. An error of any
// other kind means something is broken in the date helpers, and swallowing it
// would empty a paperwork column silently instead of failing the request.
describe("normalizeDateOnly error handling", () => {
  it("nulls an InvalidDateError and rethrows anything else", async () => {
    vi.resetModules();
    vi.doMock("./date", async () => {
      const actual = await vi.importActual<typeof import("./date")>("./date");
      return {
        ...actual,
        toDateOnlyUTC: (input: Date | string) => {
          if (input === "boom") throw new TypeError("bug in the date helpers");
          return actual.toDateOnlyUTC(input);
        },
      };
    });

    const { normalizeFirearmNfaFields: normalize } = await import("./nfa");

    // A malformed date is user input being wrong: null.
    expect(
      normalize({ nfaClass: "SBR", nfaApprovalDate: "not-a-date" })
        .nfaApprovalDate,
    ).toBeNull();

    // Anything else propagates to the route's error handler.
    expect(() =>
      normalize({ nfaClass: "SBR", nfaApprovalDate: "boom" }),
    ).toThrow(TypeError);

    vi.doUnmock("./date");
    vi.resetModules();
  });
});
