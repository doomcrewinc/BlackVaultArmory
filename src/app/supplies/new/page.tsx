"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_SUPPLY_CATEGORY,
  SUPPLY_UNITS,
  SUPPLY_UNIT_LABELS,
  DEFAULT_SUPPLY_UNIT,
} from "@/lib/supply";
import { useAddFormContext } from "@/components/shared/useAddFormContext";
import { TypeSelectField } from "@/components/shared/TypeSelectField";
import { AddFormActions } from "@/components/shared/AddFormActions";
import {
  AddFormBreadcrumb,
  AddFormIntro,
} from "@/components/shared/AddFormHeader";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

function NewSupplyForm() {
  const router = useRouter();
  const form = useAddFormContext("supply");
  const { context, noun } = form;
  const [category, setCategory] = useState<string>(
    context?.allowedValues[0] ?? DEFAULT_SUPPLY_CATEGORY,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = e.currentTarget;
    const data = new FormData(form);

    // quantity and lowStockAlert are sent as the raw FormData string (never
    // Number()-parsed here) so the API's normalizeAmount does the trimming
    // and blank-check itself — Number("") is 0, and parsing client-side would
    // silently store a real 0 instead of letting the API fall back correctly.
    // purchasePrice has no such fallback in the API, so a blank value must be
    // sent as null explicitly rather than a parsed 0.
    const payload = {
      name: data.get("name") as string,
      brand: (data.get("brand") as string) || null,
      category: data.get("category") as string,
      quantity: data.get("quantity") as string,
      unit: data.get("unit") as string,
      lowStockAlert: (data.get("lowStockAlert") as string)?.trim()
        ? (data.get("lowStockAlert") as string)
        : null,
      expirationDate: (data.get("expirationDate") as string) || null,
      purchasePrice: data.get("purchasePrice")
        ? Number(data.get("purchasePrice"))
        : null,
      purchaseDate: (data.get("purchaseDate") as string) || null,
      storageLocation: (data.get("storageLocation") as string) || null,
      notes: (data.get("notes") as string) || null,
    };

    try {
      const res = await fetch("/api/supplies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? `Failed to create ${noun}`);
        setLoading(false);
        return;
      }

      router.push(context?.returnHref ?? `/supplies/item/${json.id}`);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-full">
      <AddFormBreadcrumb form={form} />

      <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <AddFormIntro form={form} error={error} />

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Identity */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Identity
            </legend>

            <div>
              <label htmlFor="name" className={LABEL_CLASS}>
                Item Name <span className="text-[#E53935]">*</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                placeholder="e.g. Hoppe's No. 9"
                className={INPUT_CLASS}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="brand" className={LABEL_CLASS}>
                  Brand
                </label>
                <input
                  id="brand"
                  name="brand"
                  type="text"
                  placeholder="e.g. Hoppe's"
                  className={INPUT_CLASS}
                />
              </div>
              <TypeSelectField
                form={form}
                value={category}
                onChange={setCategory}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="quantity" className={LABEL_CLASS}>
                  Quantity
                </label>
                <input
                  id="quantity"
                  name="quantity"
                  type="number"
                  min="0"
                  step="any"
                  placeholder="0"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="unit" className={LABEL_CLASS}>
                  Unit
                </label>
                <select
                  id="unit"
                  name="unit"
                  defaultValue={DEFAULT_SUPPLY_UNIT}
                  className={INPUT_CLASS}
                >
                  {SUPPLY_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {SUPPLY_UNIT_LABELS[u]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="lowStockAlert" className={LABEL_CLASS}>
                Low Stock Threshold
              </label>
              <input
                id="lowStockAlert"
                name="lowStockAlert"
                type="number"
                min="0"
                step="any"
                placeholder="Leave blank for no alert"
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-[11px] text-vault-text-faint">
                Flagged as low stock at or below this quantity.
              </p>
            </div>

            <div>
              <label htmlFor="expirationDate" className={LABEL_CLASS}>
                Expiration Date
              </label>
              <input
                id="expirationDate"
                name="expirationDate"
                type="date"
                className={INPUT_CLASS}
              />
            </div>
          </fieldset>

          {/* Acquisition */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Acquisition
            </legend>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="purchaseDate" className={LABEL_CLASS}>
                  Purchase Date
                </label>
                <input
                  id="purchaseDate"
                  name="purchaseDate"
                  type="date"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="storageLocation" className={LABEL_CLASS}>
                  Storage Location
                </label>
                <input
                  id="storageLocation"
                  name="storageLocation"
                  type="text"
                  placeholder="e.g. Pantry shelf 2"
                  className={INPUT_CLASS}
                />
              </div>
            </div>

            <div>
              <label htmlFor="purchasePrice" className={LABEL_CLASS}>
                Purchase Price
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-vault-text-faint text-sm">
                  $
                </span>
                <input
                  id="purchasePrice"
                  name="purchasePrice"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  className={`${INPUT_CLASS} pl-7`}
                />
              </div>
            </div>
          </fieldset>

          {/* Notes */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
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
                placeholder="Any additional notes about this item..."
                className={`${INPUT_CLASS} resize-none`}
              />
            </div>
          </fieldset>

          <AddFormActions form={form} loading={loading} />
        </form>
      </div>
    </div>
  );
}

/**
 * `useSearchParams` needs a Suspense boundary so the page can still be
 * prerendered; the form reads `?section=` from the address.
 */
export default function NewSupplyPage() {
  return (
    <Suspense>
      <NewSupplyForm />
    </Suspense>
  );
}
