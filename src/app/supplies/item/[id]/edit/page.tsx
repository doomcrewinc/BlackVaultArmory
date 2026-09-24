"use client";

import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import {
  SUPPLY_CATEGORIES,
  SUPPLY_CATEGORY_LABELS,
  DEFAULT_SUPPLY_CATEGORY,
  SUPPLY_UNITS,
  SUPPLY_UNIT_LABELS,
  DEFAULT_SUPPLY_UNIT,
} from "@/lib/supply";
import { toISODate } from "@/lib/date";
import { ArrowLeft, Save, Loader2, AlertCircle } from "lucide-react";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

interface SupplyItem {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  quantity: number;
  unit: string;
  lowStockAlert: number | null;
  expirationDate: string | null;
  purchasePrice: number | null;
  purchaseDate: string | null;
  storageLocation: string | null;
  notes: string | null;
}

export default function EditSupplyPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const supplyId = Array.isArray(params.id) ? params.id[0] : params.id;
  const invalidRoute = !supplyId;

  const [supply, setSupply] = useState<SupplyItem | null>(null);
  const [dataLoading, setDataLoading] = useState(!invalidRoute);
  const [dataError, setDataError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!supplyId) return;

    fetch(`/api/supplies/${supplyId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setDataError(data.error);
        } else {
          setSupply(data);
        }
        setDataLoading(false);
      })
      .catch(() => {
        setDataError("Failed to load item");
        setDataLoading(false);
      });
  }, [supplyId]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    setLoading(true);

    const form = e.currentTarget;
    const data = new FormData(form);

    // quantity is sent as the raw FormData string — never Number()-parsed —
    // so the API's normalizeAmount can tell "left blank" (preserve the
    // stored value) apart from a real 0. lowStockAlert is nullable and can
    // be intentionally cleared, so a blank field is sent as explicit null
    // rather than a blank string, which the API would otherwise treat as
    // "leave it alone" and never actually clear.
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
      const res = await fetch(`/api/supplies/${supplyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? "Failed to update item");
        setLoading(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        router.push(`/supplies/item/${supplyId}`);
      }, 800);
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  }

  if (dataLoading) {
    return (
      <div className="flex items-center justify-center min-h-full">
        <Loader2 className="w-8 h-8 text-[#00C2FF] animate-spin" />
      </div>
    );
  }

  if (invalidRoute) {
    return (
      <div className="flex flex-col items-center justify-center min-h-full gap-4">
        <AlertCircle className="w-10 h-10 text-[#E53935]" />
        <p className="text-[#E53935]">Invalid supply route.</p>
        <Link href="/" className="text-sm text-[#00C2FF] hover:underline">
          Back to Command Center
        </Link>
      </div>
    );
  }

  if (dataError || !supply) {
    return (
      <div className="flex flex-col items-center justify-center min-h-full gap-4">
        <AlertCircle className="w-10 h-10 text-[#E53935]" />
        <p className="text-[#E53935]">{dataError ?? "Item not found"}</p>
        <Link href="/" className="text-sm text-[#00C2FF] hover:underline">
          Back to Command Center
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-vault-border flex-wrap">
        <Link
          href={`/supplies/item/${supplyId}`}
          className="flex items-center gap-1.5 text-vault-text-muted hover:text-vault-text text-sm transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to {supply.name}
        </Link>
        <span className="text-vault-border">/</span>
        <h1 className="text-sm font-semibold text-vault-text tracking-wide uppercase">
          Edit Supply
        </h1>
      </div>

      <div className="max-w-2xl mx-auto px-6 py-8">
        <div className="mb-8">
          <h2 className="text-xl font-bold text-vault-text mb-1">
            Edit {supply.name}
          </h2>
          <p className="text-sm text-vault-text-muted">
            Update the details for this item.
          </p>
        </div>

        {error && (
          <div className="flex items-center gap-3 bg-[#E53935]/10 border border-[#E53935]/30 rounded-lg px-4 py-3 mb-6">
            <AlertCircle className="w-4 h-4 text-[#E53935] shrink-0" />
            <p className="text-sm text-[#E53935]">{error}</p>
          </div>
        )}

        {success && (
          <div className="flex items-center gap-3 bg-[#00C853]/10 border border-[#00C853]/30 rounded-lg px-4 py-3 mb-6">
            <Save className="w-4 h-4 text-[#00C853] shrink-0" />
            <p className="text-sm text-[#00C853]">Saved! Redirecting...</p>
          </div>
        )}

        {/* This form only renders once `supply` is loaded (see the loading
            guards above), so every defaultValue below reads straight off the
            fetched record — there is no uninitialised-field window for a
            field to silently fall back to a form default and be overwritten
            on save. Every field from the API response is represented here. */}
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
                defaultValue={supply.name}
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
                  defaultValue={supply.brand ?? ""}
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
                  defaultValue={supply.category ?? DEFAULT_SUPPLY_CATEGORY}
                  className={INPUT_CLASS}
                >
                  {SUPPLY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {SUPPLY_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
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
                  defaultValue={supply.quantity}
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
                  defaultValue={supply.unit ?? DEFAULT_SUPPLY_UNIT}
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
                defaultValue={supply.lowStockAlert ?? ""}
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
                defaultValue={toISODate(supply.expirationDate)}
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
                  defaultValue={toISODate(supply.purchaseDate)}
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
                  defaultValue={supply.storageLocation ?? ""}
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
                  defaultValue={supply.purchasePrice ?? ""}
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
                defaultValue={supply.notes ?? ""}
                placeholder="Any additional notes about this item..."
                className={`${INPUT_CLASS} resize-none`}
              />
            </div>
          </fieldset>

          {/* Actions */}
          <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-3 pt-2">
            <Link
              href={`/supplies/item/${supplyId}`}
              className="w-full sm:w-auto text-center px-4 py-2 text-sm text-vault-text-muted hover:text-vault-text border border-vault-border rounded-md hover:border-vault-text-muted/30 transition-colors"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading || success}
              className="w-full sm:w-auto justify-center flex items-center gap-2 bg-[#00C2FF]/10 border border-[#00C2FF]/30 text-[#00C2FF] hover:bg-[#00C2FF]/20 disabled:opacity-50 disabled:cursor-not-allowed px-5 py-2 rounded-md text-sm font-medium transition-colors"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {loading ? "Saving..." : success ? "Saved!" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
