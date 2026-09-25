import { prisma } from "@/lib/prisma";
import {
  expiryStatus,
  isLowStock,
  resolveExpiryContext,
  type ExpiryStatus,
} from "@/lib/supply";
import { GEAR_CATEGORY_LABELS, type GearCategory } from "@/lib/gear";

export interface DashboardStatsResponse {
  totals: {
    firearms: number;
    accessories: number;
    ammoRounds: number;
    ammoStocks: number;
  };
  investment: {
    totalCost: number;
    totalCurrentValue: number;
    unrealizedGainLoss: number;
    firearmCost: number;
    firearmCurrentValue: number;
    accessoryCost: number;
  };
  ammo: {
    stocks: Array<{
      id: string;
      caliber: string;
      brand: string;
      quantity: number;
      purchasePrice: number | null;
      lowStockAlert: number | null;
      grainWeight: number | null;
      bulletType: string | null;
    }>;
    byCaliber: Array<{
      caliber: string;
      totalRounds: number;
      stockCount: number;
      lowStock: boolean;
    }>;
    lowStockCount: number;
    lowStockItems: Array<{
      id: string;
      caliber: string;
      brand: string;
      quantity: number;
      lowStockAlert: number | null;
    }>;
  };
  supplies: {
    lowStockItems: Array<{
      id: string;
      name: string;
      category: string;
      quantity: number;
      unit: string;
      lowStockAlert: number | null;
    }>;
    lowStockCount: number;
    expiredCount: number;
    expiringSoonCount: number;
    /**
     * False while AppSettings.timezone is unset, which is its state out of the
     * box. The expiry verdicts above are then resolved in the SERVER's
     * timezone — in a container, UTC — so the dashboard says so rather than
     * quietly reporting a day-shifted verdict. See todayForExpiry.
     */
    timezoneConfigured: boolean;
  };
  /**
   * Expiring GEAR, alongside the expiring supplies above. Armor plates have a
   * rated life and filters have a shelf life, and a dashboard that counted
   * only half the expiring inventory is worse than one that counted none — the
   * user reads "0 expired" and believes it.
   *
   * Only the rows that need attention: `expired` or `soon`. A `fine` or
   * date-less item is not an alert and is not carried here.
   */
  gear: {
    expiringItems: Array<{
      id: string;
      name: string;
      /** The human label ("Armor"), as every other surface shows it. */
      category: string;
      expirationDate: Date | null;
      /**
       * Resolved SERVER-SIDE from the same `today` the supply counts used.
       * The widget is a client component and must never recompute this: it has
       * no access to AppSettings.timezone, so it would silently judge against
       * the browser's day and disagree with the counts beside it.
       */
      expiry: Extract<ExpiryStatus, "expired" | "soon">;
    }>;
    expiredCount: number;
    expiringSoonCount: number;
  };
  recent: {
    firearms: Array<{
      id: string;
      name: string;
      manufacturer: string;
      model: string;
      type: string;
      caliber: string;
      imageUrl: string | null;
      acquisitionDate: Date | null;
      createdAt: Date;
    }>;
    accessories: Array<{
      id: string;
      name: string;
      manufacturer: string;
      type: string;
      imageUrl: string | null;
      createdAt: Date;
    }>;
    ammo: Array<{
      id: string;
      caliber: string;
      brand: string;
      quantity: number;
      updatedAt: Date;
    }>;
  };
}

