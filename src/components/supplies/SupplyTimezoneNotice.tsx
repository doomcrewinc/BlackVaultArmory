"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Info, X } from "lucide-react";

/**
 * Shared by every surface that shows this notice, so dismissing it on the
 * dashboard dismisses it on the section pages and the detail page too. One
 * notice, one decision.
 */
const DISMISS_KEY = "bv-supply-timezone-notice-dismissed";

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Another tab dismissing it counts too.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    // A browser refusing storage just means the notice shows.
    return false;
  }
}

/**
 * The value used for SSR and for the hydration render. Always "dismissed", so
 * the server emits nothing and the hydration pass agrees with it; React then
 * re-renders with the real client snapshot. This is why the component reads
 * localStorage through useSyncExternalStore rather than in an effect —
 * `react-hooks/set-state-in-effect` is an ERROR in this repo, and this is the
 * primitive built for a client-only external value with its own server
 * snapshot.
 */
function serverSnapshot(): boolean {
  return true;
}

function dismiss() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage refused: the in-memory notify below still hides it for this view.
  }
  for (const listener of [...listeners]) listener();
}

/**
 * Warns that LOW / SOON / EXPIRED verdicts were resolved in the server's
 * timezone, while `AppSettings.timezone` is unset.
 *
 * Expiry is decided server-side. With no timezone saved, `todayForExpiry`
 * falls back to the host's zone — which inside a container is UTC, so a user
 * west of UTC sees a supply flip to EXPIRED an evening early. No silent
 * fallback can fix the container case, so every surface that renders an
 * expiry badge says so until the user sets a zone.
 *
 * Render it wherever those badges appear, passing the server's
 * `timezoneConfigured`; it renders nothing when a timezone IS configured, so
 * callers need no condition of their own for that.
 */
export function SupplyTimezoneNotice({
  timezoneConfigured,
  className = "",
}: {
  timezoneConfigured: boolean;
  /** Spacing for the surface it sits on; the box itself is fixed. */
  className?: string;
}) {
  const dismissed = useSyncExternalStore(
    subscribe,
    readDismissed,
    serverSnapshot,
  );

  if (timezoneConfigured || dismissed) return null;

  return (
    <div
      className={`flex items-start gap-3 rounded-md border border-[#F5A623]/40 bg-[#F5A623]/10 px-4 py-3 ${className}`}
    >
      <Info
        className="mt-0.5 h-4 w-4 shrink-0 text-[#F5A623]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-sm text-vault-text">
        <p>
          Expiry dates use the server&apos;s timezone until you set your own, so
          they can read a day early or late.
        </p>
        <Link href="/settings" className="text-[#00C2FF] hover:underline">
          Set your timezone
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss timezone notice"
        className="shrink-0 text-vault-text-muted hover:text-vault-text"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
