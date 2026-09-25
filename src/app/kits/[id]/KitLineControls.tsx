"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Loader2, Pencil, Trash2 } from "lucide-react";

const INPUT_CLASS =
  "w-full rounded-md border border-vault-border bg-vault-bg px-2 py-1.5 text-sm text-vault-text placeholder-vault-text-faint transition-colors focus:border-[#00C2FF] focus:outline-none";
const LABEL_CLASS =
  "mb-1 block text-[10px] font-medium uppercase tracking-widest text-vault-text-muted";

interface Props {
  kitId: string;
  itemId: string;
  /** Only for the delete confirmation's wording. */
  name: string;
  quantity: number;
  targetQuantity: number | null;
  notes: string | null;
}

/**
 * Edit or remove ONE packed line: the callers `PUT` and `DELETE
 * /api/kits/[id]/items/[itemId]` had been waiting for since task 3.
 *
 * WHAT THIS EDITS, AND WHAT IT DOES NOT. Quantity, target and notes — never
 * the line's SOURCE. Switching a line from gear to supply is delete-and-add,
 * and deliberately so: the PUT route merges the body over the stored row
 * before resolving the rule, so a body of `{ supplyId: "s1" }` on a line that
 * already holds a `gearId` resolves to TWO sources and earns a correct 400.
 * Switching in place would mean sending `{ supplyId: "s1", gearId: null }` —
 * a second place that knows which keys must be nulled, which is precisely the
 * knowledge `sourceColumns` centralises server-side. So the picker adds and
 * this removes; nothing here re-derives the source rule.
 *
 * THE TWO BLANK-FIELD RULES ARE DIFFERENT, AND BOTH ARE INTENTIONAL:
 *
 *   - `quantity` is NOT NULL. A blank input is sent as the raw `""`, which
 *     the route feeds to `normalizeAmount(quantity, existing.quantity)` and
 *     so PRESERVES the stored value. `Number("")` is 0 and `Number(" ")` is
 *     0, which is the bug that fallback exists to prevent — so this never
 *     calls `Number` on the field at all.
 *   - `targetQuantity` is nullable and CAN be cleared, so a blank input is
 *     sent as an explicit `null`. Sending `""` there would preserve the old
 *     target instead of removing it, and a target you cannot remove is a
 *     "missing" badge you cannot silence.
 *
 * Delete confirms inline — "Delete?" / Yes / Cancel, no modal — matching
 * DeleteKitButton and DeleteGearButton rather than inventing a third shape.
 */
export function KitLineControls({
  kitId,
  itemId,
  name,
  quantity,
  targetQuantity,
  notes,
}: Props) {
  const router = useRouter();

  const [mode, setMode] = useState<"idle" | "editing" | "confirming">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [quantityInput, setQuantityInput] = useState(String(quantity));
  const [targetInput, setTargetInput] = useState(
    targetQuantity === null ? "" : String(targetQuantity),
  );
  const [notesInput, setNotesInput] = useState(notes ?? "");

  function startEditing() {
    // Re-seed from the props every time, so a cancelled edit followed by a
    // second one starts from what is stored, not from the abandoned draft.
    setQuantityInput(String(quantity));
    setTargetInput(targetQuantity === null ? "" : String(targetQuantity));
    setNotesInput(notes ?? "");
    setError(null);
    setMode("editing");
  }

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/kits/${kitId}/items/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // No source key in this body — an absent key keeps the stored one.
          quantity: quantityInput,
          targetQuantity: targetInput.trim() === "" ? null : targetInput,
          notes: notesInput.trim() === "" ? null : notesInput,
        }),
      });

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? "Failed to save.");
        setBusy(false);
        return;
      }

      setBusy(false);
      setMode("idle");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/kits/${kitId}/items/${itemId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        setError("Failed to remove the line.");
        setBusy(false);
        setMode("idle");
        return;
      }

      setBusy(false);
      setMode("idle");
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
      setMode("idle");
    }
  }

  if (mode === "editing") {
    return (
      <div className="mt-2 space-y-3 rounded-md border border-vault-border bg-vault-bg p-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor={`qty-${itemId}`}
              className={LABEL_CLASS}
            >
              Quantity
            </label>
            <input
              id={`qty-${itemId}`}
              type="number"
              min={0}
              step="any"
              value={quantityInput}
              onChange={(event) => setQuantityInput(event.target.value)}
              className={INPUT_CLASS}
            />
          </div>
          <div>
            <label
              htmlFor={`target-${itemId}`}
              className={LABEL_CLASS}
            >
              Target
            </label>
            <input
              id={`target-${itemId}`}
              type="number"
              min={0}
              step="any"
              value={targetInput}
              onChange={(event) => setTargetInput(event.target.value)}
              placeholder="none"
              className={INPUT_CLASS}
            />
          </div>
        </div>
        <p className="text-[11px] text-vault-text-faint">
          Blank quantity keeps {quantity}. Blank target removes it.
        </p>
        <div>
          <label htmlFor={`notes-${itemId}`} className={LABEL_CLASS}>
            Notes
          </label>
          <input
            id={`notes-${itemId}`}
            type="text"
            value={notesInput}
            onChange={(event) => setNotesInput(event.target.value)}
            placeholder="optional"
            className={INPUT_CLASS}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded border border-[#E53935]/30 bg-[#E53935]/10 px-2 py-1.5">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-[#E53935]" />
            <p className="text-xs text-[#E53935]">{error}</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-3 py-1.5 text-xs font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
            disabled={busy}
            className="rounded-md border border-vault-border px-3 py-1.5 text-xs text-vault-text-muted transition-colors hover:text-vault-text disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (mode === "confirming") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-vault-text-muted">Remove {name}?</span>
        <button
          type="button"
          onClick={handleDelete}
          disabled={busy}
          className="text-[#E53935] hover:underline disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => setMode("idle")}
          disabled={busy}
          className="text-vault-text-muted hover:underline disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={startEditing}
        className="flex items-center gap-1 text-xs text-vault-text-muted transition-colors hover:text-[#00C2FF]"
      >
        <Pencil className="h-3 w-3" />
        Edit
      </button>
      <button
        type="button"
        onClick={() => {
          setMode("confirming");
          setError(null);
        }}
        className="flex items-center gap-1 text-xs text-vault-text-muted transition-colors hover:text-[#E53935]"
      >
        <Trash2 className="h-3 w-3" />
        Remove
      </button>
      {error && <span className="text-xs text-[#E53935]">{error}</span>}
    </div>
  );
}
