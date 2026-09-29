"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";
import { StandardButton } from "@/components/shared/StandardButton";
import { INPUT_CLASS, LABEL_CLASS } from "@/components/auth/form-styles";
import { formatTimestamp } from "@/lib/date";
import type { Role } from "@/lib/accounts";

type InviteDialogProps =
  | { mode: "invite"; onClose: () => void }
  | { mode: "reset"; userId: string; displayName: string; onClose: () => void };

type LinkResult = { url: string; expiresAt: string };

/**
 * Shared shape for "Invite someone" (choose a role, then create an invite) and "Reset
 * link" (fires immediately for the given user) — both end up showing the same thing:
 * the link, a QR code, Copy, and its expiry.
 */
export function InviteDialog(props: InviteDialogProps) {
  const { mode, onClose } = props;
  const [role, setRole] = useState<Role>("USER");
  const [loading, setLoading] = useState(mode === "reset");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [copied, setCopied] = useState(false);

  async function createInvite() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Something went wrong");
        return;
      }
      setResult({ url: data.url, expiresAt: data.expiresAt });
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function createResetLink(userId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/reset-link`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Something went wrong");
        return;
      }
      setResult({ url: data.url, expiresAt: data.expiresAt });
    } catch {
      setError("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (mode === "reset") void createResetLink(props.userId);
    // Fires once, for the token this dialog was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!result?.url) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    import("qrcode").then((QRCode) => {
      QRCode.toDataURL(result.url, { width: 200, margin: 2 })
        .then((dataUrl) => {
          if (!cancelled) setQrDataUrl(dataUrl);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
  }, [result?.url]);

  async function handleCopy() {
    if (!result?.url) return;
    try {
      await navigator.clipboard.writeText(result.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be denied — the URL is still shown on screen to copy by hand.
    }
  }

  const title = mode === "invite" ? "Invite someone" : `Reset link for ${props.displayName}`;

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-sm space-y-4 rounded-lg border border-vault-border bg-vault-surface p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-vault-text">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-vault-text-faint hover:text-vault-text">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && <p className="text-sm text-[#E53935]">{error}</p>}

        {mode === "invite" && !result && (
          <div className="space-y-3">
            <div>
              <label htmlFor="invite-role" className={LABEL_CLASS}>
                Role
              </label>
              <select
                id="invite-role"
                className={INPUT_CLASS}
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                <option value="USER">User</option>
                <option value="ADMIN">Admin</option>
              </select>
            </div>
            <StandardButton
              type="button"
              variant="primary"
              className="w-full"
              loading={loading}
              loadingLabel="Creating…"
              onClick={createInvite}
            >
              Create invite
            </StandardButton>
          </div>
        )}

        {mode === "reset" && loading && !result && (
          <div className="flex items-center gap-2 text-sm text-vault-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" />
            Creating reset link…
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="break-all rounded-md border border-vault-border bg-vault-surface-2 px-3 py-2 text-xs text-vault-text">
              {result.url}
            </div>
            {qrDataUrl && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data: URI, not a servable asset */}
                <img src={qrDataUrl} alt="QR code for the link" width={200} height={200} className="rounded-md border border-vault-border" />
              </div>
            )}
            <p className="text-center text-xs text-vault-text-faint">Scan to open on your phone</p>
            <div className="flex items-center justify-between gap-2">
              <StandardButton
                type="button"
                variant="secondary"
                icon={copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                onClick={handleCopy}
              >
                {copied ? "Copied" : "Copy"}
              </StandardButton>
              <p className="text-xs text-vault-text-faint">Expires {formatTimestamp(result.expiresAt)}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
