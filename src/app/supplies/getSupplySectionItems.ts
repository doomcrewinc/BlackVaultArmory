import { prisma } from "@/lib/prisma";
import {
  DEFAULT_EXPIRY_WARNING_DAYS,
  expiryStatus,
  isLowStock,
  todayForExpiry,
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
): Promise<SupplySectionItem[]> {
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });

  const today = todayForExpiry(settings?.timezone ?? null, new Date());
  const warningDays =
    settings?.expiryWarningDays ?? DEFAULT_EXPIRY_WARNING_DAYS;

  const supplies = await prisma.supply.findMany({
    where,
    orderBy: { name: "asc" },
  });

  return supplies.map((supply) => ({
    id: supply.id,
    name: supply.name,
    brand: supply.brand,
    category: supply.category,
    quantity: supply.quantity,
    unit: supply.unit,
    storageLocation: supply.storageLocation,
    isLow: isLowStock(supply),
    expiry: expiryStatus(supply.expirationDate, today, warningDays),
  }));
}
