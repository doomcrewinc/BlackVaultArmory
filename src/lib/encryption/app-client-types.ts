import type { Prisma, PrismaClient } from "@prisma/client";
import type { ITXClientDenyList, Types } from "@prisma/client/runtime/library";

/**
 * The app client's TYPE: the generated PrismaClient, with the two type-changed
 * encrypted columns (`nfaApprovalDate`, `nfaTaxPaid` on Firearm and Accessory)
 * typed as the application sees them — `Date | null` and `number | null`, the
 * same as before Task 2 made them String columns.
 *
 * Why a typed wrapper and not the extension's `result` component
 * (`needs` / `compute`): a result extension retypes READS only. Prisma's
 * write-input types (`FirearmCreateInput`, …) are not parameterised by the
 * client's extensions, so the routes that write a Date / number would still
 * not typecheck. And its compute runs on top of the query hook in an order
 * Prisma does not document, so it could see ciphertext. The runtime
 * conversion therefore lives in the query hook (extension.ts
 * `decodeFromStorage`), and this file only describes it:
 *
 * - reads: the client is `PrismaClient<…, AppExtArgs>`. AppExtArgs declares
 *   the two fields as result-extension fields, which Prisma's own payload
 *   types (`GetPayloadResult`) substitute into every model result — top
 *   level, `include`, `select`, nested, and the `$transaction` client.
 * - writes: the `firearm` and `accessory` delegates' write methods take
 *   `data` / `create` / `update` with the two fields as Date / number.
 *   Nested writes of these two fields from ANOTHER model (e.g. a Build create
 *   that nests an Accessory with an approval date) keep the generated String
 *   type; the runtime handles them either way, and no code writes them so.
 *
 * Type only — nothing here exists at runtime.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the exact shape Prisma matches (GetPayloadResultExtensionObject)
type ResultField<T> = { compute: (...args: any) => T };
type NfaResultFields = { nfaApprovalDate: ResultField<Date | null>; nfaTaxPaid: ResultField<number | null> };

export type AppExtArgs = Types.Extensions.InternalArgs<
  { firearm: NfaResultFields; accessory: NfaResultFields },
  Record<never, never>,
  Record<never, never>,
  Record<never, never>
>;

// ─── Write inputs ───────────────────────────────────────────────

type NfaWriteFields = { nfaApprovalDate?: Date | null; nfaTaxPaid?: number | null };

/** One create/update input (or each arm of an XOR / union) with the two fields retyped. */
type PatchInput<D> = D extends readonly (infer E)[]
  ? PatchInput<E>[]
  : D extends object
    ? Omit<D, keyof NfaWriteFields> & NfaWriteFields
    : D;

type PatchKeys<A, K extends keyof A> = Omit<A, K> & { [P in K]: PatchInput<A[P]> };

type FirearmCreateArgs = PatchKeys<Prisma.FirearmCreateArgs<AppExtArgs>, "data">;
type FirearmCreateManyArgs = PatchKeys<Prisma.FirearmCreateManyArgs<AppExtArgs>, "data">;
type FirearmCreateManyAndReturnArgs = PatchKeys<Prisma.FirearmCreateManyAndReturnArgs<AppExtArgs>, "data">;
type FirearmUpdateArgs = PatchKeys<Prisma.FirearmUpdateArgs<AppExtArgs>, "data">;
type FirearmUpdateManyArgs = PatchKeys<Prisma.FirearmUpdateManyArgs<AppExtArgs>, "data">;
type FirearmUpsertArgs = PatchKeys<Prisma.FirearmUpsertArgs<AppExtArgs>, "create" | "update">;

type AccessoryCreateArgs = PatchKeys<Prisma.AccessoryCreateArgs<AppExtArgs>, "data">;
type AccessoryCreateManyArgs = PatchKeys<Prisma.AccessoryCreateManyArgs<AppExtArgs>, "data">;
type AccessoryCreateManyAndReturnArgs = PatchKeys<Prisma.AccessoryCreateManyAndReturnArgs<AppExtArgs>, "data">;
type AccessoryUpdateArgs = PatchKeys<Prisma.AccessoryUpdateArgs<AppExtArgs>, "data">;
type AccessoryUpdateManyArgs = PatchKeys<Prisma.AccessoryUpdateManyArgs<AppExtArgs>, "data">;
type AccessoryUpsertArgs = PatchKeys<Prisma.AccessoryUpsertArgs<AppExtArgs>, "create" | "update">;

