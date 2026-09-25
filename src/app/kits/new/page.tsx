"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Plus, Loader2, AlertCircle } from "lucide-react";
import {
  KIT_CATEGORIES,
  KIT_CATEGORY_LABELS,
  DEFAULT_KIT_CATEGORY,
} from "@/lib/kit";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

/**
 * Create a kit — the container only. Its contents are added line by line on
 * the detail page, through `/api/kits/[id]/items`, because a KitItem needs a
 * source picker (task 6) that this form has no business embedding.
 *
 * The category `<option>`s come from KIT_CATEGORIES, so the dropdown cannot
 * offer a value `normalizeKitCategory` would silently rewrite.
 *
 * No image field: `Kit.imageUrl` exists in the schema, but ImagePicker's
 * `entityType` union and the upload route's allowlist do not include "kit",
 * and widening an upload allowlist is not this task's change. A form control
 * that posted an imageUrl nothing could produce would be the "looks present,
 * does nothing" shape task 4 just spent a fix round closing.
 */
export default function NewKitPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(DEFAULT_KIT_CATEGORY);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const data = new FormData(e.currentTarget);

    const payload = {
      name: data.get("name") as string,
      category: data.get("category") as string,
      location: (data.get("location") as string) || null,
      notes: (data.get("notes") as string) || null,
    };

    try {
      const res = await fetch("/api/kits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Failed to create kit");
        setLoading(false);
        return;
      }

      router.push(`/kits/${json.id}`);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full">
      <div className="flex flex-wrap items-center gap-2 border-b border-vault-border px-4 py-4 sm:gap-4 sm:px-6">
        <Link
          href="/kits"
          className="flex items-center gap-1.5 text-sm text-vault-text-muted transition-colors hover:text-vault-text"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Kits
        </Link>
        <span className="text-vault-border">/</span>
        <h1 className="text-sm font-semibold uppercase tracking-wide text-vault-text">
          Add Kit
        </h1>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-8">
          <h2 className="mb-1 text-xl font-bold text-vault-text">
            New Kit
          </h2>
          <p className="text-sm text-vault-text-muted">
            A packing list — a bugout bag, a range bag, a vehicle kit. Add its
            contents once it exists.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 px-4 py-3">
            <AlertCircle className="h-4 w-4 shrink-0 text-[#E53935]" />
            <p className="text-sm text-[#E53935]">{error}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <fieldset className="space-y-4 rounded-lg border border-vault-border bg-vault-surface p-5">
            <legend className="-ml-1 px-1 font-mono text-xs uppercase tracking-widest text-[#00C2FF]">
              Identity
            </legend>

            <div>
              <label htmlFor="name" className={LABEL_CLASS}>
                Kit Name <span className="text-[#E53935]">*</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                placeholder="e.g. Truck Bugout Bag"
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="category" className={LABEL_CLASS}>
                Category
              </label>
              <select
                id="category"
                name="category"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className={INPUT_CLASS}
              >
                {KIT_CATEGORIES.map((value) => (
                  <option key={value} value={value}>
                    {KIT_CATEGORY_LABELS[value]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="location" className={LABEL_CLASS}>
                Location
              </label>
              <input
                id="location"
                name="location"
                type="text"
                placeholder="e.g. Truck, behind the seat"
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-[11px] text-vault-text-faint">
                Where the bag itself lives.
              </p>
            </div>
          </fieldset>

          <fieldset className="space-y-4 rounded-lg border border-vault-border bg-vault-surface p-5">
            <legend className="-ml-1 px-1 font-mono text-xs uppercase tracking-widest text-[#00C2FF]">
              Notes
            </legend>
            <div>
              <label htmlFor="notes" className={LABEL_CLASS}>
                Notes
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={3}
                placeholder="Anything worth remembering about this kit..."
                className={`${INPUT_CLASS} resize-none`}
              />
            </div>
          </fieldset>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center sm:justify-end">
            <Link
              href="/kits"
              className="w-full rounded-md border border-vault-border px-4 py-2 text-center text-sm text-vault-text-muted transition-colors hover:border-vault-text-muted/30 hover:text-vault-text sm:w-auto"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-5 py-2 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              {loading ? "Adding..." : "Add Kit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
