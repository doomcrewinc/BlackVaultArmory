import { NextResponse } from "next/server";
import { getLocalIp, isDockerEnvironment } from "@/lib/network/get-local-ip";
import { getDirectAccessState } from "@/lib/server/direct-access";
import { getPublicUrl } from "@/lib/server/public-url";

export const runtime = "nodejs";

// In the container the gate (gate/gate.mjs) owns the public port and sets
// PORT=3001 for Next, which is container-internal and never published. It
// records its own port as GATE_PORT first; without the gate (npm run dev,
// next start) PORT is the app's own port.
function getAppPort(): string {
  return process.env.GATE_PORT || process.env.PORT || "3000";
}

export async function GET() {
  const directAccess = await getDirectAccessState();
  const publicUrl = getPublicUrl().origin;

  try {
    const ip = getLocalIp();
    const port = getAppPort();
    const isDocker = isDockerEnvironment();

    if (!ip) {
      return NextResponse.json({
        ip: null,
        port,
        url: null,
        isDocker,
        message: isDocker
          ? "Running in Docker — auto-detection unavailable"
          : "Unable to detect local network IP",
        publicUrl,
        directAccess,
      });
    }

    return NextResponse.json({
      ip,
      port,
      url: `http://${ip}:${port}`,
      isDocker,
      message: null,
      publicUrl,
      directAccess,
    });
  } catch (error) {
    console.error("GET /api/network/local-access error:", error);
    return NextResponse.json({
      ip: null,
      port: getAppPort(),
      url: null,
      isDocker: false,
      message: "Unable to detect local network IP",
      publicUrl,
      directAccess,
    });
  }
}
