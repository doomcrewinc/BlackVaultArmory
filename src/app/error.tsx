"use client";

import { useEffect, useState } from "react";
import { probeDatabase } from "@/lib/db-status";
import { useDatabaseStatus } from "@/components/layout/DatabaseStatusProvider";

/**
 * Route-level error boundary. A page whose data fetch hit a dead database
 * throws during render, so ask health what happened: an outage is handed to
 * DatabaseStatusProvider, which owns the notice and makes the app read-only,
 * and anything else gets a plain error with a way out.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { reportOutage } = useDatabaseStatus();
  const [verdict, setVerdict] = useState<"checking" | "outage" | "app-error">(
    "checking",
  );

  useEffect(() => {
    console.error("[error boundary]", error);
    let cancelled = false;
    void probeDatabase().then((status) => {
      if (cancelled) return;
      if (status === "ok") {
        setVerdict("app-error");
      } else {
        setVerdict("outage");
        // The provider shows the notice and re-renders this route once the
        // database is back.
        reportOutage(status, reset);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [error, reportOutage, reset]);

  if (verdict !== "app-error") {
    // Either still asking, or the provider's notice is covering the screen.
    return (
      <div
        className="min-h-svh bg-vault-bg"
        aria-busy={verdict === "checking"}
      />
    );
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
