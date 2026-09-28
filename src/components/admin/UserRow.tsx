"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { buttonClassName, StandardButton } from "@/components/shared/StandardButton";
import { formatTimestamp } from "@/lib/date";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/accounts";

/** The shape GET /api/admin/users returns for one row. Never the password hash. */
export type AdminUserRow = {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  disabledAt: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

export const LAST_ADMIN_TOOLTIP = "At least one active admin is required";

const ROLE_BADGE: Record<Role, string> = {
  ADMIN: "border-[#00C2FF]/35 bg-[#00C2FF]/12 text-[#00C2FF]",
  USER: "border-vault-border bg-vault-surface-2 text-vault-text-muted",
};

function Badge({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide", tone)}>
      {children}
    </span>
  );
}

/**
 * One row in the admin Users list. All state (role/disabled changes, the self-disable
 * confirmation) is local; the parent page owns the list and is told about a successful
 * change via `onChanged` so it can update its copy without a full refetch.
 */
export function UserRow({
  user,
  currentUserId,
  isLastActiveAdmin,
  onChanged,
  onResetLink,
}: {
  user: AdminUserRow;
  currentUserId: string;
  /** True only for the sole active admin — demoting or disabling THIS row would leave none. */
  isLastActiveAdmin: boolean;
  onChanged: (updated: AdminUserRow) => void;
  onResetLink: (user: AdminUserRow) => void;
}) {
  const [busy, setBusy] = useState<"role" | "disable" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmSelfDisable, setConfirmSelfDisable] = useState(false);

  const disabled = user.disabledAt !== null;
  const isSelf = user.id === currentUserId;

  async function apply(body: { role?: Role; disabled?: boolean }, kind: "role" | "disable") {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Something went wrong");
        return;
      }
      onChanged({
        ...user,
        ...body,
        disabledAt: body.disabled === undefined ? user.disabledAt : body.disabled ? new Date().toISOString() : null,
      });
      // The API ends every session of a newly-disabled user, including this one if it's
      // the actor disabling themselves — the next request from this browser is a 401, so
      // there is nothing left to do here but leave.
      if (isSelf && body.disabled === true) window.location.assign("/login");
    } catch {
      setError("Something went wrong");
    } finally {
      setBusy(null);
      setConfirmSelfDisable(false);
    }
  }

  function handleToggleRole() {
    apply({ role: user.role === "ADMIN" ? "USER" : "ADMIN" }, "role");
  }

  function handleToggleDisable() {
    if (!disabled && isSelf) {
      setConfirmSelfDisable(true);
      return;
    }
    apply({ disabled: !disabled }, "disable");
  }

  const blockDemote = user.role === "ADMIN" && isLastActiveAdmin;
  const blockDisable = !disabled && isLastActiveAdmin;

  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate text-sm font-medium text-vault-text">{user.displayName}</p>
          <Badge tone={ROLE_BADGE[user.role]}>{user.role === "ADMIN" ? "Admin" : "User"}</Badge>
          <Badge tone={disabled ? "border-[#E53935]/35 bg-[#E53935]/12 text-[#E53935]" : "border-[#00C853]/35 bg-[#00C853]/12 text-[#00C853]"}>
            {disabled ? "Disabled" : "Active"}
          </Badge>
        </div>
        <p className="truncate text-xs text-vault-text-faint">
          @{user.username} · Last login {formatTimestamp(user.lastLoginAt)}
        </p>
        {error && <p className="text-xs text-[#E53935]">{error}</p>}
        {confirmSelfDisable && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-[#E53935]/30 bg-[#E53935]/10 px-3 py-2 text-xs text-[#E53935]">
            <span>Disable your own account? You&rsquo;ll be logged out immediately.</span>
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => apply({ disabled: true }, "disable")}
            >
              Yes, disable me
            </button>
            <button type="button" className="underline" onClick={() => setConfirmSelfDisable(false)}>
              Cancel
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <StandardButton
          type="button"
          variant="secondary"
          loading={busy === "role"}
          disabled={blockDemote}
          title={blockDemote ? LAST_ADMIN_TOOLTIP : undefined}
          onClick={handleToggleRole}
        >
          {user.role === "ADMIN" ? "Make user" : "Make admin"}
        </StandardButton>
        <StandardButton
          type="button"
          variant={disabled ? "secondary" : "danger"}
          loading={busy === "disable"}
          disabled={blockDisable}
          title={blockDisable ? LAST_ADMIN_TOOLTIP : undefined}
          onClick={handleToggleDisable}
        >
          {disabled ? "Enable" : "Disable"}
        </StandardButton>
        <button
          type="button"
          className={buttonClassName("ghost")}
          onClick={() => onResetLink(user)}
        >
          <KeyRound className="h-4 w-4" />
          Reset link
        </button>
      </div>
      {(blockDemote || blockDisable) && (
        <p className="basis-full text-[11px] text-vault-text-faint sm:text-right">{LAST_ADMIN_TOOLTIP}</p>
      )}
    </div>
  );
}
