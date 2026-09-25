"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, Save } from "lucide-react";
import ImagePicker from "@/components/shared/ImagePicker";
import {
  KIT_CATEGORIES,
  KIT_CATEGORY_LABELS,
  DEFAULT_KIT_CATEGORY,
} from "@/lib/kit";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

interface Kit {
  id: string;
  name: string;
  category: string;
  location: string | null;
  notes: string | null;
  imageUrl: string | null;
}

/**
 * Edit a kit — the container's own fields. `PUT /api/kits/[id]` has existed
 * since task 3 with no caller, which meant a kit could be created and never
 * renamed; this is that caller.
 *
 * Follows `/gear/item/[id]/edit` deliberately: fetch on mount, controlled
 * `select` and image state, uncontrolled `defaultValue` text fields read back
 * through FormData, inline load/save/error states, and an 800ms success beat
 * before returning to the detail page.
 *
 * NOT edited here: the kit's CONTENTS. A line's quantity, target and notes
 * are edited in place on the detail page, where the line and its allocation
 * warning are visible; adding one needs the inventory picker. This form owns
 * the bag, not what is in it.
 *
 * CATEGORY comes from KIT_CATEGORIES, so the dropdown cannot offer a value
 * `normalizeKitCategory` would silently rewrite to BUGOUT on save.
 *
 * The IMAGE control is real now: `entityType="kit"` is in ImagePicker's union
 * and in the upload route's allowlist, the route stores `imageUrl`, and the
 * detail page renders it. Before this task all three were missing, which is
 * why `/kits/new` still deliberately has no image field — there is nothing
 * wrong with adding one, but a create form has no id yet and the temp-id path
 * is a separate decision from making the column live.
 */
export default function EditKitPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const kitId = Array.isArray(params.id) ? params.id[0] : params.id;
  const invalidRoute = !kitId;

  const [kit, setKit] = useState<Kit | null>(null);
  const [dataLoading, setDataLoading] = useState(!invalidRoute);
  const [dataError, setDataError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [category, setCategory] = useState<string>(DEFAULT_KIT_CATEGORY);
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!kitId) return;

    fetch(`/api/kits/${kitId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setDataError(data.error);
        } else {
          setKit(data);
          setCategory(data.category ?? DEFAULT_KIT_CATEGORY);
          setImageUrl(data.imageUrl ?? null);
        }
        setDataLoading(false);
      })
      .catch(() => {
        setDataError("Failed to load kit");
        setDataLoading(false);
      });
  }, [kitId]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    const data = new FormData(event.currentTarget);

    const payload = {
      name: data.get("name") as string,
      category: data.get("category") as string,
      location: (data.get("location") as string) || null,
      notes: (data.get("notes") as string) || null,
      imageUrl: imageUrl || null,
    };

    try {
      const res = await fetch(`/api/kits/${kitId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Failed to update kit");
        setLoading(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        router.push(`/kits/${kitId}`);
      }, 800);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  if (dataLoading) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#00C2FF]" />
      </div>
    );
  }

  if (invalidRoute) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4">
        <AlertCircle className="h-10 w-10 text-[#E53935]" />
        <p className="text-[#E53935]">Invalid kit route.</p>
        <Link href="/kits" className="text-sm text-[#00C2FF] hover:underline">
          Back to Kits
        </Link>
      </div>
    );
  }

  if (dataError || !kit) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-4">
        <AlertCircle className="h-10 w-10 text-[#E53935]" />
        <p className="text-[#E53935]">{dataError ?? "Kit not found"}</p>
        <Link href="/kits" className="text-sm text-[#00C2FF] hover:underline">
          Back to Kits
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <div className="flex flex-wrap items-center gap-2 border-b border-vault-border px-4 py-4 sm:gap-4 sm:px-6">
        <Link
          href={`/kits/${kitId}`}
          className="flex items-center gap-1.5 text-sm text-vault-text-muted transition-colors hover:text-vault-text"
        >
          <ArrowLeft className="h-4 w-4" />
          {/* The name truncates in an element of its own. */}
          <span className="min-w-0 truncate">Back to {kit.name}</span>
        </Link>
        <span className="text-vault-border">/</span>
        <h1 className="text-sm font-semibold uppercase tracking-wide text-vault-text">
          Edit Kit
        </h1>
      </div>

      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-8">
          <h2 className="mb-1 break-words text-xl font-bold text-vault-text">
            Edit {kit.name}
          </h2>
          <p className="text-sm text-vault-text-muted">
            The bag itself. Its contents are edited on the kit page.
          </p>
        </div>

        {error && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-[#E53935]/30 bg-[#E53935]/10 px-4 py-3">
            <AlertCircle className="h-4 w-4 shrink-0 text-[#E53935]" />
            <p className="text-sm text-[#E53935]">{error}</p>
          </div>
        )}

        {success && (
          <div className="mb-6 flex items-center gap-3 rounded-lg border border-[#00C853]/30 bg-[#00C853]/10 px-4 py-3">
            <Save className="h-4 w-4 shrink-0 text-[#00C853]" />
            <p className="text-sm text-[#00C853]">Saved! Redirecting...</p>
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
                defaultValue={kit.name}
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
                defaultValue={kit.location ?? ""}
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
              Image
            </legend>
            <ImagePicker
              entityType="kit"
              entityId={kit.id}
              value={imageUrl}
              onChange={setImageUrl}
            />
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
                defaultValue={kit.notes ?? ""}
                placeholder="Anything worth remembering about this kit..."
                className={`${INPUT_CLASS} resize-none`}
              />
            </div>
          </fieldset>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:items-center sm:justify-end">
            <Link
              href={`/kits/${kitId}`}
              className="w-full rounded-md border border-vault-border px-4 py-2 text-center text-sm text-vault-text-muted transition-colors hover:border-vault-text-muted/30 hover:text-vault-text sm:w-auto"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading || success}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-[#00C2FF]/30 bg-[#00C2FF]/10 px-5 py-2 text-sm font-medium text-[#00C2FF] transition-colors hover:bg-[#00C2FF]/20 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {loading ? "Saving..." : success ? "Saved!" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
