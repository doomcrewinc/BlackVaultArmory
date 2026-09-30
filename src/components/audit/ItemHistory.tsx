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

  const load = useCallback(
    async (afterCursor?: string) => {
      if (afterCursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (afterCursor) params.set("cursor", afterCursor);
        const qs = params.toString();
        const url = `/api/admin/audit/item/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}${qs ? `?${qs}` : ""}`;
        const res = await fetch(url);
        if (!res.ok) {
          setError("Failed to load history.");
          return;
        }
        const data = await res.json().catch(() => ({}));
        const page: AuditEventDto[] = Array.isArray(data.events) ? data.events : [];
        setEvents((prev) => (afterCursor ? [...prev, ...page] : page));
        setCursor(typeof data.nextCursor === "string" ? data.nextCursor : null);
        setHasMore(Boolean(data.nextCursor));
      } catch {
        setError("Failed to load history.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [entityType, entityId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <SectionCard title="History" description="Every change recorded for this item.">
      {loading ? (
        <LoadingState label="Loading history…" />
      ) : error ? (
        <StatusMessage tone="error" message={error} />
      ) : (
        <AuditList
          events={events}
          hasMore={hasMore}
          loading={loadingMore}
          onLoadMore={cursor ? () => load(cursor) : undefined}
          emptyMessage="No history recorded for this item."
        />
      )}
    </SectionCard>
  );
}
