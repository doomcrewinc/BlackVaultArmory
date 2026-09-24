"use client";

import {
  NFA_TRANSFER_METHODS,
  NFA_TRANSFER_METHOD_LABELS,
} from "@/lib/types";

// Identical to the INPUT_CLASS / LABEL_CLASS declared in every host form
// (src/app/vault/new/page.tsx, src/app/vault/[id]/edit/page.tsx,
// src/app/accessories/new/page.tsx, src/app/accessories/[id]/edit/page.tsx).
// Re-declared here rather than taken as props: all four hosts already define
// the exact same two strings, so a prop would just be forwarding a constant
// every call site already has memorized — re-declaring keeps this component
// self-contained and drop-in without adding two more required props to every
// call site.
const INPUT_CLASS =
  "w-full bg-vault-surface border border-vault-border text-vault-text rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[#00C2FF] placeholder-vault-text-faint transition-colors";
const LABEL_CLASS =
  "block text-xs font-medium uppercase tracking-widest text-vault-text-muted mb-1.5";

/**
 * The five NFA paperwork fields as form-input strings. Dates are the date
 * input's own YYYY-MM-DD string (see toISODate in @/lib/date) and money is
 * the raw text of a number input — the server (src/lib/nfa.ts) normalizes
 * both, so this component never parses them itself.
 */
export interface NfaFieldsetValue {
  nfaTransferMethod: string;
  nfaControlNumber: string;
  nfaApprovalDate: string;
  nfaTaxPaid: string;
  nfaRegisteredTo: string;
}

export type NfaFieldsetField = keyof NfaFieldsetValue;

export const EMPTY_NFA_FIELDSET_VALUE: NfaFieldsetValue = {
  nfaTransferMethod: "",
  nfaControlNumber: "",
  nfaApprovalDate: "",
  nfaTaxPaid: "",
  nfaRegisteredTo: "",
};

interface NfaFieldsetProps {
  /** Which host is rendering this: only changes the helper copy. */
  variant: "firearm" | "suppressor";
  value: NfaFieldsetValue;
  onChange: (field: NfaFieldsetField, value: string) => void;
}

/**
 * The shared NFA paperwork field group: transfer method, control number,
 * approval date, tax paid, registered owner. Purely presentational and
 * controlled — no data fetching, no effects, so it stays clear of the
 * react-hooks/set-state-in-effect rule entirely. The host owns the state and
 * the submit payload; this component only renders inputs and reports changes.
 *
 * The server is the source of truth for the clearing rules (nfaClass NONE,
 * accessory type not SUPPRESSOR, FORM_4473 nulling the stamp fields) — this
 * component only hides the stamp fields for FORM_4473 so the form doesn't
 * show a value the save will silently discard.
 */
export function NfaFieldset({ variant, value, onChange }: NfaFieldsetProps) {
  const hasStamp = value.nfaTransferMethod !== "FORM_4473";
  const itemNoun = variant === "firearm" ? "firearm" : "suppressor";
  // Switching to 4473 hides the three stamp fields but keeps whatever was
  // typed, so toggling back shows it intact — the forgiving choice. Saving,
  // though, clears those columns server-side, and that has to be said out
  // loud while there is still something to lose.
  const willDiscardStampEntries =
    !hasStamp &&
    Boolean(
      value.nfaControlNumber || value.nfaApprovalDate || value.nfaTaxPaid,
    );

  return (
    <div className="space-y-4 pt-4 border-t border-vault-border">
      <p className="text-xs font-mono uppercase tracking-widest text-[#00C2FF]">
        NFA Paperwork
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="nfaTransferMethod" className={LABEL_CLASS}>
            Transfer Method
          </label>
          <select
            id="nfaTransferMethod"
            name="nfaTransferMethod"
            value={value.nfaTransferMethod}
            onChange={(event) =>
              onChange("nfaTransferMethod", event.target.value)
            }
            className={INPUT_CLASS}
          >
            <option value="">Not recorded</option>
            {NFA_TRANSFER_METHODS.map((method) => (
              <option key={method} value={method}>
                {NFA_TRANSFER_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="nfaRegisteredTo" className={LABEL_CLASS}>
            Registered To
          </label>
          <input
            id="nfaRegisteredTo"
            name="nfaRegisteredTo"
            type="text"
            value={value.nfaRegisteredTo}
            onChange={(event) =>
              onChange("nfaRegisteredTo", event.target.value)
            }
            placeholder="e.g. Individual or trust name"
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {hasStamp ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="nfaControlNumber" className={LABEL_CLASS}>
              Control Number
            </label>
            <input
              id="nfaControlNumber"
              name="nfaControlNumber"
              type="text"
              value={value.nfaControlNumber}
              onChange={(event) =>
                onChange("nfaControlNumber", event.target.value)
              }
              placeholder="e.g. 2024123456"
              className={`${INPUT_CLASS} font-mono`}
            />
          </div>

          <div>
            <label htmlFor="nfaApprovalDate" className={LABEL_CLASS}>
              Approval Date
            </label>
            <input
              id="nfaApprovalDate"
              name="nfaApprovalDate"
              type="date"
              value={value.nfaApprovalDate}
              onChange={(event) =>
                onChange("nfaApprovalDate", event.target.value)
              }
              className={INPUT_CLASS}
            />
          </div>

          <div>
            <label htmlFor="nfaTaxPaid" className={LABEL_CLASS}>
              Tax Paid
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-vault-text-faint text-sm">
                $
              </span>
              <input
                id="nfaTaxPaid"
                name="nfaTaxPaid"
                type="number"
                min="0"
                step="0.01"
                value={value.nfaTaxPaid}
                onChange={(event) =>
                  onChange("nfaTaxPaid", event.target.value)
                }
                placeholder="0.00"
                className={`${INPUT_CLASS} pl-7`}
              />
            </div>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-vault-text-faint">
          This {itemNoun} moved on a 4473, not an NFA form — there is no
          stamp, so the control number, approval date and tax paid are not
          tracked.
          {willDiscardStampEntries && (
            <>
              {" "}
              <span className="text-[#E53935]">
                Saving will clear the control number, approval date and tax
                paid you entered.
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}
