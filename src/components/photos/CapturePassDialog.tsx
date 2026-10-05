"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, FileText, Loader2, X } from "lucide-react";
import { UNREACHABLE_MESSAGE } from "@/lib/capture/pass-url";
import type { PhotoEntityType } from "@/lib/photos/client-constants";
import { useCapturePass } from "./useCapturePass";

type Props = Readonly<{ entityType: PhotoEntityType; entityId: string; onClose: () => void }>;

const BUTTON =
  "flex items-center justify-center gap-1.5 text-xs border px-3 py-1.5 rounded transition-colors disabled:opacity-50";
const SECONDARY = `${BUTTON} border-vault-border text-vault-text-muted hover:bg-vault-border`;
const PRIMARY = `${BUTTON} border-[#00C2FF]/30 bg-[#00C2FF]/10 text-[#00C2FF] hover:bg-[#00C2FF]/20`;

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A QR code and link for a short-lived pass that lets a phone add to one item. */
export function CapturePassDialog({ entityType, entityId, onClose }: Props) {
  const pass = useCapturePass(entityType, entityId);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const url = pass.link?.reachable && !pass.ended ? pass.link.url : null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (!url) {
      setQr("");
      return;
    }
    let cancelled = false;
    import("qrcode")
      .then((QRCode) => QRCode.toDataURL(url, { width: 200, margin: 2 }))
      .then((data) => {
        if (!cancelled) setQr(data);
      })
      .catch(() => {
        // No image: the link and Copy still work.
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The link is on screen to copy by hand.
    }
  }

  const arrived = pass.photos.length + pass.documents.length;

  let linkPanel: ReactNode = null;
  if (pass.link) {
    if (pass.ended) {
      linkPanel = <p className="text-sm font-medium text-vault-text">Pass ended.</p>;
    } else if (pass.link.reachable) {
      linkPanel = (
        <>
          {qr && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, not a servable asset */}
              <img src={qr} alt="QR code for the capture link" width={200} height={200} className="rounded-md border border-vault-border" />
            </div>
          )}
          <p className="text-center text-xs text-vault-text-faint">Scan to add photos and paperwork from your phone</p>
          <div className="break-all rounded-md border border-vault-border bg-vault-surface-2 px-3 py-2 text-xs text-vault-text">
            {pass.link.url}
          </div>
        </>
      );
    } else {
      linkPanel = <p role="alert" className="text-sm text-[#E53935]">{UNREACHABLE_MESSAGE}</p>;
    }
  }

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/60"
      />
      <dialog
        open
        aria-modal="true"
        aria-label="Continue on phone"
        className="relative inset-auto m-0 block h-auto w-full max-w-sm max-h-[90svh] overflow-y-auto space-y-4 rounded-lg border border-vault-border bg-vault-surface p-5 text-inherit"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-vault-text">Continue on phone</h2>
          <button type="button" onClick={onClose} aria-label="Close dialog" className="text-vault-text-faint hover:text-vault-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {pass.error && <p role="alert" className="text-sm text-[#E53935]">{pass.error}</p>}

        {pass.creating && (
          <div className="flex items-center gap-2 text-sm text-vault-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Creating pass…
          </div>
        )}

        {pass.link && !pass.creating && (
          <div className="space-y-3">
            {linkPanel}

            {!pass.ended && (
              <div className="flex items-center justify-between gap-2">
                {pass.link.reachable ? (
                  <button type="button" onClick={() => void copy()} className={SECONDARY}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? "Copied" : "Copy link"}
                  </button>
                ) : (
                  <span />
                )}
                <span role="timer" aria-label="Time left" className="text-xs text-vault-text-faint">
                  {clock(pass.secondsLeft)}
                </span>
              </div>
            )}

            {pass.reconnecting && !pass.ended && <p className="text-xs text-vault-text-faint">Reconnecting…</p>}

            <div aria-label="Arrived from the phone" className="space-y-2">
              <p className="text-xs text-vault-text-muted">{arrived === 0 ? "Nothing received yet." : `${arrived} received`}</p>
              {pass.photos.length > 0 && (
                <ul className="grid grid-cols-4 gap-2">
                  {pass.photos.map((p) => (
                    <li key={p.id}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.previewUrl} alt={p.label ?? "Photo from phone"} className="aspect-square w-full rounded border border-vault-border object-cover" />
                    </li>
                  ))}
                </ul>
              )}
              {pass.documents.length > 0 && (
                <ul className="space-y-1">
                  {pass.documents.map((d) => (
                    <li key={d.id} className="flex items-center gap-1.5 text-xs text-vault-text">
                      <FileText className="h-3.5 w-3.5 shrink-0 text-vault-text-faint" />
                      <span className="truncate">{d.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {pass.ended ? (
                <button type="button" onClick={pass.create} className={PRIMARY}>
                  New pass
                </button>
              ) : (
                <button type="button" disabled={pass.closing} onClick={pass.close} className={SECONDARY}>
                  {pass.closing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Close pass
                </button>
              )}
            </div>
            {!pass.ended && (
              <p className="text-xs text-vault-text-faint">The pass stays open until it expires or you close it.</p>
            )}
          </div>
        )}

        {pass.error && !pass.creating && !pass.link && (
          <button type="button" onClick={pass.create} className={PRIMARY}>
            Try again
          </button>
        )}
      </dialog>
    </div>
  );
}
