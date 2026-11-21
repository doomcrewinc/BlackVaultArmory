"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionCard } from "@/components/shared/SectionCard";
import { LoadingState } from "@/components/shared/LoadingState";
import { StatusMessage } from "@/components/shared/StatusMessage";
import { AuditList } from "./AuditList";
import type { AuditEventDto } from "@/lib/audit/query";

/**
 * Admin-only "History" section on an item detail page: every audit entry for
 * that one entity, newest first, "Load more" by cursor — `GET
 * /api/admin/audit/item/:type/:id` (admin-gated server-side too, so this is
 * defense in depth, not the only guard).
 *
 * The CALLER decides whether to render this at all: every detail page that
 * uses it only includes `<ItemHistory .../>` in its JSX for an ADMIN, so a
 * USER never even mounts this component and no request to the audit API is
 * ever made on their behalf. docs/superpowers/specs/2026-09-29-audit-log-design.md,
 * "UI" — "Item history".
 */
export function ItemHistory({ entityType, entityId }: { entityType: string; entityId: string }) {
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Callers set the loading flag and clear `error` before calling: Load more
  // in its click handler, an item change during render (below). A promise
  // chain, so every state update happens in a callback. Never rejects.
  const load = useCallback(
    (afterCursor?: string): Promise<void> =>
      Promise.resolve()
        .then(() => {
          const params = new URLSearchParams();
          if (afterCursor) params.set("cursor", afterCursor);
          const qs = params.toString();
          const url = `/api/admin/audit/item/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ""}`;
          return fetch(url);
        })
        .then(async (res) => {
          if (!res.ok) {
            setError("Failed to load history.");
            return;
          }
          const data = await res.json().catch(() => ({}));
          const page: AuditEventDto[] = Array.isArray(data.events) ? data.events : [];
          setEvents((prev) => (afterCursor ? [...prev, ...page] : page));
          setCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
          setHasMore(Boolean(data.nextCursor));
        })
        .catch(() => {
          setError("Failed to load history.");
        })
        .finally(() => {
          setLoading(false);
          setLoadingMore(false);
        }),
    [entityType, entityId],
  );

  // A different item: show the loading state and clear the error while its
  // first page loads (the effect below fetches it).
  const itemKey = JSON.stringify([entityType, entityId]);
  const [loadedItemKey, setLoadedItemKey] = useState(itemKey);
  if (loadedItemKey !== itemKey) {
    setLoadedItemKey(itemKey);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    void load();
  }, [load]);

  function loadMore(afterCursor: string) {
    setLoadingMore(true);
    setError(null);
    void load(afterCursor);
  }

  // A failed INITIAL load has nothing to show but the error. A failed LOAD
  // MORE must not throw away what already loaded — the list stays, and the
  // error appears alongside it, so the admin doesn't lose the page they were
  // already reading over one retry-able network blip.
  const initialLoadFailed = error !== null && events.length === 0;

  return (
    <SectionCard title="History" description="Every change recorded for this item.">
      {loading ? (
        <LoadingState label="Loading history…" />
      ) : initialLoadFailed ? (
        <StatusMessage tone="error" message={error} />
      ) : (
        <>
          <AuditList
            events={events}
            hasMore={hasMore}
            loading={loadingMore}
            onLoadMore={cursor ? () => loadMore(cursor) : undefined}
            emptyMessage="No history recorded for this item."
          />
          {error && <StatusMessage tone="error" message={error} className="mx-4 mb-4" />}
        </>
      )}
    </SectionCard>
  );
}
