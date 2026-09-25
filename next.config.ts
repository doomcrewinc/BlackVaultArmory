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
};

export default nextConfig;
