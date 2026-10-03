import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/server/auth";
import { buildBackupPayload, collectBackupRecords } from "@/lib/backup/records";
import { recordEventBestEffort } from "@/lib/audit/events";
import { sealBackup, SealError } from "@/lib/encryption/core.mjs";
import fs from "fs";
import path from "path";

/**
 * Sealed backups (field-encryption spec §3, "Backup UI"/"Sealed backup
 * format"; plan notes P1/P2). The server reads through the app Prisma client
 * (@/lib/prisma), so every encrypted field in `backupData` is already
 * plaintext here — exactly what the spec means by "Encrypted fields appear
 * decrypted, because the backup route reads through the extension." That
 * plaintext JSON is sealed with the admin's passphrase (core.mjs's
 * sealBackup) before it ever leaves this handler: the HTTP response body,
 * and the optional on-disk copy at AppSettings.backupDestinationPath, are
 * BOTH the sealed envelope — P1 rules the server-side copy must never be a
 * plaintext file, and P2 rules the client never assembles the file itself
 * from a plaintext response.
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
  const passphrase = typeof body === "object" && body !== null && "passphrase" in body ? (body as { passphrase: unknown }).passphrase : undefined;
  // The same floor core.mjs's sealBackup enforces (checked again, defensively,
  // right before sealing below) — duplicated here so a too-short passphrase
  // is rejected before the backup queries run at all, not after.
  if (typeof passphrase !== "string" || Array.from(passphrase.normalize("NFC")).length < 12) {
    return NextResponse.json({ error: "Passphrase must be at least 12 characters." }, { status: 400 });
  }

  try {
    // Shared with the full-backup engine (src/lib/backup/records.ts): one
    // definition of "the records a backup holds". Queries run sequentially —
    // connection_limit=1 means Promise.all would deadlock.
    const backupData = await collectBackupRecords();
    const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

    const payload = buildBackupPayload(backupData, { now, includeUploads: settings?.includeUploadsInBackup ?? true });
    const json = JSON.stringify(payload, null, 2);

    let sealed: string;
    try {
      sealed = sealBackup(passphrase, json);
    } catch (error) {
      if (error instanceof SealError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }

    const filename = `blackvault-backup-${timestamp}.sealed.json`;

    // Optional server-side save — non-fatal if it fails. The SEALED envelope
    // is written, never the plaintext payload (P1).
    let savedToPath: string | undefined;
    if (settings?.backupDestinationPath) {
      try {
        const destDir = settings.backupDestinationPath;
        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
        const fullPath = path.join(destDir, filename);
        fs.writeFileSync(fullPath, sealed, "utf8");
        savedToPath = fullPath;
      } catch (fsErr) {
        console.warn("Could not write backup to disk:", fsErr);
      }
    }

    await recordEventBestEffort(null, {
      action: "BACKUP_CREATED",
      entityLabel: filename,
      changes: { file: filename, sealed: true },
    });

    return new NextResponse(sealed, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Backup-Filename": filename,
        ...(savedToPath ? { "X-Backup-Saved-To": encodeURIComponent(savedToPath) } : {}),
      },
    });
  } catch (error) {
    console.error("POST /api/backup error:", error);
    return NextResponse.json({ error: "Failed to generate backup" }, { status: 500 });
  }
}
