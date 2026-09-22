import path from "node:path";

export default {
  test: {
    environment: "node",
    // Pinned so date-only tests are deterministic regardless of host timezone.
    // America/Denver is UTC-6/-7, which is what surfaces the off-by-one this
    // module exists to fix.
    env: { TZ: "America/Denver" },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
};
