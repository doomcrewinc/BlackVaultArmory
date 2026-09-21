import { NextResponse } from "next/server";
import { APP_VERSION } from "@/lib/version";

export async function GET() {
  return NextResponse.json(
    { status: "ok", timestamp: new Date().toISOString(), version: APP_VERSION },
    { status: 200 }
  );
}
