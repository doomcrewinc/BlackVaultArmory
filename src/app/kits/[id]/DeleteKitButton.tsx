"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";

interface Props {
  id: string;
  redirectTo?: string;
}

/**
 * Deletes the kit — the container and its packing list, and nothing else.
 *
 * `DELETE /api/kits/[id]` removes the Kit row; the KitItem rows cascade from
 * `KitItem.kitId`. The four inventory tables a KitItem points at cascade the
 * OPPOSITE way (deleting a Gear row removes the KitItem referencing it, not
 * the reverse), so unpacking a bag never deletes the rifle that was in it.
 * The route's own comment and its tests say the same; this button is the
 * surface that has to be trusted not to imply otherwise, which is why it
 * confirms inline rather than firing on one click.
 *
 * Follows DeleteGearButton's shape exactly — inline "Delete?" / Yes / Cancel,
 * no modal — and defaults to `/prep/kits`, the registry-derived list that
 * carries the nav entry.
 */
export function DeleteKitButton({ id, redirectTo = "/prep/kits" }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/kits/${id}`, { method: "DELETE" });
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
      <div className="flex items-center gap-1.5 rounded-md border border-[#E53935]/30 bg-vault-surface px-3 py-1.5 text-sm">
        <span className="text-vault-text-muted">Delete?</span>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleting}
          className="text-[#E53935] hover:underline disabled:opacity-50"
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Yes"}
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
        className="flex items-center gap-1.5 rounded-md border border-vault-border bg-vault-surface px-3 py-1.5 text-sm text-vault-text-muted transition-colors hover:border-[#E53935]/40 hover:text-[#E53935]"
      >
        <Trash2 className="h-4 w-4" />
        Delete
      </button>
      {error && <p className="text-xs text-[#E53935]">{error}</p>}
    </div>
  );
}
