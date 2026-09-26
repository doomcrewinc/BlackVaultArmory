import path from "node:path";
import { defaultExclude } from "vitest/config";

export default {
  test: {
    environment: "node",
    // Pinned so date-only tests are deterministic regardless of host timezone.
    // America/Denver is UTC-6/-7, which is what surfaces the off-by-one this
    // module exists to fix.
    //
    // The pin is unconditional on purpose: vitest writes test.env into
    // process.env, so it overrides whatever TZ the shell exported. That
    // silently swallowed `TZ=Pacific/Auckland npx vitest run` — the run said
    // Auckland on the command line and executed in Denver.
    //
    // TZ_OVERRIDE is the one documented way through it, so CI can run the
    // same suite on the other side of UTC (a UTC-positive zone surfaces
    // off-by-ones that a UTC-negative pin hides, and vice versa). Setting
    // nothing keeps the old behaviour exactly.
    // `||`, not `??`: a matrix that sets TZ_OVERRIDE for every leg passes ""
    // on the default leg, and "" is not nullish. `TZ=""` is not Denver — it is
    // whatever the host falls back to — so `??` would silently un-pin the
    // default leg. `||` treats "" as "not set".
    env: { TZ: process.env.TZ_OVERRIDE || "America/Denver" },
    // `next build` copies src/ into .next/standalone, tests included, so
    // without this the suite runs each copied test file twice: once from
    // source and once from build output. The copies are stale by construction
    // — they are only as new as the last build — so a copy can pass while the
    // source it came from is broken, and the duplicate count makes any
    // "tests went up by N" claim meaningless.
    //
    // defaultExclude is spread rather than retyped so node_modules, dist and
    // the rest of vitest's own defaults keep applying.
    exclude: [...defaultExclude, "**/.next/**"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
};
