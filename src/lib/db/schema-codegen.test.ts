import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { OUTPUT_PLACEHOLDER, PROVIDERS, PROVIDER_PLACEHOLDER, renderSchema } from "./schema-codegen";

const ROOT = path.join(__dirname, "..", "..", "..");
const base = `generator client {\n  provider = "prisma-client-js"\n  ${OUTPUT_PLACEHOLDER}\n}\n\ndatasource db {\n  provider = "${PROVIDER_PLACEHOLDER}"\n}\n`;

describe("renderSchema", () => {
  it("sets the postgres provider and leaves the client at the default location", () => {
    const out = renderSchema(base, "postgres");
    expect(out).toContain('provider = "postgresql"');
    expect(out).not.toMatch(/^\s*output\s*=/m);
  });

  it("sets the sqlite provider and a separate client output", () => {
    const out = renderSchema(base, "sqlite");
    expect(out).toContain('provider = "sqlite"');
    expect(out).toContain('output   = "../../node_modules/.prisma/client-sqlite"');
  });

  it("leaves no placeholder behind", () => {
    for (const dir of Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>) {
      const out = renderSchema(base, dir);
      expect(out).not.toContain(PROVIDER_PLACEHOLDER);
      expect(out).not.toContain(OUTPUT_PLACEHOLDER);
    }
  });

  it("prepends a do-not-edit banner", () => {
    expect(renderSchema(base, "sqlite")).toContain("DO NOT EDIT");
  });

  it("throws when a placeholder is missing", () => {
    expect(() => renderSchema('datasource db { provider = "sqlite" }', "sqlite")).toThrow(/placeholder/i);
  });
});

describe("generated schemas on disk", () => {
  const real = fs.readFileSync(path.join(ROOT, "prisma", "schema.base.prisma"), "utf8");

  for (const dir of Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>) {
    it(`prisma/${dir}/schema.prisma is in sync with the base`, () => {
      const onDisk = fs.readFileSync(path.join(ROOT, "prisma", dir, "schema.prisma"), "utf8");
      expect(onDisk).toBe(renderSchema(real, dir));
    });
  }

  it("the base declares no scalar lists", () => {
    expect(real).not.toMatch(/\s(String|Int|Float|Boolean|DateTime)\[\]/);
  });
});
