"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  Loader2,
  Package,
  Plus,
  Search,
  X,
} from "lucide-react";
import { KIT_ITEM_UNTRACKED_LABEL, type KitItemSourceField } from "@/lib/kit";
import {
  resolveKitItemSource,
  type KitItemSourceReason,
} from "@/lib/kits/kitItemSource";
import type { KitSourceGroup } from "@/lib/kits/sourceDisplay";

const INPUT_CLASS =
  "w-full rounded-md border border-vault-border bg-vault-bg px-3 py-2 text-sm text-vault-text placeholder-vault-text-faint transition-colors focus:border-[#00C2FF] focus:outline-none";
const LABEL_CLASS =
  "mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-vault-text-muted";

/**
 * Adds one line to a kit: a picker over existing inventory, with a free-text
 * fallback for something the app does not track.
 *
 * THE SOURCE RULE IS NOT RE-IMPLEMENTED HERE. "Exactly one foreign key, or
 * none plus a label" has one authority, `resolveKitItemSource`, and the API
 * enforces it on every write. This component IMPORTS that same pure function
 * to decide whether "Add line" is enabled — the module's own contract says
 * the picker "uses `ok` to disable an invalid state before the user can
 * submit it" — and then still POSTs and surfaces the server's 400 verdict
 * rather than trusting its own check. One rule, one implementation, consulted
 * twice; never a second copy that can drift out of agreement.
 *
 * MUTUAL EXCLUSION IS STRUCTURAL, not validated. The server rejects a line
 * that carries both a foreign key and a label, so this form makes that body
 * UNBUILDABLE rather than checking for it:
 *
 *   - Only one mode is active at a time, and the request carries exactly one
 *     key: `{ [field]: id }` in inventory mode, `{ label }` in the other.
 *     There is no code path that spreads both.
 *   - Choosing an inventory result clears `label`.
 *   - Switching to "Not in inventory" clears the selected id, the query and
 *     the results.
 *
 * QUANTITY. `quantity` is sent as the raw input STRING, not `Number(value)`:
 * `Number("")` and `Number(" ")` are both `0`, and the create route's
 * `normalizeAmount(quantity, 1) ?? 1` is what turns a blank into the schema
 * default. `targetQuantity` blank is sent as `null` — "no target", which is
 * exactly what a nullable column should store for an untouched field.
 */

/**
 * The server's `reason` codes, said in English. This TRANSLATES a verdict the
 * server reached; it does not reach one. Every branch stays reachable even
 * though the form tries to prevent all three, because the API is the
 * authority and a future body shape could still earn one of them.
 */
const REASON_TEXT: Record<KitItemSourceReason, string> = {
  "multiple-sources":
    "That line points at more than one item. Pick a single one.",
  "source-and-label":
    "A line is either an inventory item or a plain label — not both.",
  "no-source":
    "Pick an item, or name something you don't track in inventory.",
};

type Mode = "inventory" | "label";

interface Selection {
  field: KitItemSourceField;
  id: string;
  name: string;
}