export async function getDashboardStats(): Promise<DashboardStatsResponse> {
  // Sequential queries — SQLite connection_limit=1 cannot handle concurrent reads
  const firearmCount = await prisma.firearm.count();
  const accessoryCount = await prisma.accessory.count();
  const ammoStocks = await prisma.ammoStock.findMany({
    select: {
      id: true,
      caliber: true,
      brand: true,
      quantity: true,
      purchasePrice: true,
      lowStockAlert: true,
      grainWeight: true,
      bulletType: true,
    },
  });
  const firearms = await prisma.firearm.findMany({
    select: {
      id: true,
      purchasePrice: true,
      currentValue: true,
    },
  });
  const accessories = await prisma.accessory.findMany({
    select: {
      id: true,
      purchasePrice: true,
    },
  });
  const recentFirearms = await prisma.firearm.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      model: true,
      type: true,
      caliber: true,
      imageUrl: true,
      acquisitionDate: true,
      createdAt: true,
    },
  });
  const recentAccessories = await prisma.accessory.findMany({
    take: 5,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      manufacturer: true,
      type: true,
      imageUrl: true,
      createdAt: true,
    },
  });
  const recentAmmo = await prisma.ammoStock.findMany({
    take: 5,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      caliber: true,
      brand: true,
      quantity: true,
      updatedAt: true,
    },
  });
  // AppSettings is read ONCE here, not per supply row, matching
  // getSupplySectionItems — today and the expiry warning window are both
  // resolved from this single read.
  const settings = await prisma.appSettings.findUnique({
    where: { id: "singleton" },
  });
  const supplies = await prisma.supply.findMany({
    select: {
      id: true,
      name: true,
      category: true,
      quantity: true,
      unit: true,
      lowStockAlert: true,
      expirationDate: true,
    },
  });
  // Sequential, after the supply read — SQLite here runs connection_limit=1,
  // so never Promise.all. Narrowed in SQL to the rows that can possibly be an
  // alert: an install with a thousand knives should not ship a thousand null
  // dates to the Node process to filter them out again.
  const datedGear = await prisma.gear.findMany({
    where: { expirationDate: { not: null } },
    select: {
      id: true,
      name: true,
      category: true,
      expirationDate: true,
    },
    orderBy: { expirationDate: "asc" },
  });

  const ammoByCaliber: Record<
    string,
    { caliber: string; totalRounds: number; stockCount: number; lowStock: boolean }
  > = {};

  let totalAmmoRounds = 0;

  for (const stock of ammoStocks) {
    totalAmmoRounds += stock.quantity;

    if (!ammoByCaliber[stock.caliber]) {
      ammoByCaliber[stock.caliber] = {
        caliber: stock.caliber,
        totalRounds: 0,
        stockCount: 0,
        lowStock: false,
      };
    }

    ammoByCaliber[stock.caliber].totalRounds += stock.quantity;
    ammoByCaliber[stock.caliber].stockCount += 1;

    if (
      stock.lowStockAlert !== null &&
      stock.lowStockAlert !== undefined &&
      stock.quantity <= stock.lowStockAlert
    ) {
      ammoByCaliber[stock.caliber].lowStock = true;
    }
  }

  const totalFirearmInvestment = firearms.reduce((sum, f) => sum + (f.purchasePrice ?? 0), 0);
  const totalFirearmCurrentValue = firearms.reduce(
    (sum, f) => sum + (f.currentValue ?? f.purchasePrice ?? 0),
    0
  );
  const totalAccessoryInvestment = accessories.reduce((sum, a) => sum + (a.purchasePrice ?? 0), 0);
  const totalInvestment = totalFirearmInvestment + totalAccessoryInvestment;
  const totalCurrentValue = totalFirearmCurrentValue + totalAccessoryInvestment;
  const unrealizedGainLoss = totalCurrentValue - totalInvestment;

  const lowStockItems = ammoStocks.filter(
    (s) =>
      s.lowStockAlert !== null &&
      s.lowStockAlert !== undefined &&
      s.quantity <= s.lowStockAlert
  );

  // ONE resolution of "today" for this whole request, shared by the supply
  // counts and the gear alerts below. Two resolutions could land on different
  // calendar days either side of local midnight and put a "0 expired" tile
  // next to an expired row.
  const { today, warningDays } = resolveExpiryContext(settings, new Date());

  const lowStockSupplies = supplies.filter((s) => isLowStock(s));
  let expiredSupplyCount = 0;
  let expiringSoonSupplyCount = 0;
  for (const supply of supplies) {
    const status = expiryStatus(supply.expirationDate, today, warningDays);
    if (status === "expired") expiredSupplyCount += 1;
    if (status === "soon") expiringSoonSupplyCount += 1;
  }

  const expiringGear: DashboardStatsResponse["gear"]["expiringItems"] = [];
  let expiredGearCount = 0;
  let expiringSoonGearCount = 0;
  for (const item of datedGear) {
    const status = expiryStatus(item.expirationDate, today, warningDays);
    if (status !== "expired" && status !== "soon") continue;
    if (status === "expired") expiredGearCount += 1;
    else expiringSoonGearCount += 1;
    expiringGear.push({
      id: item.id,
      name: item.name,
      category:
        GEAR_CATEGORY_LABELS[item.category as GearCategory] ?? item.category,
      expirationDate: item.expirationDate,
      expiry: status,
    });
  }

  return {
    totals: {
      firearms: firearmCount,
      accessories: accessoryCount,
      ammoRounds: totalAmmoRounds,
      ammoStocks: ammoStocks.length,
    },
    investment: {
      totalCost: totalInvestment,
      totalCurrentValue,
      unrealizedGainLoss,
      firearmCost: totalFirearmInvestment,
      firearmCurrentValue: totalFirearmCurrentValue,
      accessoryCost: totalAccessoryInvestment,
    },
    ammo: {
      stocks: ammoStocks.map((s) => ({
        id: s.id,
        caliber: s.caliber,
        brand: s.brand,
        quantity: s.quantity,
        purchasePrice: s.purchasePrice,
        lowStockAlert: s.lowStockAlert,
        grainWeight: s.grainWeight,
        bulletType: s.bulletType,
      })),
      byCaliber: Object.values(ammoByCaliber).sort((a, b) => a.caliber.localeCompare(b.caliber)),
      lowStockCount: lowStockItems.length,
      lowStockItems: lowStockItems.map((s) => ({
        id: s.id,
        caliber: s.caliber,
        brand: s.brand,
        quantity: s.quantity,
        lowStockAlert: s.lowStockAlert,
      })),
    },
    supplies: {
      lowStockItems: lowStockSupplies.map((s) => ({
        id: s.id,
        name: s.name,
        category: s.category,
        quantity: s.quantity,
        unit: s.unit,
        lowStockAlert: s.lowStockAlert,
      })),
      lowStockCount: lowStockSupplies.length,
      expiredCount: expiredSupplyCount,
      expiringSoonCount: expiringSoonSupplyCount,
      timezoneConfigured: Boolean(settings?.timezone),
    },
    gear: {
      expiringItems: expiringGear,
      expiredCount: expiredGearCount,
      expiringSoonCount: expiringSoonGearCount,
    },
    recent: {
      firearms: recentFirearms,
      accessories: recentAccessories,
      ammo: recentAmmo,
    },
  };
}
