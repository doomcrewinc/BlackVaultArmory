"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_GEAR_CATEGORY, isArmorCategory } from "@/lib/gear";
import ImagePicker from "@/components/shared/ImagePicker";
import { LoadingState } from "@/components/shared/LoadingState";
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

function NewGearForm() {
  const router = useRouter();
  const form = useAddFormContext("gear");
  const { context, noun } = form;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(
    context?.allowedValues[0] ?? DEFAULT_GEAR_CATEGORY,
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const form = e.currentTarget;
    const data = new FormData(form);

    // A truthy check, not Number.isFinite: Number("") is 0, which is finite
    // and >= 0, so an empty field would otherwise be stored as a real $0
    // instead of null and render "$0" instead of "—".
    const payload = {
      name: data.get("name") as string,
      category: data.get("category") as string,
      manufacturer: (data.get("manufacturer") as string) || null,
      model: (data.get("model") as string) || null,
      serialNumber: (data.get("serialNumber") as string) || null,
      quantity: data.get("quantity") as string,
      purchasePrice: data.get("purchasePrice")
        ? Number(data.get("purchasePrice"))
        : null,
      currentValue: data.get("currentValue")
        ? Number(data.get("currentValue"))
        : null,
      acquisitionDate: (data.get("acquisitionDate") as string) || null,
      expirationDate: (data.get("expirationDate") as string) || null,
      protectionLevel: (data.get("protectionLevel") as string) || null,
      armorSize: (data.get("armorSize") as string) || null,
      storageLocation: (data.get("storageLocation") as string) || null,
      notes: (data.get("notes") as string) || null,
      imageUrl: imageUrl || null,
      imageSource: imageUrl ? "uploaded" : null,
    };

    try {
      const res = await fetch("/api/gear", {
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

      router.push(context?.returnHref ?? `/gear/item/${json.id}`);
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
                {form.nameLabel}{" "}
                <span className="text-[#E53935]">*</span>
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                placeholder="e.g. Benchmade Bugout"
                className={INPUT_CLASS}
              />
            </div>

            <TypeSelectField
              form={form}
              value={category}
              onChange={setCategory}
            />

            {isArmorCategory(category) && (
              <fieldset className="rounded-lg border border-vault-border p-4">
                <legend className="px-2 text-sm font-medium text-vault-text">
                  Armor
                </legend>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="protectionLevel" className={LABEL_CLASS}>
                      Protection Level
                    </label>
                    <input
                      type="text"
                      id="protectionLevel"
                      name="protectionLevel"
                      placeholder="IIIA, III, IV"
                      className={INPUT_CLASS}
                    />
                  </div>
                  <div>
                    <label htmlFor="armorSize" className={LABEL_CLASS}>
                      Size / Cut
                    </label>
                    <input
                      type="text"
                      id="armorSize"
                      name="armorSize"
                      placeholder="M SAPI, Swimmer, 10x12"
                      className={INPUT_CLASS}
                    />
                  </div>
                </div>
                <p className="mt-2 text-xs text-vault-text-muted">
                  Free text — NIJ ratings and plate cuts vary by maker.
                </p>
              </fieldset>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="manufacturer" className={LABEL_CLASS}>
                  Manufacturer
                </label>
                <input
                  id="manufacturer"
                  name="manufacturer"
                  type="text"
                  placeholder="e.g. Benchmade"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label htmlFor="model" className={LABEL_CLASS}>
                  Model
                </label>
                <input
                  id="model"
                  name="model"
                  type="text"
                  placeholder="e.g. 535 Bugout"
                  className={INPUT_CLASS}
                />
              </div>
            </div>

            <div>
              <label htmlFor="serialNumber" className={LABEL_CLASS}>
                Serial Number
              </label>
              <input
                id="serialNumber"
                name="serialNumber"
                type="text"
                placeholder="e.g. SN-12345 (optional)"
                className={`${INPUT_CLASS} font-mono`}
              />
            </div>

            <div>
              <label htmlFor="quantity" className={LABEL_CLASS}>
                Quantity
              </label>
              <input
                id="quantity"
                name="quantity"
                type="number"
                min={1}
                step={1}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-[11px] text-vault-text-faint">
                How many identical items this record stands for.
              </p>
            </div>
          </fieldset>

          {/* Acquisition */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Acquisition
            </legend>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="acquisitionDate" className={LABEL_CLASS}>
                  Date Acquired
                </label>
                <input
                  id="acquisitionDate"
                  name="acquisitionDate"
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
                  placeholder="e.g. Safe, drawer 2"
                  className={INPUT_CLASS}
                />
              </div>
            </div>

            <div>
              <label htmlFor="expirationDate" className={LABEL_CLASS}>
                Expiration Date
              </label>
              <input
                type="date"
                id="expirationDate"
                name="expirationDate"
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-xs text-vault-text-muted">
                Optional. Plates, filters and medical kits have a rated life.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <div>
                <label htmlFor="currentValue" className={LABEL_CLASS}>
                  Current Value
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-vault-text-faint text-sm">
                    $
                  </span>
                  <input
                    id="currentValue"
                    name="currentValue"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    className={`${INPUT_CLASS} pl-7`}
                  />
                </div>
              </div>
            </div>
          </fieldset>

          {/* Image */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Image
            </legend>
            <ImagePicker
              entityType="gear"
              value={imageUrl}
              onChange={setImageUrl}
            />
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
export default function NewGearPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <NewGearForm />
    </Suspense>
  );
}
