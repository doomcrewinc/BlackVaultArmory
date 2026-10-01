import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Next's own on-screen dev indicator (the "N" button, bottom-left). It only
  // ever rendered in `next dev`, never in a build, but it sits on top of the
  // app's own UI. Compile and runtime errors are still surfaced.
  devIndicators: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
      { protocol: "http", hostname: "**" },
    ],
  },
  serverExternalPackages: ["@prisma/client", "sharp"],
  experimental: {
    // Next 16's proxy (src/proxy.ts has no matcher, so it runs on every
    // request) clones the request body and TRUNCATES it at this limit before
    // the route handler ever sees it — default 10 MB
    // (node_modules/next/dist/server/config-shared.js). A sealed backup
    // envelope is plaintext size + ~33% (base64), and a large inventory
    // (e.g. 20,000 firearms with notes) comfortably exceeds 10 MB. Without
    // raising this, POST /api/backup/restore silently truncates the body and
    // fails with a misleading "Invalid JSON body" instead of restoring.
    // 256mb is generous headroom over any inventory this app is sized for.
    proxyClientMaxBodySize: "256mb",
  },
};

export default nextConfig;
