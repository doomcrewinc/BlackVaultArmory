import {
  DEFAULT_NFA_CLASS,
  MG_REGISTRIES,
  NFA_CLASSES,
  type MgRegistry,
  type NfaClass,
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

/**
 * The single place the class fields are decided, so every write path agrees.
 * A registry only survives on a machine gun: a record must not keep a
 * pre-sample marking after its class changes, however the write arrives.
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
