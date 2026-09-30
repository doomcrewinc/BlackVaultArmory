"use client";

import { useEffect, useRef, useState } from "react";
import type { AuditActionGroup } from "@/lib/audit/query";
import { AUDITED_MODELS } from "@/lib/audit/registry";
import { modelFilterLabel } from "@/lib/audit/labels";

// AUDITED_MODELS (registry.ts) plus "User": security events (LOGIN,
// ROLE_CHANGED, USER_DISABLED, …) carry entityType "User", but User is
// explicitly EXCLUDED from AUDITED_MODELS (its own CREATE/UPDATE/DELETE are
// never audited — only the named security actions are). Without this, the
// item-type filter had no way to select "everything about a user account".
const ITEM_TYPE_OPTIONS: readonly string[] = [...AUDITED_MODELS, "User"];

// The five group keys, NOT imported as a value from src/lib/audit/query.ts
// (only its AuditActionGroup TYPE is imported above): that module's ACTION_GROUPS
// constant sits next to `import { prisma } from "../prisma"`, and prisma.ts pulls
// in the audit extension's AsyncLocalStorage (`node:async_hooks`) — fine in a
// server component or an API route, fatal in a CLIENT component's bundle
// ("the chunking context does not support external modules"). A type-only
// import is erased at compile time and carries none of that; this literal list
// is the client-safe equivalent, kept in the same order ACTION_GROUP_LABELS
// below uses, and typed against AuditActionGroup so a renamed or removed group
// fails typecheck here too.
const ACTION_GROUP_KEYS: readonly AuditActionGroup[] = ["creates", "edits", "deletes", "signins", "security"];

/**
 * `/admin/audit`'s filter bar — user, action group, item type, date range,
 * and item-name search, all controlled: the page owns the value and syncs it
 * to the URL query string, this component only reports changes. Matches
 * `AuditFilters` (src/lib/audit/query.ts) field-for-field except every value
 * here is a plain string (form input shape) rather than the parsed
 * Date/AuditActionGroup the API expects — the page's query-building is what
 * turns one into the other.
 */
export type AuditFiltersState = {
  user: string;
  action: string;
  type: string;
  from: string;
  to: string;
  q: string;
};

export const EMPTY_AUDIT_FILTERS: AuditFiltersState = { user: "", action: "", type: "", from: "", to: "", q: "" };

type AdminUserOption = { id: string; displayName: string; username: string };

const ACTION_GROUP_LABELS: Record<AuditActionGroup, string> = {
  creates: "Creates",
  edits: "Edits",
  deletes: "Deletes",
  signins: "Sign-ins",
  security: "Security",
};

/** Debounce for the name search: 500ms fetches for every filter change; typing "glock" is 5 requests without this. */
const SEARCH_DEBOUNCE_MS = 300;

const inputClass =
  "bg-vault-bg border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] w-full";
const labelClass = "block text-[10px] uppercase tracking-widest text-vault-text-muted mb-1.5";

export function AuditFilters({
  value,
  onChange,
}: {
  value: AuditFiltersState;
  /**
   * Receives only the fields that changed. The PARENT merges them against its
   * latest requested filters: merging here against the render-time `value`
   * would drop an earlier change made before `value` caught up (two selects in
   * one tick, or a select changed during the search debounce).
   */
  onChange: (patch: Partial<AuditFiltersState>) => void;
}) {
  const [users, setUsers] = useState<AdminUserOption[]>([]);
  // The name search is the only debounced control — a select/date change is
  // already a single discrete action, but typing fires one event per
  // keystroke, and each would otherwise re-fetch and re-write the URL.
  const [searchInput, setSearchInput] = useState(value.q);
  // Tracks the last `value.q` this component has already reflected, so a
  // change that came from OUTSIDE (e.g. the browser's back button changing
  // the URL) can be told apart from the round-trip of this component's own
  // debounced commit. Adjusted during render, not an effect — React's
  // documented pattern for "state that mirrors a prop, except while the user
  // is actively editing it" (an effect here would set state after paint,
  // which is both a lint error, react-hooks/set-state-in-effect, and a
  // visible flash of the stale value first).
  const [lastExternalQ, setLastExternalQ] = useState(value.q);
  if (value.q !== lastExternalQ) {
    setLastExternalQ(value.q);
    setSearchInput(value.q);
  }
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setUsers(Array.isArray(data.users) ? data.users : []);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  function set(patch: Partial<AuditFiltersState>) {
    onChange(patch);
  }

  function handleSearchChange(next: string) {
    setSearchInput(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => set({ q: next }), SEARCH_DEBOUNCE_MS);
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      <div>
        <label htmlFor="audit-filter-user" className={labelClass}>
          User
        </label>
        <select id="audit-filter-user" value={value.user} onChange={(e) => set({ user: e.target.value })} className={inputClass}>
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} (@{u.username})
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="audit-filter-action" className={labelClass}>
          Action
        </label>
        <select id="audit-filter-action" value={value.action} onChange={(e) => set({ action: e.target.value })} className={inputClass}>
          <option value="">All actions</option>
          {ACTION_GROUP_KEYS.map((group) => (
            <option key={group} value={group}>
              {ACTION_GROUP_LABELS[group]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="audit-filter-type" className={labelClass}>
          Item type
        </label>
        <select id="audit-filter-type" value={value.type} onChange={(e) => set({ type: e.target.value })} className={inputClass}>
          <option value="">All types</option>
          {ITEM_TYPE_OPTIONS.map((model) => (
            <option key={model} value={model}>
              {modelFilterLabel(model)}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="audit-filter-from" className={labelClass}>
          From
        </label>
        <input
          id="audit-filter-from"
          type="date"
          value={value.from}
          onChange={(e) => set({ from: e.target.value })}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="audit-filter-to" className={labelClass}>
          To
        </label>
        <input id="audit-filter-to" type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} className={inputClass} />
      </div>

      <div className="col-span-2 sm:col-span-1">
        <label htmlFor="audit-filter-q" className={labelClass}>
          Search item name
        </label>
        <input
          id="audit-filter-q"
          type="text"
          value={searchInput}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="e.g. Glock 19"
          className={inputClass}
        />
      </div>
    </div>
  );
}
