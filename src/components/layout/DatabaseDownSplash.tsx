"use client";

import { useEffect, useState } from "react";
import { probeDatabase, RETRY_SECONDS, type DbStatus } from "@/lib/db-status";

type Outage = Exclude<DbStatus, "ok">;

const COPY: Record<Outage, { title: string; body: string }> = {
  "db-down": {
    title: "Database unavailable",
    body: "BlackVault can't reach its database. Your data is safe, and nothing can be saved until the connection is back.",
  },
  unreachable: {
    title: "Connection lost",
    body: "BlackVault isn't answering — it may be restarting. Your data is safe, and nothing can be saved until it's back.",
  },
};

/**
 * Full-screen, blocking notice shown while the database is unreachable. It
 * retries on its own every few seconds and calls onRecovered as soon as the
 * database answers. Blocking is what makes the app read-only: the caller marks
 * everything behind this inert, so no write can be started at all.
 */
export function DatabaseDownSplash({
  status,
  onRecovered,
}: {
  status: Outage;
  onRecovered: () => void;
}) {
  const [seconds, setSeconds] = useState(RETRY_SECONDS);
  // A zero countdown *is* the probe running; no second piece of state to skew.
  const checking = seconds === 0;

  // Counts down, then probes; a failed probe starts the countdown again.
  useEffect(() => {
    if (seconds > 0) {
      const timer = setTimeout(() => setSeconds((s) => s - 1), 1000);
      return () => clearTimeout(timer);
    }

    let cancelled = false;
    void probeDatabase().then((next) => {
      if (cancelled) return;
      if (next === "ok") onRecovered();
      else setSeconds(RETRY_SECONDS);
    });
    return () => {
      cancelled = true;
    };
  }, [seconds, onRecovered]);

  // The page behind is inert, but its scroll position is not; freeze it so the
  // notice cannot be scrolled away from.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const { title, body } = COPY[status];

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="bv-db-outage-title"
      aria-describedby="bv-db-outage-body"
      className="fixed inset-0 z-[1000] flex items-center justify-center px-6 bg-vault-bg/90 backdrop-blur-sm"
    >
      <div className="w-full max-w-sm rounded-lg border border-vault-border bg-vault-surface p-8 text-center shadow-2xl">
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className="mx-auto mb-5 animate-pulse"
        >
          <path
            d="M12 3 L22 20 L2 20 Z"
            fill="none"
            stroke="#E53935"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <line
            x1="12"
            y1="9"
            x2="12"
            y2="14"
            stroke="#E53935"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <circle cx="12" cy="17" r="1.1" fill="#E53935" />
        </svg>

        <h1
          id="bv-db-outage-title"
          className="mb-3 text-lg font-semibold text-vault-text"
        >
          {title}
        </h1>

        <p
          id="bv-db-outage-body"
          className="mb-2 text-sm leading-relaxed text-vault-text-muted"
        >
          {body}
        </p>
        <p className="mb-6 text-xs text-vault-text-muted">
          Anything you were typing is still on the page behind this.
        </p>

        <p aria-live="polite" className="mb-4 text-sm text-vault-text">
          {checking ? "Reconnecting…" : `Retrying in ${seconds}s`}
        </p>

        <button
          type="button"
          autoFocus
          onClick={() => setSeconds(0)}
          disabled={checking}
          className="rounded px-6 py-2 text-sm font-medium text-vault-bg transition-opacity hover:opacity-80 disabled:opacity-50"
          style={{ backgroundColor: "#00C2FF" }}
        >
          Retry now
        </button>
      </div>
    </div>
  );
}
