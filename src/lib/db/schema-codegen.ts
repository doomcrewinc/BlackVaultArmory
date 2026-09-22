/**
 * Emits per-provider Prisma schemas from prisma/schema.base.prisma.
 *
 * The providers differ only in the datasource line and the client output path.
 * Postgres keeps the default output, so `@prisma/client` IS the Postgres client
 * and the canonical type source. SQLite writes to a separate folder so both
 * clients can ship in one image. This is a text substitution, not a dialect
 * translation — keep it that way.
 */

export const PROVIDER_PLACEHOLDER = "__PROVIDER__";
export const OUTPUT_PLACEHOLDER = "// __OUTPUT__";

export const PROVIDERS = {
  postgres: { provider: "postgresql", output: null },
  sqlite: { provider: "sqlite", output: "../../node_modules/.prisma/client-sqlite" },
} as const;

export type ProviderDir = keyof typeof PROVIDERS;

const BANNER = [
  "// ─────────────────────────────────────────────────────────────",
  "// GENERATED FILE — DO NOT EDIT.",
  "// Source:     prisma/schema.base.prisma",
  "// Regenerate: npm run gen:schemas",
  "// ─────────────────────────────────────────────────────────────",
  "",
  "",
].join("\n");

export function renderSchema(base: string, dir: ProviderDir): string {
  for (const placeholder of [PROVIDER_PLACEHOLDER, OUTPUT_PLACEHOLDER]) {
    if (!base.includes(placeholder)) {
      throw new Error(`schema.base.prisma is missing the ${placeholder} placeholder`);
    }
  }
  const { provider, output } = PROVIDERS[dir];
  const outputLine = output ? `output   = "${output}"` : "";
  return (
    BANNER +
    base
      .split(PROVIDER_PLACEHOLDER).join(provider)
      .split(OUTPUT_PLACEHOLDER).join(outputLine)
  );
}
