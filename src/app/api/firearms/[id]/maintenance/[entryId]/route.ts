import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { lastServicedAfterDelete } from "@/lib/maintenance";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; entryId: string }> }
) {
  const { id, entryId } = await params;

  const log = await prisma.maintenanceLog.findUnique({
    where: { id: entryId },
  });

  if (!log || log.firearmId !== id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Deleting the entry that was the last service moves the firearm's
  // last-serviced date back to the latest entry that remains.
  const firearm = await prisma.$transaction(async (tx) => {
    await tx.maintenanceLog.delete({ where: { id: entryId } });
    const current = await tx.firearm.findUnique({
      where: { id },
      select: { lastMaintenanceDate: true, maintenanceIntervalDays: true },
    });
    if (!current) return null;
    const latest = await tx.maintenanceLog.findFirst({
      where: { firearmId: id },
      orderBy: { date: "desc" },
      select: { date: true },
    });
    const next = lastServicedAfterDelete(current.lastMaintenanceDate, log.date, latest?.date ?? null);
    if (next?.getTime() === current.lastMaintenanceDate?.getTime()) return current;
    return tx.firearm.update({
      where: { id },
      data: { lastMaintenanceDate: next },
      select: { lastMaintenanceDate: true, maintenanceIntervalDays: true },
    });
  });

  return NextResponse.json({ success: true, firearm });
}
