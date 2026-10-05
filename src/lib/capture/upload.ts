import { NextResponse } from "next/server";
import { auditStorage, type AuditActor } from "@/lib/audit/context";
import { storeDocument } from "@/lib/documents/store";
import { HEIC_MESSAGE, MAX_PHOTO_BYTES, PictureRejected, processPicture } from "@/lib/images/process";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/server/client-ip";
import { detectFileSignature } from "@/lib/server/file-signatures";
import { describeError } from "@/lib/photos/errors";
import { OWNER_COLUMN, findOwnerName } from "@/lib/photos/owner";
import { addPhoto, normaliseLabel } from "@/lib/photos/store";
import { PASS_MAX_UPLOADS, findPass, returnSlot, takeSlot, uploadCountOf, type OpenPass, type PassEndReason } from "./pass";
import { captureThrottle } from "./throttle";

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,100}$/;
const MAX_PAPERWORK_BYTES = 20 * 1024 * 1024;
const NAME_MAX = 120;
const DOC_TYPES = {
  RECEIPT: "Receipt",
  PHOTO: "Photo",
  NFA_TAX_STAMP: "NFA Tax Stamp",
  OTHER: "Other",
} as const;
type DocType = keyof typeof DOC_TYPES;

const END_MESSAGES: Record<PassEndReason, string> = {
  expired: "This pass has expired. Make a new one on the computer.",
  closed: "This pass was closed. Make a new one on the computer.",
  full: `This pass has reached its limit of ${PASS_MAX_UPLOADS} uploads. Make a new one on the computer.`,
};

export type PassFailure = {
  ok: false;
  status: 404 | 410 | 429;
  body: { error: string; reason?: PassEndReason };
  retryAfter?: number;
};

/** Throttles wrong tokens by client address, then resolves the pass. */
export async function resolvePass(
  request: Request,
  rawToken: string,
): Promise<{ ok: true; pass: OpenPass } | PassFailure> {
  // Without a trusted address every caller would share one bucket, so no address throttle then.
  const ip = getClientIp(request);
  const key = ip === null ? null : `ip:${ip}`;
  const gate = key === null ? ({ allowed: true } as const) : captureThrottle.check(key);
  if (!gate.allowed) {
    return {
      ok: false,
      status: 429,
      body: { error: "Too many wrong links. Wait a moment and try again." },
      retryAfter: gate.retryAfterSeconds,
    };
  }

  const found = TOKEN_SHAPE.test(rawToken) ? await findPass(rawToken) : null;
  if (!found) {
    if (key !== null) captureThrottle.fail(key);
    return { ok: false, status: 404, body: { error: "This link is not valid." } };
  }
  // A link that names a real pass, open or ended, clears the address's wrong-link count.
  if (key !== null) captureThrottle.succeed(key);
  if (!found.ok) return endedFailure(found.reason);
  return { ok: true, pass: found.pass };
}

function endedFailure(reason: PassEndReason): PassFailure {
  return { ok: false, status: 410, body: { error: END_MESSAGES[reason], reason } };
}

export function failureResponse(failure: PassFailure): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (failure.retryAfter !== undefined) headers["Retry-After"] = String(failure.retryAfter);
  return NextResponse.json(failure.body, { status: failure.status, headers });
}

function bad(error: string, status = 400): NextResponse {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

type Parsed =
  | { kind: "photo"; file: File; label: string | null }
  | { kind: "paperwork"; file: File; docType: DocType; name: string | null };

/** Validates the form. Reads no item identifier: the pass alone says which item. */
function parseForm(form: FormData): Parsed | NextResponse {
  const kind = form.get("kind");
  const file = form.get("file");
  if (kind !== "photo" && kind !== "paperwork") return bad("kind must be photo or paperwork.");
  if (!(file instanceof File)) return bad("Missing required field: file");

  if (kind === "photo") {
    if (file.size > MAX_PHOTO_BYTES) return bad("File too large. Maximum size is 25MB.");
    try {
      return { kind, file, label: normaliseLabel(form.get("label")) };
    } catch {
      return bad("Label is too long (80 characters at most).");
    }
  }

  if (file.size > MAX_PAPERWORK_BYTES) return bad("File too large. Maximum size is 20MB.");
  const rawType = form.get("docType");
  const docType = rawType === null || rawType === "" ? "RECEIPT" : rawType;
  if (typeof docType !== "string" || !Object.hasOwn(DOC_TYPES, docType)) return bad("Unknown document type.");
  try {
    normaliseLabel(form.get("label"));
  } catch {
    return bad("Label is too long (80 characters at most).");
  }
  const rawName = form.get("name");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name.length > NAME_MAX) return bad(`Name is too long (${NAME_MAX} characters at most).`);
  return { kind, file, docType: docType as DocType, name: name === "" ? null : name };
}

