import { InvalidDateError, toDateOnlyUTC } from "./date";
import { normalizeMoney } from "./money";
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
 * A date-only value, or null. Delegates to toDateOnlyUTC, which throws on
 * anything malformed rather than guessing at a calendar day — that throw is
 * turned into null here, since a paperwork field has no other way to say
 * "not recorded" versus "recorded wrong".
 *
 * Two deliberately explicit details, both of the "implicit correctness" shape
 * that let the normalizeMoney whitespace bug ship three times:
 *
 * - blank input is its own guard, including whitespace-only. It used to be
 *   handled only because toDateOnlyUTC's regex rejects a blank and the catch
 *   swallowed the throw — correct by accident, two functions apart.
 * - only InvalidDateError becomes null. Anything else (a programming error in
 *   the date helpers, say) propagates, so the routes' 500 handler sees it
 *   instead of a paperwork column quietly going empty.
 */
function normalizeDateOnly(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  try {
    return toDateOnlyUTC(value);
  } catch (error) {
    if (error instanceof InvalidDateError) return null;
    throw error;
  }
}

/**
 * Whether a supplied nfaClass names a known class.
 *
 * normalizeClassAndRegistry falls back to NONE for anything it does not
 * recognise, which is the right answer for an ABSENT class and a destructive
 * one for a junk class: NONE clears mgRegistry and all five paperwork columns
 * with it. So `PUT { nfaClass: "SHORT_BARRELED_RIFLE" }` on a fully documented
 * SBR would wipe six columns and answer 200.
 *
 * The write routes call this and reject instead, the same way they reject a
 * malformed date. The fallback stays for absent input, where nothing is lost.
 */
export function isKnownNfaClass(value: unknown): value is NfaClass {
  return normalizeEnum<NfaClass>(value, NFA_CLASSES) !== null;
}

/**
 * The single place the class fields are decided, so every write path agrees.
 * A registry only survives on a machine gun: a record must not keep a
 * pre-sample marking after its class changes, however the write arrives.
 *
 * Private: the only caller is normalizeFirearmNfaFields, which wraps this and
 * adds the paperwork group. The firearms routes call that instead.
 */
function normalizeClassAndRegistry(input: {
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

/**
 * The paperwork behind an NFA item's transfer — independent of platform.
 *
 * Not exported: it names the return type of the two exported normalizers, and
 * every call site gets it by inference. Nothing imported it.
 */
type NfaPaperwork = {
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
  const { nfaClass, mgRegistry } = normalizeClassAndRegistry(input);
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
