import { NextResponse } from "next/server";
import { getLocalIp, isDockerEnvironment } from "@/lib/network/get-local-ip";
import { getDirectAccessState } from "@/lib/server/direct-access";
import { getPublicUrl } from "@/lib/server/public-url";

export const runtime = "nodejs";

function getAppPort(): string {
  return process.env.PORT || "3000";
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
