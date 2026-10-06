"use client";

import { Suspense, useState } from "react";
import { useRouter } from "next/navigation";
import { COMMON_CALIBERS } from "@/lib/types";
import { LoadingState } from "@/components/shared/LoadingState";
import { useAddFormContext } from "@/components/shared/useAddFormContext";
import { TypeSelectField } from "@/components/shared/TypeSelectField";
import { AddFormActions } from "@/components/shared/AddFormActions";
import {
  AddFormBreadcrumb,
  AddFormIntro,
} from "@/components/shared/AddFormHeader";
import { parseOptionalNumber } from "@/lib/forms";
import {
  EMPTY_FULL_AUTO_RATED_VALUE,
  FullAutoRatedSelect,
  fullAutoRatedError,
  fullAutoRatedPayload,
  toFullAutoRatedValue,
  type FullAutoRatedValue,
} from "@/components/shared/FullAutoRatedSelect";
import { isSuppressorType } from "@/lib/full-auto-rated";
import ImagePicker from "@/components/shared/ImagePicker";
import { HelpTip } from "@/components/shared/HelpTip";
import {
  NfaFieldset,
  EMPTY_NFA_FIELDSET_VALUE,
  type NfaFieldsetValue,
  type NfaFieldsetField,
} from "@/components/shared/NfaFieldset";

const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

