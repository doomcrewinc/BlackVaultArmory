"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatTimestamp } from "@/lib/date";
import { summarize, detailEntries, childEntries, displayValue } from "@/lib/audit/summary";
import type { AuditEventDto } from "@/lib/audit/query";
import { cn } from "@/lib/utils";

/**
 * One row of the audit log: when / who / action / item / one-line summary,
 * expandable to every changed field's before/after (redacted fields show
 * only "changed", never a value — redact.ts). Used by both `/admin/audit`
 * (AuditList) and each item detail page's History section (ItemHistory).
 * docs/superpowers/specs/2026-09-29-audit-log-design.md, "UI".
 */
export function AuditRow({ event }: { event: AuditEventDto }) {
  const [expanded, setExpanded] = useState(false);
  const fields = detailEntries(event.changes);
  const children = childEntries(event.changes);
  const hasDetail = fields.length > 0 || children.length > 0;

  return (
    <div className="px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-vault-text-faint">
            <span>{formatTimestamp(event.at)}</span>
            <span aria-hidden>·</span>
            <span className="text-vault-text-muted">{event.actorName}</span>
            <span
              className="inline-flex items-center rounded-full border border-vault-border bg-vault-surface-2 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-vault-text-muted"
            >
              {event.action}
            </span>
          </div>
          <p className="text-sm text-vault-text">{summarize(event)}</p>
          <p className="text-xs text-vault-text-faint">{event.entityLabel ?? "—"}</p>
        </div>

        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            className="flex shrink-0 items-center gap-1 self-start rounded-md border border-vault-border px-2.5 py-1.5 text-xs text-vault-text-muted transition-colors hover:text-vault-text hover:bg-vault-surface-2 sm:self-auto"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {expanded ? "Hide" : "View"}
          </button>
        )}
      </div>

      {expanded && hasDetail && (
        <div className="mt-3 space-y-1.5 rounded-md border border-vault-border bg-vault-bg/40 p-3">
          {fields.map((entry) => (
            <div key={entry.field} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="w-32 shrink-0 text-vault-text-faint">{entry.label}</span>
              {entry.redacted ? (
                <span className="text-vault-text-muted italic">changed</span>
              ) : entry.kind === "diff" ? (
                <span className="text-vault-text-muted">
                  {displayValue(entry.before)} <span className="text-vault-text-faint">→</span>{" "}
                  <span className="text-vault-text">{displayValue(entry.after)}</span>
                </span>
              ) : (
                <span className="text-vault-text-muted">{displayValue(entry.value)}</span>
              )}
            </div>
          ))}
          {children.length > 0 && (
            <div className={cn("text-xs text-vault-text-faint", fields.length > 0 && "pt-1.5 border-t border-vault-border")}>
              Also removed: {children.map((c) => `${c.count} ${c.label} ${c.count === 1 ? "entry" : "entries"}`).join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
