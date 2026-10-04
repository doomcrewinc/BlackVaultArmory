import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { AUDIT_EXCLUDED_MODELS, AUDITED_MODELS, isAudited } from "./registry";

const schemaModels = Prisma.dmmf.datamodel.models;

describe("audit registry", () => {
  it("covers every schema model exactly once, registry plus exclusions", () => {
    const registered = [...AUDITED_MODELS, ...Object.keys(AUDIT_EXCLUDED_MODELS)].sort();
    const inSchema = schemaModels.map((m) => m.name).sort();
    expect(registered).toEqual(inSchema);
  });

  it("has no overlap between audited and excluded models", () => {
    const excluded = new Set(Object.keys(AUDIT_EXCLUDED_MODELS));
    const overlap = AUDITED_MODELS.filter((m) => excluded.has(m));
    expect(overlap).toEqual([]);
  });

  it("gives every excluded model a non-empty reason", () => {
    for (const [model, reason] of Object.entries(AUDIT_EXCLUDED_MODELS)) {
      expect(reason.length, `${model} needs a non-empty reason`).toBeGreaterThan(0);
    }
  });

  it("excludes Session, AuthToken, User, ImageCache, DateNormalizationAudit, AuditEvent, CapturePass", () => {
    expect(Object.keys(AUDIT_EXCLUDED_MODELS).sort()).toEqual(
      ["AuditEvent", "AuthToken", "CapturePass", "DateNormalizationAudit", "ImageCache", "Session", "User"].sort(),
    );
  });

  it("isAudited matches the registry", () => {
    for (const model of AUDITED_MODELS) expect(isAudited(model)).toBe(true);
    for (const model of Object.keys(AUDIT_EXCLUDED_MODELS)) expect(isAudited(model)).toBe(false);
    expect(isAudited("NotARealModel")).toBe(false);
  });
});