function NewAccessoryForm() {
  const router = useRouter();
  const form = useAddFormContext("accessory");
  const { context, noun } = form;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [caliberInput, setCaliberInput] = useState("");
  const [caliberDropdownOpen, setCaliberDropdownOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [type, setType] = useState(context?.allowedValues[0] ?? "");
  const [nfaPaperwork, setNfaPaperwork] = useState<NfaFieldsetValue>(
    EMPTY_NFA_FIELDSET_VALUE,
  );

  const [fullAutoRated, setFullAutoRated] = useState<FullAutoRatedValue>(
    EMPTY_FULL_AUTO_RATED_VALUE,
  );

  function handleNfaFieldChange(field: NfaFieldsetField, value: string) {
    setNfaPaperwork((prev) => ({ ...prev, [field]: value }));
  }

  const filteredCalibers = COMMON_CALIBERS.filter((c) =>
    c.toLowerCase().includes(caliberInput.toLowerCase()),
  );

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fullAutoError = isSuppressorType(type)
      ? fullAutoRatedError(fullAutoRated)
      : null;
    if (fullAutoError) {
      setError(fullAutoError);
      return;
    }

    setLoading(true);

    const form = e.currentTarget;
    const data = new FormData(form);

    const parsedReplacementInterval = Number(
      data.get("replacementIntervalDays"),
    );
    const payload = {
      name: data.get("name") as string,
      manufacturer: data.get("manufacturer") as string,
      model: (data.get("model") as string) || null,
      serialNumber: (data.get("serialNumber") as string) || null,
      type: data.get("type") as string,
      caliber: caliberInput || null,
      quantity: data.get("quantity") as string,
      nfaTransferMethod: nfaPaperwork.nfaTransferMethod || null,
      nfaControlNumber: nfaPaperwork.nfaControlNumber || null,
      nfaApprovalDate: nfaPaperwork.nfaApprovalDate || null,
      nfaTaxPaid: nfaPaperwork.nfaTaxPaid || null,
      nfaRegisteredTo: nfaPaperwork.nfaRegisteredTo || null,
      ...(isSuppressorType(type) && fullAutoRatedPayload(fullAutoRated)),
      acquisitionDate: (data.get("acquisitionDate") as string) || null,
      purchasePrice: parseOptionalNumber(data.get("purchasePrice")),
      notes: (data.get("notes") as string) || null,
      imageUrl: imageUrl || null,
      imageSource: imageUrl ? "uploaded" : null,
      hasBattery: data.get("hasBattery") === "on",
      batteryType: (data.get("batteryType") as string) || null,
      lastBatteryChangeDate:
        (data.get("lastBatteryChangeDate") as string) || null,
      replacementIntervalDays:
        Number.isFinite(parsedReplacementInterval) &&
        parsedReplacementInterval > 0
          ? parsedReplacementInterval
          : null,
      initialRoundCount: data.get("initialRoundCount")
        ? Number(data.get("initialRoundCount"))
        : null,
    };

    try {
      const res = await fetch("/api/accessories", {
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

      router.push(context?.returnHref ?? `/accessories/${json.id}`);
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
                placeholder="e.g. Trijicon ACOG 4x32"
                className={INPUT_CLASS}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="manufacturer" className={LABEL_CLASS}>
                  Manufacturer
                </label>
                <input
                  id="manufacturer"
                  name="manufacturer"
                  type="text"
                  placeholder="e.g. Trijicon"
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
                  placeholder="e.g. TA31RCO-M150CP"
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <TypeSelectField form={form} value={type} onChange={setType} />

              {/* Caliber (optional) */}
              <div>
                <label className={LABEL_CLASS}>
                  Caliber
                  <HelpTip text="Calibers this accessory works with. Used to filter compatible accessories when building a loadout." />
                </label>
                <div className="relative">
                  <input
                    type="text"
                    value={caliberInput}
                    onChange={(e) => {
                      setCaliberInput(e.target.value);
                      setCaliberDropdownOpen(true);
                    }}
                    onFocus={() => setCaliberDropdownOpen(true)}
                    onBlur={() => setCaliberDropdownOpen(false)}
                    placeholder="e.g. 5.56x45mm"
                    className={INPUT_CLASS}
                  />
                  {caliberDropdownOpen &&
                    filteredCalibers.length > 0 &&
                    caliberInput && (
                      <div className="absolute z-10 top-full left-0 right-0 mt-1 bg-vault-surface border border-vault-border rounded-md shadow-lg max-h-48 overflow-y-auto">
                        {filteredCalibers.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onPointerDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setCaliberInput(c);
                              setCaliberDropdownOpen(false);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-vault-text hover:bg-vault-border hover:text-[#00C2FF] transition-colors font-mono"
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              </div>
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

            {isSuppressorType(type) && (
              <>
                <FullAutoRatedSelect
                  value={fullAutoRated}
                  onChange={setFullAutoRated}
                />
                <NfaFieldset
                  variant="suppressor"
                  value={nfaPaperwork}
                  onChange={handleNfaFieldChange}
                />
              </>
            )}
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
            </div>
          </fieldset>

          {/* Prior Use */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Prior Use
            </legend>
            <div>
              <label htmlFor="initialRoundCount" className={LABEL_CLASS}>
                Existing Round Count
                <HelpTip text="If this accessory has already been used, enter the approximate round count. This will be set as the starting round count." />
              </label>
              <input
                id="initialRoundCount"
                name="initialRoundCount"
                type="number"
                min="0"
                step="1"
                placeholder="e.g. 500 (leave blank if new)"
                className={INPUT_CLASS}
              />
            </div>
          </fieldset>

          {/* Battery Tracking */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Battery Tracking
            </legend>

            <label className="flex items-center gap-2 text-sm text-vault-text">
              <input
                id="hasBattery"
                name="hasBattery"
                type="checkbox"
                className="rounded border-vault-border"
              />
              This accessory uses a battery
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="batteryType" className={LABEL_CLASS}>
                  Battery Type
                </label>
                <input
                  id="batteryType"
                  name="batteryType"
                  type="text"
                  placeholder="e.g. CR2032"
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label
                  htmlFor="replacementIntervalDays"
                  className={LABEL_CLASS}
                >
                  Replacement Interval (days)
                </label>
                <input
                  id="replacementIntervalDays"
                  name="replacementIntervalDays"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="e.g. 180"
                  className={INPUT_CLASS}
                />
              </div>
            </div>

            <div>
              <label htmlFor="lastBatteryChangeDate" className={LABEL_CLASS}>
                Last Battery Change
              </label>
              <input
                id="lastBatteryChangeDate"
                name="lastBatteryChangeDate"
                type="date"
                className={INPUT_CLASS}
              />
            </div>
          </fieldset>

          {/* Image */}
          <fieldset className="bg-vault-surface border border-vault-border rounded-lg p-5 space-y-4">
            <legend className="text-xs font-mono uppercase tracking-widest text-[#00C2FF] px-1 -ml-1">
              Image
            </legend>
            <ImagePicker
              entityType="accessory"
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
                placeholder="Any additional notes about this accessory..."
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
export default function NewAccessoryPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <NewAccessoryForm />
    </Suspense>
  );
}