async function storePaperwork(pass: OpenPass, bytes: Buffer, parsed: Extract<Parsed, { kind: "paperwork" }>) {
  const picture = await processPicture(bytes, { maxBytes: MAX_PAPERWORK_BYTES });
  const date = new Date().toISOString().slice(0, 10);
  const doc = await storeDocument({
    bytes: picture.bytes,
    extension: picture.extension,
    mimeType: picture.mimeType,
    name: parsed.name ?? `${DOC_TYPES[parsed.docType]} ${date}`,
    type: parsed.docType,
    notes: "Added from a phone capture pass",
    owners: { [OWNER_COLUMN[pass.entityType]]: pass.entityId },
  });
  return doc.id;
}

async function giveSlotBack(passId: string): Promise<void> {
  try {
    await returnSlot(passId);
  } catch (e) {
    console.error("Could not return a capture pass upload slot:", describeError(e));
  }
}

/** The whole public upload: resolve, validate, take a slot, store, answer. */
export async function handleCaptureUpload(request: Request, rawToken: string): Promise<NextResponse> {
  const resolved = await resolvePass(request, rawToken);
  if (!resolved.ok) return failureResponse(resolved);
  const { pass } = resolved;

  const rate = await enforceRateLimit({ key: `capture-upload:${pass.id}`, windowMs: 60_000, maxAttempts: 20 });
  if (!rate.allowed) return bad("Too many uploads. Please wait a minute.", 429);

  const form = await request.formData().catch(() => null);
  if (!form) return bad("The upload could not be read.");
  const parsed = parseForm(form);
  if (parsed instanceof NextResponse) return parsed;

  const bytes = Buffer.from(await parsed.file.arrayBuffer());
  if (parsed.kind === "paperwork" && detectFileSignature(bytes)?.extension === "pdf") {
    return bad("Paperwork from the phone must be a picture.");
  }

  if ((await findOwnerName(pass.entityType, pass.entityId)) === null) return failureResponse(endedFailure("closed"));

  if (!(await takeSlot(pass.id))) {
    const again = await findPass(rawToken);
    if (again === null) {
      return failureResponse({ ok: false, status: 404, body: { error: "This link is not valid." } });
    }
    return failureResponse(endedFailure(again.ok ? "full" : again.reason));
  }

  const actor: AuditActor = {
    kind: "user",
    actorId: pass.createdById,
    actorName: pass.creatorName,
    actorIp: getClientIp(request),
  };
  let stored: { id: string };
  try {
    // `async () => await`: a Prisma promise is lazy, so returning it
    // un-awaited would run it after `run` left the store.
    const id = await auditStorage.run({ actor }, async () =>
      parsed.kind === "photo"
        ? (
            await addPhoto({
              bytes,
              type: pass.entityType,
              entityId: pass.entityId,
              label: parsed.label,
              createdById: pass.createdById,
              viaPass: true,
            })
          ).id
        : await storePaperwork(pass, bytes, parsed),
    );
    stored = { id };
  } catch (e) {
    await giveSlotBack(pass.id);
    if (e instanceof PictureRejected) return bad(e.code === "HEIC" ? HEIC_MESSAGE : e.message);
    console.error("Capture pass upload failed:", describeError(e));
    return bad("Failed to upload", 500);
  }

  // The upload is stored: from here nothing may give the slot back.
  const count = await uploadCountOf(pass.id).catch(() => pass.uploadCount + 1);
  const remaining = Math.max(0, PASS_MAX_UPLOADS - count);
  return NextResponse.json({ kind: parsed.kind, id: stored.id, remaining }, { status: 201, headers: { "Cache-Control": "no-store" } });
}
