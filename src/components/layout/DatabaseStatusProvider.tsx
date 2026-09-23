"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { looksLikeOutage, probeDatabase, type DbStatus } from "@/lib/db-status";
import { DatabaseDownSplash } from "./DatabaseDownSplash";

type Outage = Exclude<DbStatus, "ok">;

type DatabaseStatusApi = {
  /**
   * Declare an outage. `onRecovered` is called once the database answers
   * again — an error boundary passes its own reset() so its route re-renders.
   */
  reportOutage: (status: Outage, onRecovered?: () => void) => void;
};

const DatabaseStatusContext = createContext<DatabaseStatusApi | null>(null);

export function useDatabaseStatus(): DatabaseStatusApi {
  const api = useContext(DatabaseStatusContext);
  if (!api)
    throw new Error(
      "useDatabaseStatus must be used inside DatabaseStatusProvider",
    );
  return api;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Owns the one outage state for the whole app, so every way of finding out
 * about a dead database ends in the same place: a failed request from the
 * browser, or a page whose server render threw (see src/app/error.tsx).
 *
 * While an outage is showing, `children` — the entire app — is inert. That is
 * what makes everything read-only: no click, keystroke or form submit reaches
 * it, with no per-form wiring to forget. The notice itself renders outside
 * that subtree, so it stays usable.
 *
 * Nothing polls while the app is working; the first failed request is the
 * trigger.
 */
export function DatabaseStatusProvider({ children }: { children: ReactNode }) {
  const [outage, setOutage] = useState<Outage | null>(null);
  const verifying = useRef(false);
  const recoveryHandler = useRef<(() => void) | undefined>(undefined);
  const router = useRouter();

  const reportOutage = useCallback(
    (status: Outage, onRecovered?: () => void) => {
      if (onRecovered) recoveryHandler.current = onRecovered;
      setOutage((current) => current ?? status);
    },
    [],
  );

  const verify = useCallback(async () => {
    if (verifying.current) return;
    verifying.current = true;
    try {
      const status = await probeDatabase();
      if (status !== "ok") reportOutage(status);
    } finally {
      verifying.current = false;
    }
  }, [reportOutage]);

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
        // Confirm it, then let the caller handle its own error as before.
        void verify();
        throw error;
      }
    };

    return () => {
      window.fetch = original;
    };
  }, [verify]);

  const handleRecovered = useCallback(() => {
    setOutage(null);
    // Re-render the route that failed during the outage, if one did...
    recoveryHandler.current?.();
    recoveryHandler.current = undefined;
    // ...and re-fetch server components that rendered against a dead database.
    router.refresh();
  }, [router]);

  return (
    <DatabaseStatusContext.Provider value={{ reportOutage }}>
      <div id="bv-app-shell" inert={outage !== null}>
        {children}
      </div>
      {outage && (
        <DatabaseDownSplash status={outage} onRecovered={handleRecovered} />
      )}
    </DatabaseStatusContext.Provider>
  );
}
