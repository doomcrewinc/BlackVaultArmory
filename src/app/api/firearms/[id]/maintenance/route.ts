import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { lastServicedAfterEntry } from "@/lib/maintenance";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const logs = await prisma.maintenanceLog.findMany({
    where: { firearmId: id },
    orderBy: { date: "desc" },
  });

  return NextResponse.json(logs);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const firearm = await prisma.firearm.findUnique({ where: { id } });
  if (!firearm) {
    return NextResponse.json({ error: "Firearm not found" }, { status: 404 });
  }

  let body: { date?: string; notes?: string; roundCount?: number; nextDueDate?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.date || !body.notes?.trim()) {
    return NextResponse.json({ error: "date and notes are required" }, { status: 400 });
  }

  try {
    const entryDate = toDateOnlyUTC(body.date);

    // A next-due date, when given, sets the interval from this entry.
    let intervalDays: number | null | undefined;
    if (body.nextDueDate) {
      try {
        const days = Math.round((toDateOnlyUTC(body.nextDueDate).getTime() - entryDate.getTime()) / 86400000);
        intervalDays = days > 0 ? days : null;
      } catch {
        intervalDays = undefined;
      }
    }

    // Logging the work is what resets the clock: the entry and the firearm's
    // last-serviced date are written together. With a next-due date the entry
    // becomes the last service outright (the interval is counted from it);
    // otherwise the date only ever moves forward.
    const lastMaintenanceDate =
      intervalDays === undefined ? lastServicedAfterEntry(firearm.lastMaintenanceDate, entryDate) : entryDate;
    const { log, updated } = await prisma.$transaction(async (tx) => {
      const created = await tx.maintenanceLog.create({
        data: {
          firearmId: id,
          date: entryDate,
          notes: (body.notes as string).trim(),
          roundCount: body.roundCount ?? null,
        },
      });
      const saved = await tx.firearm.update({
        where: { id },
        data: {
          lastMaintenanceDate,
          ...(intervalDays === undefined ? {} : { maintenanceIntervalDays: intervalDays }),
        },
        select: { lastMaintenanceDate: true, maintenanceIntervalDays: true },
      });
      return { log: created, updated: saved };
    });

    return NextResponse.json({ ...log, firearm: updated }, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }
    console.error("POST /api/firearms/[id]/maintenance error:", error);
    return NextResponse.json({ error: "Failed to create maintenance log" }, { status: 500 });
  }
}
