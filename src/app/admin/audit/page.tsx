"use client";

import { useCallback, useEffect, useState } from "react";
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

function filtersFromParams(params: URLSearchParams): AuditFiltersState {
  return {
    user: params.get("user") ?? "",
    action: params.get("action") ?? "",
    type: params.get("type") ?? "",
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    q: params.get("q") ?? "",
  };
}

function toQueryString(filters: AuditFiltersState, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.user) params.set("user", filters.user);
  if (filters.action) params.set("action", filters.action);
  if (filters.type) params.set("type", filters.type);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.q) params.set("q", filters.q);
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export default function AdminAuditPage() {
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

  const fetchPage = useCallback(async (f: AuditFiltersState, afterCursor?: string) => {
    if (afterCursor) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const qs = toQueryString(f, afterCursor);
      const res = await fetch(`/api/admin/audit${qs ? `?${qs}` : ""}`);
      if (!res.ok) {
        setError("Failed to load audit events.");
        return;
      }
      const data = await res.json().catch(() => ({}));
      const page: AuditEventDto[] = Array.isArray(data.events) ? data.events : [];
      setEvents((prev) => (afterCursor ? [...prev, ...page] : page));
      setCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
      setHasMore(Boolean(data.nextCursor));
    } catch {
      setError("Failed to load audit events.");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // The single source of truth for which page is loaded is the URL: on
  // mount, and on any change to it (a filter change below, or the browser's
  // back/forward button), re-derive filters from the query string and fetch
  // that page fresh. Filter changes never call fetchPage directly — only
  // through this effect — so there is exactly one fetch per URL, not two.
  useEffect(() => {
    const next = filtersFromParams(new URLSearchParams(searchParamsString));
    setFilters(next);
    void fetchPage(next);
  }, [searchParamsString, fetchPage]);

  function handleFiltersChange(next: AuditFiltersState) {
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
