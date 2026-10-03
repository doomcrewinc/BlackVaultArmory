import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, requireAdmin } from "@/lib/server/auth";
import { requirePassphrase, SealError } from "@/lib/encryption/core.mjs";
import { FullBackupJobBusyError, startFullBackupJob } from "@/lib/backup/full-job";
import { FullBackupAlreadyRunningError } from "@/lib/backup/full-lock";

/**
 * Starts a full backup (files + database, sealed with the admin's passphrase)
 * as a background job and returns 202 at once; progress is on
 * GET /api/backup/full/status. The archive is saved in the server's backup
 * folder — nothing is downloaded, and nothing is ever deleted (spec D5).
 * The passphrase is used for this one run and never stored or logged.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const passphrase = typeof body === "object" && body !== null ? (body as { passphrase?: unknown }).passphrase : undefined;
  if (typeof passphrase !== "string") {
    return NextResponse.json({ error: "Passphrase must be at least 12 characters." }, { status: 400 });
  }
  try {
    requirePassphrase(passphrase);
  } catch (e) {
    if (e instanceof SealError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  // Resolved here, in the request: the job runs after this handler returns.
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 });

  try {
    const { jobId } = await startFullBackupJob({
      passphrase,
      actor: { actorId: user.id, actorName: user.displayName || user.username },
    });
    return NextResponse.json({ jobId }, { status: 202 });
  } catch (e) {
    if (e instanceof FullBackupJobBusyError || e instanceof FullBackupAlreadyRunningError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    console.error("POST /api/backup/full error:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Could not start the backup." }, { status: 500 });
  }
}
