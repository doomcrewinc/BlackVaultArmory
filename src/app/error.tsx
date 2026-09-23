"use client";

import { useEffect, useState } from "react";
import { probeDatabase, type DbStatus } from "@/lib/db-status";
import { DatabaseDownSplash } from "@/components/layout/DatabaseDownSplash";

/**
 * Route-level error boundary. A page whose data fetch hit a dead database
 * throws during render, so ask health what happened: an outage gets the same
 * blocking notice the rest of the app uses, and anything else gets a plain
 * error with a way out.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [status, setStatus] = useState<DbStatus | "checking">("checking");

  useEffect(() => {
    console.error("[error boundary]", error);
    let cancelled = false;
    void probeDatabase().then((next) => {
      if (!cancelled) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, [error]);

  if (status === "checking") {
    return <div className="min-h-svh bg-vault-bg" aria-busy="true" />;
  }

  if (status !== "ok") {
    return <DatabaseDownSplash status={status} onRecovered={reset} />;
  }

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-vault-bg px-6">
      <p className="text-lg font-semibold text-vault-text">
        Something went wrong
      </p>
      <p className="max-w-xs text-center text-sm text-vault-text-muted">
        This page failed to load. The database is answering, so trying again may
        be enough.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded px-6 py-2 text-sm font-medium text-vault-bg transition-opacity hover:opacity-80"
        style={{ backgroundColor: "#00C2FF" }}
      >
        Try again
      </button>
    </div>
  );
}
