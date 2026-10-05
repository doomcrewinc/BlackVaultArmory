// Browser calls to the two public capture endpoints. The token travels in the
// URL path of these calls and nowhere else; no message built here contains it.

export const DOC_TYPE_OPTIONS = [
  { value: "RECEIPT", label: "Receipt" },
  { value: "NFA_TAX_STAMP", label: "NFA Tax Stamp" },
  { value: "PHOTO", label: "Photo" },
  { value: "OTHER", label: "Other" },
] as const;

export type DocTypeValue = (typeof DOC_TYPE_OPTIONS)[number]["value"];

export const NETWORK_MESSAGE = "Could not send. Check your connection and retry.";
export const RATE_LIMIT_MESSAGE = "Too many attempts. Wait a moment and try again.";
export const INVALID_LINK_MESSAGE = "This link is not valid.";

export type PassInfo = { itemName: string; remaining: number };

export type InfoResult =
  | { ok: true; info: PassInfo }
  | { ok: false; message: string; retryable: boolean };

async function messageOf(res: Response, fallback: string): Promise<string> {
  const json = await res.json().catch(() => null);
  return typeof json?.error === "string" ? json.error : fallback;
}

export async function loadPassInfo(token: string): Promise<InfoResult> {
  let res: Response;
  try {
    res = await fetch(`/api/capture/${encodeURIComponent(token)}`, { cache: "no-store" });
  } catch {
    return { ok: false, message: "Could not load. Check your connection and retry.", retryable: true };
  }
  if (res.ok) {
    const data = await res.json().catch(() => null);
    if (typeof data?.itemName !== "string" || typeof data?.remaining !== "number") {
      return { ok: false, message: "Something went wrong. Try again.", retryable: true };
    }
    return { ok: true, info: { itemName: data.itemName, remaining: data.remaining } };
  }
  if (res.status === 404) return { ok: false, message: INVALID_LINK_MESSAGE, retryable: false };
  if (res.status === 410) {
    return { ok: false, message: await messageOf(res, "This pass has ended."), retryable: false };
  }
  if (res.status === 429) return { ok: false, message: RATE_LIMIT_MESSAGE, retryable: true };
  return { ok: false, message: "Something went wrong. Try again.", retryable: true };
}

export type UploadFields =
  | { kind: "photo"; label: string }
  | { kind: "paperwork"; docType: DocTypeValue };

export type UploadResult =
  | { ok: true; remaining: number }
  | { ok: false; message: string; ended: boolean };

export async function sendUpload(token: string, file: File, fields: UploadFields): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("kind", fields.kind);
  if (fields.kind === "photo" && fields.label.trim()) form.append("label", fields.label.trim());
  if (fields.kind === "paperwork") form.append("docType", fields.docType);

  let res: Response;
  try {
    res = await fetch(`/api/capture/${encodeURIComponent(token)}/upload`, { method: "POST", body: form });
  } catch {
    return { ok: false, message: NETWORK_MESSAGE, ended: false };
  }
  if (res.status === 201) {
    const data = await res.json().catch(() => null);
    return { ok: true, remaining: typeof data?.remaining === "number" ? data.remaining : 0 };
  }
  if (res.status === 429) return { ok: false, message: RATE_LIMIT_MESSAGE, ended: false };
  const ended = res.status === 410 || res.status === 404;
  const fallback = res.status === 404 ? INVALID_LINK_MESSAGE : "Upload failed.";
  return { ok: false, message: await messageOf(res, fallback), ended };
}
