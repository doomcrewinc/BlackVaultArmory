"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionCard } from "@/components/shared/SectionCard";
import { LoadingState } from "@/components/shared/LoadingState";
import { StatusMessage } from "@/components/shared/StatusMessage";
import { buttonClassName } from "@/components/shared/StandardButton";
import { AuditFilters, EMPTY_AUDIT_FILTERS, type AuditFiltersState } from "@/components/audit/AuditFilters";
import { AuditList } from "@/components/audit/AuditList";
import type { AuditEventDto } from "@/lib/audit/query";

/**
 * `/admin/audit` — the audit log list: filters synced to the URL query
 * string (so a filtered view is a link a teammate can be sent), newest
 * first, "Load more" by cursor (never reflected in the URL — a cursor is a
 * pagination position, not a shareable filter), and an Export CSV link that
 * carries whatever is currently filtered. `/admin/*` is already admin-gated
 * by src/proxy.ts; a plain USER never reaches this page.
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "UI".
 */

const LOCAL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_PREFIX = /^\d{4}-\d{2}-\d{2}T/;

/** A `YYYY-MM-DD` from `<input type=date>` (the VIEWER's local calendar day) as that day's local midnight, in UTC ISO. `null` for anything not shaped like a bare day (already an instant, or empty). */
function localDayStartIso(dateStr: string): string | null {
  const m = LOCAL_DAY.exec(dateStr);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).toISOString();
}

/** Same day, local 23:59:59.999 — the inclusive end of the viewer's local day, in UTC ISO. */
function localDayEndIso(dateStr: string): string | null {
  const m = LOCAL_DAY.exec(dateStr);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).toISOString();
}

/** The reverse of the two functions above: a full ISO instant back to the VIEWER's local calendar day, for the `<input type=date>` control. A bare `YYYY-MM-DD` (an old bookmarked link) passes through unchanged. */
function isoInstantToLocalDay(value: string): string {
  if (!ISO_INSTANT_PREFIX.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function filtersFromParams(params: URLSearchParams): AuditFiltersState {
  return {
    user: params.get("user") ?? "",
    action: params.get("action") ?? "",
    type: params.get("type") ?? "",
    from: isoInstantToLocalDay(params.get("from") ?? ""),
    to: isoInstantToLocalDay(params.get("to") ?? ""),
    q: params.get("q") ?? "",
  };
}

/**
 * `filters.from`/`filters.to` are the VIEWER's local calendar day
 * (`<input type=date>`'s native shape); the API and the CSV export read the
 * viewer's local day, not UTC's — so this sends the full local-midnight /
 * local-end-of-day ISO instant, never the bare day string. Both the list
 * fetch and the Export CSV link go through this one function, so they can
 * never disagree about what "the current filters" means.
 */
function toQueryString(filters: AuditFiltersState, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  if (filters.action) params.set("action", filters.action);
  if (filters.type) params.set("type", filters.type);
  const fromIso = filters.from ? localDayStartIso(filters.from) : null;
  if (fromIso) params.set("from", fromIso);
  const toIso = filters.to ? localDayEndIso(filters.to) : null;
  if (toIso) params.set("to", toIso);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

function AdminAuditPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchParamsString = searchParams.toString();

  const [filters, setFilters] = useState<AuditFiltersState>(EMPTY_AUDIT_FILTERS);
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every call to fetchPage claims the next id and only applies its own
  // result if nothing newer has started by the time it resolves. Guards
  // against a Load More still in flight when the filters change (the
  // URL-driven effect below starts a fresh, higher-numbered request) — the
  // stale one's response is silently dropped instead of appending the WRONG
  // filter's page onto the list, or clobbering `cursor` with a stale value.
  const requestIdRef = useRef(0);

  // The latest filters REQUESTED, whether or not the URL has caught up yet.
  // `filters` state only updates after router.replace changes the URL and the
  // effect below runs, so merging a change against it would drop any earlier
  // change still in flight (final review P3). The URL effect resets this to
  // what the URL says, so back/forward still wins.
  const latestFiltersRef = useRef<AuditFiltersState>(EMPTY_AUDIT_FILTERS);

  const fetchPage = useCallback(async (f: AuditFiltersState, afterCursor?: string) => {
    const requestId = ++requestIdRef.current;
    if (afterCursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const qs = toQueryString(f, afterCursor);
      const res = await fetch(`/api/admin/audit${qs ? `?${qs}` : ""}`);
      if (requestIdRef.current !== requestId) return; // superseded while in flight
      if (!res.ok) {
        setError("Failed to load audit events.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (requestIdRef.current !== requestId) return; // superseded while parsing
      const page: AuditEventDto[] = Array.isArray(data.events) ? data.events : [];
      setEvents((prev) => (afterCursor ? [...prev, ...page] : page));
      setCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
      setHasMore(Boolean(data.nextCursor));
    } catch {
      if (requestIdRef.current === requestId) setError("Failed to load audit events.");
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // The single source of truth for which page is loaded is the URL: on
  // mount, and on any change to it (a filter change below, or the browser's
  // back/forward button), re-derive filters from the query string and fetch
  // that page fresh. Filter changes never call fetchPage directly — only
  // through this effect — so there is exactly one fetch per URL, not two.
  useEffect(() => {
    const next = filtersFromParams(new URLSearchParams(searchParamsString));
    latestFiltersRef.current = next;
    setFilters(next);
    void fetchPage(next);
  }, [searchParamsString, fetchPage]);

  function handleFiltersChange(patch: Partial<AuditFiltersState>) {
    const next = { ...latestFiltersRef.current, ...patch };
    latestFiltersRef.current = next;
    const qs = toQueryString(next);
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const exportQs = toQueryString(filters);
  const exportHref = `/api/admin/audit/export${exportQs ? `?${exportQs}` : ""}`;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
      <PageHeader
        title="Audit Log"
        subtitle="Every change to the vault, attributed and permanent."
        actions={
          <a href={exportHref} className={buttonClassName("secondary")}>
            <Download className="h-4 w-4" />
            Export CSV
          </a>
        }
      />

      <SectionCard contentClassName="p-4 sm:p-5">
        <AuditFilters value={filters} onChange={handleFiltersChange} />
      </SectionCard>

      {error && <StatusMessage tone="error" message={error} />}

      <SectionCard contentClassName="p-0">
        {loading ? (
          <LoadingState label="Loading audit events…" />
        ) : (
          <AuditList
            events={events}
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={cursor ? () => fetchPage(filters, cursor) : undefined}
            emptyMessage="No audit events match these filters."
          />
        )}
      </SectionCard>
    </div>
  );
}

// useSearchParams() opts the page out of static rendering unless wrapped in
// Suspense (Next's requirement — a bare call throws during prerendering
// otherwise). The root layout's getCurrentUser() already forces every route
// dynamic, so this boundary is unlikely to ever actually suspend, but the
// requirement is enforced at build time regardless of that.
export default function AdminAuditPage() {
  return (
    <Suspense fallback={<LoadingState label="Loading audit events…" />}>
      <AdminAuditPageInner />
    </Suspense>
  );
}
