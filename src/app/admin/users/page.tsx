"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { PageHeader } from "@/components/shared/PageHeader";
import { SectionCard } from "@/components/shared/SectionCard";
import { StandardButton } from "@/components/shared/StandardButton";
import { LoadingState } from "@/components/shared/LoadingState";
import { StatusMessage } from "@/components/shared/StatusMessage";
import { UserRow, type AdminUserRow } from "@/components/admin/UserRow";
import { InviteDialog } from "@/components/admin/InviteDialog";

type DialogState = { mode: "invite" } | { mode: "reset"; userId: string; displayName: string } | null;

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [usersRes, meRes] = await Promise.all([fetch("/api/admin/users"), fetch("/api/account")]);
        const usersData = await usersRes.json().catch(() => ({}));
        const meData = await meRes.json().catch(() => ({}));
        if (cancelled) return;
        if (!usersRes.ok) {
          setError("Failed to load users.");
          return;
        }
        setUsers(usersData.users ?? []);
        setCurrentUserId(typeof meData.id === "string" ? meData.id : null);
      } catch {
        if (!cancelled) setError("Failed to load users.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeAdminCount = users.filter((u) => u.role === "ADMIN" && !u.disabledAt).length;

  function handleChanged(updated: AdminUserRow) {
    setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 sm:px-6">
      <PageHeader
        title="Users"
        subtitle="Manage who has access to BlackVault"
        actions={
          <StandardButton
            type="button"
            variant="primary"
            icon={<UserPlus className="h-4 w-4" />}
            onClick={() => setDialog({ mode: "invite" })}
          >
            Invite someone
          </StandardButton>
        }
      />

      {error && <StatusMessage tone="error" message={error} />}

      {loading ? (
        <LoadingState label="Loading users…" />
      ) : (
        <SectionCard contentClassName="p-0">
          <div className="divide-y divide-vault-border">
            {users.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                currentUserId={currentUserId ?? ""}
                isLastActiveAdmin={user.role === "ADMIN" && !user.disabledAt && activeAdminCount === 1}
                onChanged={handleChanged}
                onResetLink={(u) => setDialog({ mode: "reset", userId: u.id, displayName: u.displayName })}
              />
            ))}
            {users.length === 0 && <p className="px-4 py-6 text-sm text-vault-text-muted">No users yet.</p>}
          </div>
        </SectionCard>
      )}

      {dialog?.mode === "invite" && <InviteDialog mode="invite" onClose={() => setDialog(null)} />}
      {dialog?.mode === "reset" && (
        <InviteDialog mode="reset" userId={dialog.userId} displayName={dialog.displayName} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}
