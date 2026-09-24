import { describe, expect, it } from "vitest";
import {
  FIREARM_TYPES,
  FIREARM_TYPE_LABELS,
  MG_REGISTRIES,
  MG_REGISTRY_LABELS,
  NFA_CLASSES,
  NFA_CLASS_LABELS,
  UNSPECIFIED_FIREARM_TYPE,
  normalizeTypeToken,
} from "./types";

describe("firearm enums", () => {
  it("includes PDW as a platform", () => {
    expect(FIREARM_TYPES).toContain("PDW");
  });

  it("keeps SMG as a legacy platform value", () => {
    expect(FIREARM_TYPES).toContain("SMG");
  });

  it("labels every firearm type", () => {
    for (const type of FIREARM_TYPES) {
      expect(FIREARM_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it("names the value the API writes when no type is given", () => {
    expect(UNSPECIFIED_FIREARM_TYPE).toBe("UNSPECIFIED");
    expect(FIREARM_TYPES).not.toContain(UNSPECIFIED_FIREARM_TYPE);
  });
});

describe("nfa enums", () => {
  it("starts at NONE and covers the regulated classes", () => {
    expect(NFA_CLASSES[0]).toBe("NONE");
    expect(NFA_CLASSES).toEqual([
      "NONE",
      "SBR",
      "SBS",
      "MACHINE_GUN",
      "AOW",
      "DESTRUCTIVE_DEVICE",
    ]);
  });

  it("labels every class and every machine gun registry", () => {
    for (const value of NFA_CLASSES)
      expect(NFA_CLASS_LABELS[value]).toBeTruthy();
    for (const value of MG_REGISTRIES)
      expect(MG_REGISTRY_LABELS[value]).toBeTruthy();
  });

  it("covers the three machine gun registries", () => {
    expect(MG_REGISTRIES).toEqual([
      "TRANSFERABLE",
      "PRE_SAMPLE",
      "POST_SAMPLE",
    ]);
  });
});

// Eligibility for NFA paperwork is decided on an upper-cased type, while the
// section filters match the stored token exactly — so the stored token has to
// be upper-cased too, or the two disagree.
describe("normalizeTypeToken", () => {
  it("trims and upper-cases a supplied token", () => {
    expect(normalizeTypeToken("  suppressor ")).toBe("SUPPRESSOR");
    expect(normalizeTypeToken("rifle")).toBe("RIFLE");
    expect(normalizeTypeToken("BOLT_ACTION")).toBe("BOLT_ACTION");
  });

  it("returns blank for anything that is not a usable string", () => {
    expect(normalizeTypeToken("")).toBe("");
    expect(normalizeTypeToken("   ")).toBe("");
    expect(normalizeTypeToken(null)).toBe("");
    expect(normalizeTypeToken(undefined)).toBe("");
    expect(normalizeTypeToken(3)).toBe("");
  });

  it("leaves every known platform token unchanged", () => {
    for (const token of FIREARM_TYPES) {
      expect(normalizeTypeToken(token)).toBe(token);
    }
    expect(normalizeTypeToken(UNSPECIFIED_FIREARM_TYPE)).toBe(
      UNSPECIFIED_FIREARM_TYPE,
    );
  });
});
