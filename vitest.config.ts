import path from "node:path";
import { defaultExclude } from "vitest/config";

export default {
  test: {
    environment: "node",
    // Pinned so date-only tests are deterministic regardless of host timezone.
    // America/Denver is UTC-6/-7, which is what surfaces the off-by-one this
    // module exists to fix.
    env: { TZ: "America/Denver" },
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
