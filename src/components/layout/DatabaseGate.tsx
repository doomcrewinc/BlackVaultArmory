"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { looksLikeOutage, probeDatabase, type DbStatus } from "@/lib/db-status";
import { DatabaseDownSplash } from "./DatabaseDownSplash";

type Outage = Exclude<DbStatus, "ok">;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Watches this app's own requests and, when one fails the way an outage looks,
 * confirms it against /api/health before blocking the UI. Nothing polls while
 * the app is working — the first failed request is the trigger.
 *
 * `shellId` names the element holding the whole app; it is marked inert while
 * the notice is up, which is what makes everything read-only: no click, no
 * keystroke and no form submit reaches it.
 */
export function DatabaseGate({ shellId }: { shellId: string }) {
  const [outage, setOutage] = useState<Outage | null>(null);
  const verifying = useRef(false);
  const router = useRouter();

  const verify = useCallback(async () => {
    if (verifying.current) return;
    verifying.current = true;
    try {
      const status = await probeDatabase();
      if (status !== "ok") setOutage(status);
    } finally {
      verifying.current = false;
    }
  }, []);

  useEffect(() => {
    const original = window.fetch;

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const response = await original(input, init);
        if (
          !response.ok &&
          looksLikeOutage(
            requestUrl(input),
            response.status,
            window.location.origin,
          )
        ) {
          void verify();
        }
        return response;
      } catch (error) {
        // A thrown fetch is a network-level failure: the server may be gone.
        // Confirm, then let the caller handle its own error as before.
        void verify();
        throw error;
      }
    };

    return () => {
      window.fetch = original;
    };
  }, [verify]);

  // Read-only while the notice is up.
  useEffect(() => {
    const shell = document.getElementById(shellId);
    if (!shell) return;

    if (outage) {
      shell.setAttribute("inert", "");
      shell.setAttribute("aria-hidden", "true");
    } else {
      shell.removeAttribute("inert");
      shell.removeAttribute("aria-hidden");
    }

    return () => {
      shell.removeAttribute("inert");
      shell.removeAttribute("aria-hidden");
    };
  }, [outage, shellId]);

  const handleRecovered = useCallback(() => {
    setOutage(null);
    // Server components rendered during the outage hold stale or error state.
    router.refresh();
  }, [router]);

  if (!outage) return null;
  return <DatabaseDownSplash status={outage} onRecovered={handleRecovered} />;
}
