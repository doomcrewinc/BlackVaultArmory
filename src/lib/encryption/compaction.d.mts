export const COMPACTED_TABLES: ReadonlyArray<string>;
export function compactionPending(raw: { appSettings: { findUnique(args: unknown): Promise<unknown> } }): Promise<boolean>;
export function clearCompactionPending(raw: { appSettings: { update(args: unknown): Promise<unknown> } }): Promise<void>;
export function compactDatabase(
  raw: { $executeRawUnsafe(q: string): Promise<unknown>; $queryRawUnsafe(q: string): Promise<unknown> },
  provider: "sqlite" | "postgres",
): Promise<{ statisticsCompacted: boolean; checkpoint: boolean }>;
