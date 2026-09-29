"use client";

import { useState } from "react";
import { Lock } from "lucide-react";
import { StandardButton } from "@/components/shared/StandardButton";
import { StatusMessage } from "@/components/shared/StatusMessage";

export type DirectAccessState = { allowed: boolean; source: "env" | "setting" };

/** Spec 1's plain-HTTP warning — shown while direct access is on, and before turning it on. */
export function PlainHttpWarningText({ url }: { url: string }) {
  return (
    <>
      Anyone on your network can reach BlackVault at <span className="font-mono">{url || "http://<ip>:<port>"}</span>{" "}
      without HTTPS. Logins over that address are sent unencrypted.
    </>
  );
}

/** "Admins only" marker for Settings controls a plain user sees read-only. */
export function AdminsOnlyNote({ testId }: { testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded border border-vault-border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-widest text-vault-text-faint"
    >
      <Lock className="h-3 w-3" />
      Admins only
    </span>
  );
}

interface DirectAccessPanelProps {
  state: DirectAccessState;
  isAdmin: boolean;
  lanUrl: string;
  /** Origin of PUBLIC_URL — where people get back in once direct access is off. */
  publicUrl: string;
  /** Whether TRUSTED_PROXIES is set. Without it, only loopback and direct access get through the gate. */
  trustedProxiesConfigured: boolean;
  onChange: (next: DirectAccessState) => void;
}

/**
 * Direct access (serving http://<ip>:<port>) — an admin toggle backed by
 * `PUT /api/settings/direct-access`; a plain user sees the status only. Both directions ask for
 * confirmation: on, behind the plain-HTTP warning; off, because it can lock everyone out — an
 * admin browsing over http://<ip>:<port> loses the connection within seconds, and without a
 * trusted proxy (the README's no-proxy default) even the host's own localhost:3000 arrives from
 * the Docker bridge gateway and is reset by the gate. Locked when BLACKVAULT_ALLOW_DIRECT_ACCESS
 * forces it on (the route answers 409 then anyway).
 */
export function DirectAccessPanel({
  state,
  isAdmin,
  lanUrl,
  publicUrl,
  trustedProxiesConfigured,
  onChange,
}: DirectAccessPanelProps) {
  const [confirming, setConfirming] = useState<"on" | "off" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forced = state.source === "env";

  async function save(allowDirectAccess: boolean) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/direct-access", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowDirectAccess }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Could not change direct access. Please try again.");
        return;
      }
      setConfirming(null);
      onChange({ allowed: json.allowed === true, source: json.source === "env" ? "env" : "setting" });
    } catch {
      setError("Could not change direct access. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function handleToggle() {
    if (forced || saving) return;
    setError(null);
    setConfirming(state.allowed ? "off" : "on");
  }

  const statusText = `Direct access: ${state.allowed ? "On" : "Off"}`;

  if (!isAdmin) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-vault-border bg-vault-bg px-3 py-2">
        <p data-testid="direct-access-state" className="text-xs text-vault-text-muted">
          {statusText}
          {forced ? " — forced on by the server environment" : ""}
        </p>
        <AdminsOnlyNote testId="direct-access-admins-only" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-md border border-vault-border px-4 py-3">
        <button
          type="button"
          role="switch"
          aria-checked={state.allowed}
          aria-label="Direct access over plain HTTP"
          onClick={handleToggle}
          disabled={forced || saving}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
            state.allowed ? "bg-[#00C2FF]" : "bg-vault-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
              state.allowed ? "left-4" : "left-0.5"
            }`}
          />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-vault-text">Direct access over plain HTTP</p>
          <p data-testid="direct-access-state" className="mt-0.5 text-xs text-vault-text-muted">
            {statusText}.{" "}
            {forced
              ? "Forced on by the server environment. Remove BLACKVAULT_ALLOW_DIRECT_ACCESS from .env and restart to use this switch."
              : "Lets phones on your network open BlackVault by its IP address. Changes apply within a few seconds."}
          </p>
        </div>
      </div>

      {confirming && (
        <div
          data-testid="direct-access-confirm"
          className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-400"
        >
          <p className="font-medium">{confirming === "on" ? "Turn on direct access?" : "Turn off direct access?"}</p>
          {confirming === "on" ? (
            <p className="text-xs text-amber-400/90">
              <PlainHttpWarningText url={lanUrl} />
            </p>
          ) : (
            <TurnOffWarning lanUrl={lanUrl} publicUrl={publicUrl} trustedProxiesConfigured={trustedProxiesConfigured} />
          )}
          <div className="flex flex-wrap gap-2">
            <StandardButton
              type="button"
              variant="danger"
              onClick={() => void save(confirming === "on")}
              loading={saving}
              loadingLabel={confirming === "on" ? "Turning on…" : "Turning off…"}
            >
              {confirming === "on" ? "Turn on direct access" : "Turn off direct access"}
            </StandardButton>
            <StandardButton type="button" variant="secondary" onClick={() => setConfirming(null)} disabled={saving}>
              Cancel
            </StandardButton>
          </div>
        </div>
      )}

      {error && <StatusMessage tone="error" message={error} />}
    </div>
  );
}

/** Is this browser on the public URL, or on some other address (direct http://<ip>:<port>)? */
function onPublicOrigin(publicUrl: string): boolean {
  try {
    return window.location.origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

/**
 * What turning direct access off does, and how to recover. Rendered only after a click, so
 * reading `window.location` here never runs during server rendering.
 */
function TurnOffWarning({
  lanUrl,
  publicUrl,
  trustedProxiesConfigured,
}: {
  lanUrl: string;
  publicUrl: string;
  trustedProxiesConfigured: boolean;
}) {
  const publicTarget = publicUrl || "the public URL";
  return (
    <>
      {onPublicOrigin(publicUrl) ? (
        <p className="text-xs text-amber-400/90">
          Opening BlackVault at <span className="font-mono">{lanUrl || "http://<ip>:<port>"}</span> will stop working
          within a few seconds. Phones and other devices will need{" "}
          <span className="font-mono break-all">{publicTarget}</span> instead.
        </p>
      ) : (
        <p className="text-xs text-amber-400/90">
          You&apos;re connected over this address. You&apos;ll lose access in a few seconds. To get back in, open{" "}
          <span className="font-mono break-all">{publicTarget}</span>, or set{" "}
          <span className="font-mono">BLACKVAULT_ALLOW_DIRECT_ACCESS=true</span> in .env and restart.
        </p>
      )}
      {!trustedProxiesConfigured && (
        <p className="text-xs font-medium text-amber-400">
          No trusted proxy is configured, so there may be no way in except{" "}
          <span className="font-mono break-all">{publicTarget}</span> on this machine, or setting{" "}
          <span className="font-mono">BLACKVAULT_ALLOW_DIRECT_ACCESS=true</span> in .env and restarting.
        </p>
      )}
    </>
  );
}
