import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { getFullBackupStatus } from "@/lib/backup/full-job";

export const dynamic = "force-dynamic";

/** Progress of the full backup job, or of the last one until the next starts. Never contains the passphrase. */
export async function GET() {
  const auth = await requireAdmin();
  if (auth) return auth;
  return NextResponse.json(getFullBackupStatus(), { headers: { "Cache-Control": "no-store" } });
}