type WriteMethods = "create" | "createMany" | "createManyAndReturn" | "update" | "updateMany" | "upsert";

type GetResult<P extends Types.Payload, T, Op extends Types.Result.Operation> = Types.Result.GetResult<P, T, Op>;
type FirearmPayload = Prisma.$FirearmPayload<AppExtArgs>;
type AccessoryPayload = Prisma.$AccessoryPayload<AppExtArgs>;

export interface AppFirearmDelegate extends Omit<Prisma.FirearmDelegate<AppExtArgs>, WriteMethods> {
  create<T extends FirearmCreateArgs>(args: Prisma.SelectSubset<T, FirearmCreateArgs>): Prisma.Prisma__FirearmClient<GetResult<FirearmPayload, T, "create">, never, AppExtArgs>;
  createMany<T extends FirearmCreateManyArgs>(args?: Prisma.SelectSubset<T, FirearmCreateManyArgs>): Prisma.PrismaPromise<Prisma.BatchPayload>;
  createManyAndReturn<T extends FirearmCreateManyAndReturnArgs>(args?: Prisma.SelectSubset<T, FirearmCreateManyAndReturnArgs>): Prisma.PrismaPromise<GetResult<FirearmPayload, T, "createManyAndReturn">>;
  update<T extends FirearmUpdateArgs>(args: Prisma.SelectSubset<T, FirearmUpdateArgs>): Prisma.Prisma__FirearmClient<GetResult<FirearmPayload, T, "update">, never, AppExtArgs>;
  updateMany<T extends FirearmUpdateManyArgs>(args: Prisma.SelectSubset<T, FirearmUpdateManyArgs>): Prisma.PrismaPromise<Prisma.BatchPayload>;
  upsert<T extends FirearmUpsertArgs>(args: Prisma.SelectSubset<T, FirearmUpsertArgs>): Prisma.Prisma__FirearmClient<GetResult<FirearmPayload, T, "upsert">, never, AppExtArgs>;
}

export interface AppAccessoryDelegate extends Omit<Prisma.AccessoryDelegate<AppExtArgs>, WriteMethods> {
  create<T extends AccessoryCreateArgs>(args: Prisma.SelectSubset<T, AccessoryCreateArgs>): Prisma.Prisma__AccessoryClient<GetResult<AccessoryPayload, T, "create">, never, AppExtArgs>;
  createMany<T extends AccessoryCreateManyArgs>(args?: Prisma.SelectSubset<T, AccessoryCreateManyArgs>): Prisma.PrismaPromise<Prisma.BatchPayload>;
  createManyAndReturn<T extends AccessoryCreateManyAndReturnArgs>(args?: Prisma.SelectSubset<T, AccessoryCreateManyAndReturnArgs>): Prisma.PrismaPromise<GetResult<AccessoryPayload, T, "createManyAndReturn">>;
  update<T extends AccessoryUpdateArgs>(args: Prisma.SelectSubset<T, AccessoryUpdateArgs>): Prisma.Prisma__AccessoryClient<GetResult<AccessoryPayload, T, "update">, never, AppExtArgs>;
  updateMany<T extends AccessoryUpdateManyArgs>(args: Prisma.SelectSubset<T, AccessoryUpdateManyArgs>): Prisma.PrismaPromise<Prisma.BatchPayload>;
  upsert<T extends AccessoryUpsertArgs>(args: Prisma.SelectSubset<T, AccessoryUpsertArgs>): Prisma.Prisma__AccessoryClient<GetResult<AccessoryPayload, T, "upsert">, never, AppExtArgs>;
}

// ─── Clients ────────────────────────────────────────────────────

type ReadTyped = PrismaClient<Prisma.PrismaClientOptions, never, AppExtArgs>;
type WithAppDelegates<C> = Omit<C, "firearm" | "accessory"> & { firearm: AppFirearmDelegate; accessory: AppAccessoryDelegate };

/** The client inside `prisma.$transaction(async (tx) => …)`. */
export type AppTransactionClient = WithAppDelegates<Omit<ReadTyped, ITXClientDenyList>>;

/** The type of `prisma` from src/lib/prisma.ts. */
export type AppPrismaClient = Omit<WithAppDelegates<ReadTyped>, "$transaction"> & {
  $transaction<P extends Prisma.PrismaPromise<unknown>[]>(
    arg: [...P],
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<Types.Utils.UnwrapTuple<P>>;
  $transaction<R>(
    fn: (tx: AppTransactionClient) => Promise<R>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
  ): Promise<R>;
};