export function AddKitItem({ kitId }: { kitId: string }) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("inventory");

  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<KitSourceGroup[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Selection | null>(null);
  const [label, setLabel] = useState("");

  const [quantity, setQuantity] = useState("1");
  const [target, setTarget] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the pending timer on unmount, so a debounced search cannot fire a
  // setState after this component has gone.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const search = useCallback((value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearchError(null);
    if (value.trim().length < 2) {
      setGroups([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/kits/item-sources?q=${encodeURIComponent(value.trim())}`,
        );
        if (!res.ok) {
          setSearchError("Search failed. Try again.");
          setGroups([]);
          return;
        }
        const json = await res.json();
        setGroups(json.groups ?? []);
      } catch {
        setSearchError("Network error while searching.");
        setGroups([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  }, []);

  function chooseInventoryMode() {
    setMode("inventory");
    // Selecting an item and typing a label are mutually exclusive, so
    // entering this mode drops any label already typed.
    setLabel("");
    setError(null);
  }

  function chooseLabelMode() {
    setMode("label");
    // ...and entering the other mode drops the selected id, the query and
    // the results it came from.
    setSelected(null);
    setQuery("");
    setGroups([]);
    setSearchError(null);
    setError(null);
  }

  function selectResult(
    field: KitItemSourceField,
    id: string,
    name: string,
  ) {
    setSelected({ field, id, name });
    // Belt and braces: the only way to have typed a label is to have been in
    // the other mode, which already cleared this.
    setLabel("");
    setError(null);
  }

  function resetLine() {
    setSelected(null);
    setLabel("");
    setQuery("");
    setGroups([]);
    setQuantity("1");
    setTarget("");
    setNotes("");
  }

  /**
   * Exactly one key, chosen by mode — the body the request will carry, and
   * the input the shared rule is asked about. There is no branch that puts a
   * foreign key and a label in the same object.
   */
  const sourceBody: Record<string, string> =
    mode === "inventory"
      ? selected
        ? { [selected.field]: selected.id }
        : {}
      : { label };

  const resolved = resolveKitItemSource(sourceBody);
  const canSubmit = resolved.ok && !submitting;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setAdded(null);
    setSubmitting(true);

    try {
      const res = await fetch(`/api/kits/${kitId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...sourceBody,
          // The raw string. See the note above on Number("").
          quantity,
          targetQuantity: target.trim() === "" ? null : target,
          notes: notes.trim() === "" ? null : notes,
        }),
      });

      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        // The SERVER's verdict, said in English — not a second opinion.
        setError(
          REASON_TEXT[json.error as KitItemSourceReason] ??
            json.error ??
            "Failed to add the line.",
        );
        setSubmitting(false);
        return;
      }

      setAdded(
        mode === "inventory" ? (selected?.name ?? "Line") : label.trim(),
      );
      resetLine();
      setSubmitting(false);
      // The contents list is server-rendered, so a refresh is what shows the
      // new line — and it comes back with its allocation and expiry verdicts
      // resolved server-side, which is the only place they may be decided.
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-[#00C2FF]/30 bg-[#00C2FF]/5 px-4 py-3 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/10 sm:w-auto"
      >
        <Plus className="h-4 w-4" />
        Add a line
      </button>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-lg border border-vault-border bg-vault-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-vault-text-muted">
          Add a line
        </h3>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            resetLine();
            setError(null);
            setAdded(null);
          }}
          className="flex items-center gap-1 text-xs text-vault-text-muted transition-colors hover:text-vault-text"
        >
          <X className="h-3.5 w-3.5" />
          Close
        </button>
      </div>

      {/* The two modes. Radio-shaped on purpose: one is always active, and
          activating either clears the other's state. */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={chooseInventoryMode}
          aria-pressed={mode === "inventory"}
          className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
            mode === "inventory"
              ? "border-[#00C2FF]/40 bg-[#00C2FF]/10 text-[#00C2FF]"
              : "border-vault-border text-vault-text-muted hover:text-vault-text"
          }`}
        >
          From inventory
        </button>
        <button
          type="button"
          onClick={chooseLabelMode}
          aria-pressed={mode === "label"}
          className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
            mode === "label"
              ? "border-[#00C2FF]/40 bg-[#00C2FF]/10 text-[#00C2FF]"
              : "border-vault-border text-vault-text-muted hover:text-vault-text"
          }`}
        >
          Not in inventory
        </button>
      </div>

      {mode === "inventory" ? (
        selected ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/5 px-3 py-2">
            <Check className="h-3.5 w-3.5 shrink-0 text-[#00C2FF]" />
            {/* The name truncates in an element of its own; the control is a
                shrink-0 sibling outside it. */}
            <span className="min-w-0 truncate text-sm text-vault-text">
              {selected.name}
            </span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="shrink-0 text-xs text-vault-text-muted hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div>
            <label htmlFor="kit-item-search" className={LABEL_CLASS}>
              Search inventory
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-vault-text-faint" />
              <input
                id="kit-item-search"
                type="text"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  search(event.target.value);
                }}
                placeholder="Gear, supplies, accessories, ammo, firearms…"
                className={`${INPUT_CLASS} pl-9`}
              />
            </div>

            {searchError && (
              <p className="mt-2 text-xs text-[#E53935]">{searchError}</p>
            )}

            {searching && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-vault-text-faint">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching…
              </p>
            )}

            {!searching && query.trim().length < 2 && (
              <p className="mt-2 text-xs text-vault-text-faint">
                Type at least two characters.
              </p>
            )}

            {!searching && query.trim().length >= 2 && groups.length === 0 && (
              <p className="mt-2 text-xs text-vault-text-faint">
                Nothing matches. Use{" "}
                <span className="text-vault-text-muted">Not in inventory</span>{" "}
                for something you don&apos;t track.
              </p>
            )}

            {groups.length > 0 && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-vault-border">
                {groups.map((group) => (
                  <div key={group.field}>
                    <p className="sticky top-0 border-b border-vault-border bg-vault-bg px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-vault-text-faint">
                      {group.label}
                    </p>
                    <ul className="divide-y divide-vault-border">
                      {group.results.map((result) => (
                        <li key={`${result.field}:${result.id}`}>
                          <button
                            type="button"
                            onClick={() =>
                              selectResult(
                                result.field,
                                result.id,
                                result.name,
                              )
                            }
                            className="block w-full px-3 py-2 text-left transition-colors hover:bg-[#00C2FF]/5"
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="min-w-0 truncate text-sm text-vault-text">
                                {result.name}
                              </span>
                              {result.expiry === "expired" && (
                                <span className="shrink-0 rounded border border-[#E53935]/20 bg-[#E53935]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#E53935]">
                                  Expired
                                </span>
                              )}
                              {result.expiry === "soon" && (
                                <span className="shrink-0 rounded border border-[#F5A623]/20 bg-[#F5A623]/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-[#F5A623]">
                                  Soon
                                </span>
                              )}
                            </span>
                            <span className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-vault-text-faint">
                              {result.detail && (
                                <span className="min-w-0 truncate">
                                  {result.detail}
                                </span>
                              )}
                              {result.owned !== null && (
                                <span className="shrink-0">
                                  {result.owned} owned
                                  {result.unit ? ` ${result.unit}` : ""}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      ) : (
        <div>
          <label htmlFor="kit-item-label" className={LABEL_CLASS}>
            {KIT_ITEM_UNTRACKED_LABEL} — name it
          </label>
          <div className="relative">
            <Package className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-vault-text-faint" />
            <input
              id="kit-item-label"
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="e.g. Spare truck key"
              className={`${INPUT_CLASS} pl-9`}
            />
          </div>
          <p className="mt-1 text-[11px] text-vault-text-faint">
            A plain label, for something that isn&apos;t in your inventory.
            Nothing is allocated against it.
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="kit-item-quantity" className={LABEL_CLASS}>
            Quantity
          </label>
          <input
            id="kit-item-quantity"
            type="number"
            min={0}
            step="any"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label htmlFor="kit-item-target" className={LABEL_CLASS}>
            Target
          </label>
          <input
            id="kit-item-target"
            type="number"
            min={0}
            step="any"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="optional"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      <div>
        <label htmlFor="kit-item-notes" className={LABEL_CLASS}>
          Notes
        </label>
        <input
          id="kit-item-notes"
          type="text"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="optional"
          className={INPUT_CLASS}
        />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-[#E53935]/30 bg-[#E53935]/10 px-3 py-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#E53935]" />
          <p className="text-xs text-[#E53935]">{error}</p>
        </div>
      )}

      {added && !error && (
        <p className="flex items-center gap-1.5 text-xs text-[#00C853]">
          <Check className="h-3.5 w-3.5 shrink-0" />
          Added {added}.
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-4 py-2 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          {submitting ? "Adding…" : "Add line"}
        </button>
      </div>
    </form>
  );
}
