import { describe, expect, it } from "vitest";
import { normalizeFirearmClassFields } from "./nfa";

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
