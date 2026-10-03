import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/auth";
import { recordEventBestEffort } from "@/lib/audit/events";
import { restoreBackupRecords } from "@/lib/backup/restore-core";
import { openBackup, SealError } from "@/lib/encryption/core.mjs";

/**
 * Detects the sealed-restore shape on `sealed` alone (review M7): requiring
 * `passphrase` too meant `{ sealed }` with no passphrase fell through to the
 * plain-backup path and failed as "Invalid backup file…" — a sealed envelope
 * is never a valid PLAIN backup body, so that was always a misleading error.
 * The passphrase-presence check right below gives the specific message.
 */
function isSealedRequest(body: unknown): body is { sealed: unknown; passphrase?: unknown } {
  return typeof body === "object" && body !== null && !Array.isArray(body) && "sealed" in body;
}

/** Longest file name recorded, in characters (code points). Typical filesystem limit. */
const MAX_BACKUP_FILENAME = 255;

/**
 * The backup file name for the RESTORE event (spec §Restore), from the
 * client-supplied `X-Backup-Filename` header. The header is UNTRUSTED: it is
 * URI-decoded (malformed → ignored), reduced to its basename (a client could
 * send a full path), stripped of C0/C1 control characters (no CR/LF or
 * terminal escapes in the log or the CSV), trimmed and capped at 255
 * characters. `undefined` when the header is absent (API callers, older
 * clients) or nothing usable remains; the restore itself never depends on it.
 */
function backupFileName(request: NextRequest): string | undefined {
  const raw = request.headers.get("x-backup-filename");
  if (raw === null) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // C0/C1 controls, plus Unicode format and line/paragraph separators
  // (e.g. U+202E right-to-left override) that would make the name display
  // misleadingly in the log and the CSV.
  const cleaned = decoded.replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu, "");
  const base = cleaned.split(/[\\/]/).pop() ?? "";
  const capped = Array.from(base.trim()).slice(0, MAX_BACKUP_FILENAME).join("").trim();
  return capped === "" ? undefined : capped;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Sealed restore (spec §Restore): `{ sealed: <envelope>, passphrase }`. The
  // plain-backup path below is unchanged for everything else, including an
  // old v1.1 (or earlier) file that was never sealed.
  let body: unknown;
  let sealed: boolean;
  if (isSealedRequest(rawBody)) {
    const { sealed: envelope, passphrase } = rawBody;
    if (typeof passphrase !== "string") {
      return NextResponse.json({ error: "Passphrase is required." }, { status: 400 });
    }
    let opened: string;
    try {
      opened = openBackup(passphrase, envelope);
    } catch (error) {
      if (error instanceof SealError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
    try {
      body = JSON.parse(opened);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    sealed = true;
  } else {
    body = rawBody;
    sealed = false;
  }

  // Validation, normalisation and the one replace transaction are shared with
  // the full restore (restore.sh): src/lib/backup/restore-core.ts.
  const restored = await restoreBackupRecords(body);
  if (!restored.ok) {
    return NextResponse.json({ error: restored.error }, { status: restored.status });
  }
  const counts = restored.counts;

  // Written OUTSIDE withoutRowAudit — restore replaces every row and normalises
  // legacy dates under suppression (or every row would get its own entry
  // attributed to the admin); this single event, recorded afterward, IS logged.
  const file = backupFileName(request);
  await recordEventBestEffort(null, {
    action: "RESTORE",
    entityLabel: file ?? "Backup restore",
    changes: file ? { file, counts, sealed } : { counts, sealed },
  });

  return NextResponse.json({
    success: true,
    counts,
  });
}
