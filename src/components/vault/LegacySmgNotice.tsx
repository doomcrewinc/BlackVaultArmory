"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Info, X } from "lucide-react";

const DISMISS_KEY = "bv-legacy-smg-notice-dismissed";

/**
 * Surfaces firearms still on the legacy SMG platform. It counts them and links
 * to them; it never reclassifies anything, because whether a given gun is
 * select-fire is not something the data can say.
 */
export function LegacySmgNotice() {
  const [count, setCount] = useState(0);
  // Lazy-initialized (not read in an effect) so the check is hydration-safe:
  // this component always renders null until `count` resolves, so the real
  // value below never disagrees with the server's SSR default of `true`.
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/categories/counts")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body) setCount(body.legacySmgCount ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (dismissed || count === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // A browser that refuses storage still gets the dismissal for this view.
    }
  };

  return (
    <div className="mb-4 flex items-start gap-3 rounded-md border border-[#F5A623]/40 bg-[#F5A623]/10 px-4 py-3">
      <Info
        className="mt-0.5 h-4 w-4 shrink-0 text-[#F5A623]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1 text-sm text-vault-text">
        <p>
          {count} {count === 1 ? "firearm uses" : "firearms use"} the old SMG
          type and
          {count === 1 ? " has" : " have"} no class set yet.
        </p>
        <Link
          href="/vault/category/other-firearms"
          className="text-[#00C2FF] hover:underline"
        >
          Review {count === 1 ? "it" : "them"}
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notice"
        className="shrink-0 text-vault-text-muted hover:text-vault-text"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
