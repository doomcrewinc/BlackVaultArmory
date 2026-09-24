import { toDateOnlyUTC } from "./date";
import {
  DEFAULT_NFA_CLASS,
  MG_REGISTRIES,
  NFA_CLASSES,
  NFA_TRANSFER_METHODS,
  type MgRegistry,
  type NfaClass,
  type NfaTransferMethod,
} from "./types";

function normalizeEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim().toUpperCase();
  return (allowed as readonly string[]).includes(candidate)
    ? (candidate as T)
    : null;
}

/** Trims a string field to null-or-content. A blank string is null, not "". */
function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A non-negative amount, or null. Blank is null, not 0 — `Number("")` is `0`,
 * and that exact bug has already shipped twice in this repo (the accessories
 * create form and the gear form).
 */
function normalizeMoney(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * A date-only value, or null. Delegates to toDateOnlyUTC, which throws on
 * anything malformed rather than guessing at a calendar day — that throw is
 * caught here and turned into null, since a paperwork field has no other way
 * to say "not recorded" versus "recorded wrong".
 */
function normalizeDateOnly(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  try {
    return toDateOnlyUTC(value);
  } catch {
    return null;
  }
}

/**
 * The single place the class fields are decided, so every write path agrees.
 * A registry only survives on a machine gun: a record must not keep a
 * pre-sample marking after its class changes, however the write arrives.
 *
 * Superseded by normalizeFirearmNfaFields, which wraps this and adds the
 * paperwork group. Kept exported because the firearms routes still call this
 * directly; they switch over in a later task.
 */
export function normalizeFirearmClassFields(input: {
  nfaClass?: unknown;
  mgRegistry?: unknown;
}): { nfaClass: NfaClass; mgRegistry: MgRegistry | null } {
  const nfaClass =
    normalizeEnum<NfaClass>(input.nfaClass, NFA_CLASSES) ?? DEFAULT_NFA_CLASS;
  const mgRegistry =
    nfaClass === "MACHINE_GUN"
      ? normalizeEnum<MgRegistry>(input.mgRegistry, MG_REGISTRIES)
      : null;
  return { nfaClass, mgRegistry };
}

/** The paperwork behind an NFA item's transfer — independent of platform. */
export type NfaPaperwork = {
  nfaTransferMethod: NfaTransferMethod | null;
  nfaControlNumber: string | null;
  nfaApprovalDate: Date | null;
  nfaTaxPaid: number | null;
  nfaRegisteredTo: string | null;
};

type NfaPaperworkInput = {
  nfaTransferMethod?: unknown;
  nfaControlNumber?: unknown;
  nfaApprovalDate?: unknown;
  nfaTaxPaid?: unknown;
  nfaRegisteredTo?: unknown;
};

/**
 * The paperwork group, gated by whether the item is eligible to hold one at
 * all (a firearm's NFA class, an accessory's type). When it isn't, the whole
 * group is null — a record must not keep a stamp number behind after it no
 * longer claims to be regulated.
 *
 * Within an eligible record, FORM_4473 means the item moved as an ordinary
 * firearm rather than on an NFA form: there is no stamp, so the control
 * number, approval date and tax are null, but nfaRegisteredTo survives —
 * someone still owns the item, transfer method notwithstanding.
 */
function normalizePaperwork(
  input: NfaPaperworkInput,
  eligible: boolean,
): NfaPaperwork {
  if (!eligible) {
    return {
      nfaTransferMethod: null,
      nfaControlNumber: null,
      nfaApprovalDate: null,
      nfaTaxPaid: null,
      nfaRegisteredTo: null,
    };
  }

  const nfaTransferMethod = normalizeEnum<NfaTransferMethod>(
    input.nfaTransferMethod,
    NFA_TRANSFER_METHODS,
  );
  const hasStamp = nfaTransferMethod !== "FORM_4473";

  return {
    nfaTransferMethod,
    nfaControlNumber: hasStamp ? normalizeText(input.nfaControlNumber) : null,
    nfaApprovalDate: hasStamp ? normalizeDateOnly(input.nfaApprovalDate) : null,
    nfaTaxPaid: hasStamp ? normalizeMoney(input.nfaTaxPaid) : null,
    nfaRegisteredTo: normalizeText(input.nfaRegisteredTo),
  };
}

/**
 * The full NFA record for a firearm: class, registry and paperwork, decided
 * together. Dropping the class to NONE clears the entire group, mgRegistry
 * included — a record must not keep paperwork for a status it no longer has.
 */
export function normalizeFirearmNfaFields(
  input: {
    nfaClass?: unknown;
    mgRegistry?: unknown;
  } & NfaPaperworkInput,
): { nfaClass: NfaClass; mgRegistry: MgRegistry | null } & NfaPaperwork {
  const { nfaClass, mgRegistry } = normalizeFirearmClassFields(input);
  const paperwork = normalizePaperwork(input, nfaClass !== "NONE");
  return { nfaClass, mgRegistry, ...paperwork };
}

/**
 * The paperwork group for an accessory. Accessories have no class column, so
 * the item's type is the gate: only a SUPPRESSOR is eligible, and any other
 * type clears the group entirely.
 */
export function normalizeAccessoryNfaFields(
  type: unknown,
  input: NfaPaperworkInput,
): NfaPaperwork {
  const normalizedType =
    typeof type === "string" ? type.trim().toUpperCase() : "";
  return normalizePaperwork(input, normalizedType === "SUPPRESSOR");
}
