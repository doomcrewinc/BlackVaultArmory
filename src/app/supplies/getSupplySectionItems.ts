import { prisma } from "@/lib/prisma";
import {
  expiryStatus,
  isLowStock,
  resolveExpiryContext,
  type ExpiryStatus,
} from "@/lib/supply";

export interface SupplySectionItem {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  quantity: number;
  unit: string;
  storageLocation: string | null;
  isLow: boolean;
  expiry: ExpiryStatus;
}

/**
 * One Supply row as a section list renders it.
 *
 * Derived from the Prisma delegate rather than hand-written, so a schema
 * change updates it automatically — hand-written row interfaces are the shape
 * that fell behind the schema in DATE_ONLY_FIELDS.
 */
type SupplyRow = Awaited<ReturnType<typeof prisma.supply.findMany>>[number];

/**
 * The row shape every supply list renders, with `isLow` and `expiry` already
 * resolved.
 *
 * Exported and shared by `getSupplySectionItems` and the section loader's
 * supply branch rather than copied into each, so the supply row shape cannot
 * drift between `/supplies/item/[id]` and the section pages.
 *
 * `today` is an argument, never read from the clock here: the caller resolves
 * it once per request through `todayForExpiry(settings?.timezone ?? null, …)`,
 * so every list on one page agrees about what "today" is.
 */
export function mapSupplyRow(
  supply: SupplyRow,
  today: Date,
  warningDays: number,
): SupplySectionItem {
  return {
    id: supply.id,
    name: supply.name,
    brand: supply.brand,
    category: supply.category,
    quantity: supply.quantity,
    unit: supply.unit,
    storageLocation: supply.storageLocation,
    isLow: isLowStock(supply),
    expiry: expiryStatus(supply.expirationDate, today, warningDays),
  };
}

export interface SupplySectionResult {
  items: SupplySectionItem[];
  /**
   * False while AppSettings.timezone is unset — the same read that resolved
   * the expiry verdicts above, handed on so the list page can say the
   * verdicts came from the server's timezone. Returned from here rather than
   * re-read by the page: one AppSettings query per request, and the flag
   * cannot drift from the verdicts it describes.
   */
  timezoneConfigured: boolean;
}

/**
 * Loads every Supply matching `where` for a section page, with `isLowStock`
 * and `expiryStatus` already resolved server-side.
 *
 * `today` is read from AppSettings ONCE per call (not per row) and passed
 * into expiryStatus alongside the stored expiryWarningDays — never a raw
 * `new Date()`, which reports supplies expired a day early every evening in
 * a negative-UTC-offset timezone (see todayForExpiry in lib/supply.ts).
 *
 * Two sequential awaits, not Promise.all — SQLite here runs with
 * connection_limit=1.
 */
export async function getSupplySectionItems(
  where: object,
): Promise<SupplySectionResult> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  // One resolution for both the verdicts and the disclosure. A separate
  // Boolean(settings.timezone) disagrees with it for a zone that is SET BUT
  // UNRECOGNISED — resolveExpiryTimeZone discards such a zone and computes in
  // UTC, so the notice must appear, and the hand-rolled predicate hid it.
  const { today, warningDays, timezoneFromSetting } = resolveExpiryContext(
    settings,
    new Date(),
  );

  const supplies = await prisma.supply.findMany({
    where,
    orderBy: { name: "asc" },
  });

  return {
    items: supplies.map((supply) => mapSupplyRow(supply, today, warningDays)),
    timezoneConfigured: timezoneFromSetting,
  };
}
