import { describe, expect, it } from "vitest";
import { CATEGORY_SECTIONS } from "./categories";
import { SLOT_TYPES } from "./types";
import {
  FULL_AUTO_LIMITED_TO_REQUIRED_MESSAGE,
  FULL_AUTO_RATING_OPTIONS,
  fullAutoLimitedToExportValue,
  fullAutoRatingExportValue,
  fullAutoRatingLabel,
  fullAutoRatingText,
  SUPPRESSOR_TYPES,
  isSuppressorType,
  normalizeFullAutoFields,
  resolveFullAutoFields,
} from "./full-auto-rated";

const NONE = { fullAutoRating: null, fullAutoLimitedTo: null };

describe("resolveFullAutoFields", () => {
  it.each([
    ["YES", { fullAutoRating: "YES", fullAutoLimitedTo: null }],
    ["NO", { fullAutoRating: "NO", fullAutoLimitedTo: null }],
    [null, NONE],
    [undefined, NONE],
  ])("keeps %s on a suppressor", (rating, fields) => {
    expect(resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: rating })).toEqual({ ok: true, fields });
  });

  it("keeps LIMITED with its trimmed text", () => {
    expect(
      resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: "LIMITED", fullAutoLimitedTo: "  5.56 NATO only  " }),
    ).toEqual({ ok: true, fields: { fullAutoRating: "LIMITED", fullAutoLimitedTo: "5.56 NATO only" } });
  });

  it.each([undefined, null, "", "   "])("rejects LIMITED with the text %j", (text) => {
    expect(
      resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: "LIMITED", fullAutoLimitedTo: text }),
    ).toEqual({ ok: false, error: FULL_AUTO_LIMITED_TO_REQUIRED_MESSAGE });
  });

  it("accepts 200 characters and rejects 201", () => {
    const limited = (text: string) => resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: "LIMITED", fullAutoLimitedTo: text });
    expect(limited("a".repeat(200)).ok).toBe(true);
    expect(limited("a".repeat(201))).toMatchObject({ ok: false, error: expect.stringContaining("200") });
  });

  it.each(["YES", "NO"])("drops stale text beside %s", (rating) => {
    expect(
      resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: rating, fullAutoLimitedTo: "5.56 NATO only" }),
    ).toEqual({ ok: true, fields: { fullAutoRating: rating, fullAutoLimitedTo: null } });
  });

  it.each(["YES", "NO", "LIMITED"])("forces %s and its text to null on an optic", (rating) => {
    expect(
      resolveFullAutoFields("OPTIC", { fullAutoRating: rating, fullAutoLimitedTo: "5.56" }),
    ).toEqual({ ok: true, fields: NONE });
  });

  it.each([["yes"], ["MAYBE"], [true], [1], [""]])("rejects the rating %j, whatever the type", (rating) => {
    expect(resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: rating }).ok).toBe(false);
    expect(resolveFullAutoFields("OPTIC", { fullAutoRating: rating }).ok).toBe(false);
  });

  it.each([[5], [true], [{}]])("rejects the non-text limit %j", (text) => {
    expect(resolveFullAutoFields("SUPPRESSOR", { fullAutoRating: "LIMITED", fullAutoLimitedTo: text }).ok).toBe(false);
  });
});

describe("normalizeFullAutoFields", () => {
  it("keeps LIMITED without text rather than losing the rating", () => {
    expect(normalizeFullAutoFields("SUPPRESSOR", { fullAutoRating: "LIMITED" })).toEqual({
      fullAutoRating: "LIMITED",
      fullAutoLimitedTo: null,
    });
  });

  it("treats an unknown rating as not recorded", () => {
    expect(normalizeFullAutoFields("SUPPRESSOR", { fullAutoRating: "MAYBE", fullAutoLimitedTo: "x" })).toEqual(NONE);
  });

  it("cuts over-long text to 200 characters", () => {
    const fields = normalizeFullAutoFields("SUPPRESSOR", { fullAutoRating: "LIMITED", fullAutoLimitedTo: "a".repeat(250) });
    expect(fields.fullAutoLimitedTo).toHaveLength(200);
  });
});

describe("isSuppressorType", () => {
  it.each([
    ["SUPPRESSOR", true],
    [" suppressor ", true],
    ["OPTIC", false],
    [null, false],
  ])("%s -> %s", (type, expected) => {
    expect(isSuppressorType(type)).toBe(expected);
  });
});

describe("display", () => {
  it("offers Not recorded, Yes, No and Limited in that order", () => {
    expect(FULL_AUTO_RATING_OPTIONS.map((o) => [o.value, o.label])).toEqual([
      ["", "Not recorded"],
      ["YES", "Yes"],
      ["NO", "No"],
      ["LIMITED", "Limited"],
    ]);
  });

  it.each([
    ["YES", null, "Yes", "Yes", ""],
    ["NO", null, "No", "No", ""],
    ["LIMITED", "5.56 NATO only", "Limited — 5.56 NATO only", "Limited", "5.56 NATO only"],
    ["LIMITED", null, "Limited", "Limited", ""],
    [null, null, "Not recorded", "", ""],
    [undefined, "stale", "Not recorded", "", ""],
  ])("%s / %s", (rating, text, shown, exported, exportedText) => {
    expect(fullAutoRatingText(rating, text)).toBe(shown);
    expect(fullAutoRatingExportValue(rating)).toBe(exported);
    expect(fullAutoLimitedToExportValue(rating, text)).toBe(exportedText);
  });

  it("labels a rating", () => {
    expect(fullAutoRatingLabel("LIMITED")).toBe("Limited");
    expect(fullAutoRatingLabel(null)).toBe("Not recorded");
  });
});

describe("the suppressor type definition", () => {
  const section = CATEGORY_SECTIONS.find((candidate) => candidate.slug === "suppressors");
  const accessorySource = section?.sources.find((source) => source.source === "accessory");

  it.each([...SLOT_TYPES, "SOMETHING_NEW", " suppressor "])(
    "%s is a suppressor type exactly when the Suppressors section holds it",
    (type) => {
      const held =
        accessorySource?.source === "accessory" && accessorySource.holds({ type } as never);
      expect(isSuppressorType(type)).toBe(Boolean(held) || type === " suppressor ");
    },
  );

  it("is the list the Suppressors section matches on", () => {
    expect(accessorySource).toMatchObject({ where: { type: { in: [...SUPPRESSOR_TYPES] } } });
  });
});
