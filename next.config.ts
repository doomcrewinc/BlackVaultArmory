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
  // The capture token is in the page URL by design: keep it out of the Referer
  // header and out of every cache.
  async headers() {
    return [
      {
        source: "/capture/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
  serverExternalPackages: ["@prisma/client", "sharp"],
  experimental: {
    // Next 16's proxy (src/proxy.ts has no matcher, so it runs on every
    // request, for EVERY route — not just /api/backup/restore) clones the
    // request body and TRUNCATES it at this limit before the route handler
    // ever sees it — default 10 MB (node_modules/next/dist/server/
    // config-shared.js). A sealed backup envelope is plaintext size + ~33%
    // (base64), and a large inventory (e.g. 20,000 firearms with notes)
    // comfortably exceeds 10 MB. Without raising this, POST
    // /api/backup/restore silently truncates the body and fails with a
    // misleading "Invalid JSON body" instead of restoring.
    //
    // A 256 MB cap is itself a problem, because
    // it applies to every route, including unauthenticated ones — 4
    // concurrent 200 MB POSTs to /api/auth/login drove this process's RSS
    // to ~2.6 GB before any route handler, admin check, or body-size logic
    // of our own ever ran. 64 MB is the trade-off: comfortably covers the
    // backup/restore case (measured ~37,000 firearms with notes at the
    // sealed-envelope size ratio above). It does NOT bound memory: measured,
    // Next buffers the WHOLE incoming body before it checks this cap (even
    // with the old 10 MB default a 624 MB body was buffered).
    // The real control for oversized or hostile request bodies is the
    // reverse proxy's body limit (Caddy / Nginx Proxy Manager), which the
    // README tells users to set. A household with a larger inventory than
    // that needs a CLI restore path instead of the browser UI (not built yet).
    proxyClientMaxBodySize: "64mb",
  },
};

export default nextConfig;
