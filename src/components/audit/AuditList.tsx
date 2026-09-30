import { Loader2 } from "lucide-react";
import { AuditRow } from "./AuditRow";
import { StandardButton } from "@/components/shared/StandardButton";
import type { AuditEventDto } from "@/lib/audit/query";

/**
 * Presentational list of audit events, newest first (as given — this
 * component does no sorting or fetching): a divide-y stack of AuditRow, an
 * empty state, and a "Load more" control. Used by `/admin/audit` (paged
 * against the full log) and ItemHistory (paged against one item's events) —
 * both own their own fetch/cursor state and pass events + handlers down.
 */
export function AuditList({
  events,
  hasMore = false,
  loading = false,
  onLoadMore,
  emptyMessage = "No matching events.",
}: {
  events: AuditEventDto[];
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  emptyMessage?: string;
}) {
  if (events.length === 0 && !loading) {
    return <p className="px-4 py-6 text-sm text-vault-text-muted">{emptyMessage}</p>;
  }

  return (
    <div>
      <div className="divide-y divide-vault-border">
        {events.map((event) => (
          <AuditRow key={event.id} event={event} />
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-4 text-xs text-vault-text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#00C2FF]" />
          Loading…
        </div>
      )}

      {!loading && hasMore && onLoadMore && (
        <div className="flex justify-center border-t border-vault-border py-3">
          <StandardButton type="button" variant="secondary" onClick={onLoadMore}>
            Load more
          </StandardButton>
        </div>
      )}
    </div>
  );
}
