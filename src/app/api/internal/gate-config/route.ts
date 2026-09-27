import { NextResponse } from "next/server";
import { getDirectAccessState } from "@/lib/server/direct-access";

// Polled every 5s by the TCP gate over 127.0.0.1. Reachable by any peer the
// gate passes; it exposes this one boolean and nothing else, by design.
export const dynamic = "force-dynamic";

export async function GET() {
  const { allowed } = await getDirectAccessState();
  return NextResponse.json({ allowDirectAccess: allowed });
}
