import { PageHeader } from "@/components/shared/PageHeader";
import { DashboardClient } from "@/components/dashboard/DashboardClient";
import { getDashboardStats } from "@/lib/dashboard/get-dashboard-stats";
import { LanBanner } from "@/components/dashboard/LanBanner";

async function getDashboardData() {
  const stats = await getDashboardStats();

  return {
    firearmCount: stats.totals.firearms,
    accessoryCount: stats.totals.accessories,
    totalAmmoRounds: stats.totals.ammoRounds,
    totalInvestment: stats.investment.totalCost,
    lowStockItems: stats.ammo.stocks.filter(
      (stock) =>
        stock.lowStockAlert !== null &&
        stock.lowStockAlert !== undefined &&
        stock.quantity <= stock.lowStockAlert
    ),
    recentFirearms: stats.recent.firearms,
    ammoStocks: stats.ammo.stocks,
    lowStockSupplies: stats.supplies.lowStockItems,
    expiredSupplyCount: stats.supplies.expiredCount,
    expiringSoonSupplyCount: stats.supplies.expiringSoonCount,
    supplyTimezoneConfigured: stats.supplies.timezoneConfigured,
    // Expiry statuses arrive already RESOLVED. DashboardClient is a client
    // component with no access to AppSettings.timezone, so anything it decided
    // itself would be judged against the browser's day and could contradict
    // the counts beside it.
    expiringGear: stats.gear.expiringItems,
    expiredGearCount: stats.gear.expiredCount,
    expiringSoonGearCount: stats.gear.expiringSoonCount,
  };
}

export default async function DashboardPage() {
  const data = await getDashboardData();

  return (
    <div className="tactical-grid min-h-full">
      <PageHeader
        title="COMMAND CENTER"
        subtitle="BlackVault Armory Platform — Tactical Inventory Overview"
      />
      <div className="px-4 sm:px-6 pt-4">
        <LanBanner />
      </div>
      <DashboardClient data={data} />
    </div>
  );
}
