"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";

/**
 * Same inline confirm-in-place shape as DeleteGearButton and
 * DeleteSupplyButton — no modal, no new component vocabulary.
 *
 * What deleting a lot destroys, and what it does NOT, is decided by the
 * foreign keys, not here (verified in prisma/sqlite/migrations):
 *   - AmmoTransaction   ON DELETE CASCADE  — the lot's own ledger goes with it
 *   - RangeSessionAmmoLink ON DELETE SET NULL — the SESSION survives with its
 *     round count intact, showing "Removed lot (N)" in session history
 *   - KitItem           ON DELETE CASCADE  — the kit's LINE for this lot goes;
 *     the kit itself does not
 * The warning below says so, because "this also deletes your range sessions"
 * is what a user reasonably fears here and it is not what happens.
 */
interface Props {
  id: string;
  redirectTo?: string;
}

export function DeleteAmmoButton({ id, redirectTo = "/ammo" }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/ammo/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError("Failed to delete. Please try again.");
        setDeleting(false);
        setConfirming(false);
        return;
      }
      router.push(redirectTo);
    } catch {
      setError("Network error. Please try again.");
      setDeleting(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5 text-sm bg-vault-surface border border-[#E53935]/30 px-3 py-1.5 rounded-md">
        <span className="text-vault-text-muted">Delete?</span>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="text-[#E53935] hover:underline disabled:opacity-50"
        >
          {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className="text-vault-text-muted hover:underline disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="flex items-center gap-1.5 text-sm bg-vault-surface border border-vault-border text-vault-text-muted hover:text-[#E53935] hover:border-[#E53935]/40 px-3 py-1.5 rounded-md transition-colors"
      >
        <Trash2 className="w-4 h-4" />
        Delete
      </button>
      {error && <p className="text-xs text-[#E53935]">{error}</p>}
    </div>
  );
}
