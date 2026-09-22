import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";

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

    const log = await prisma.maintenanceLog.create({
      data: {
        firearmId: id,
        date: entryDate,
        notes: body.notes.trim(),
        roundCount: body.roundCount ?? null,
      },
    });

    // Optionally update the firearm's lastMaintenanceDate and maintenanceIntervalDays
    if (body.nextDueDate) {
      let nextDue: Date;
      try {
        nextDue = toDateOnlyUTC(body.nextDueDate);
      } catch {
        nextDue = new Date(NaN);
      }
      if (!isNaN(nextDue.getTime())) {
        const intervalDays = Math.round(
          (nextDue.getTime() - entryDate.getTime()) / 86400000
        );
        await prisma.firearm.update({
          where: { id },
          data: {
            lastMaintenanceDate: entryDate,
            maintenanceIntervalDays: intervalDays > 0 ? intervalDays : null,
          },
        });
      }
    }

    return NextResponse.json(log, { status: 201 });
  } catch (error) {
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }
    console.error("POST /api/firearms/[id]/maintenance error:", error);
    return NextResponse.json({ error: "Failed to create maintenance log" }, { status: 500 });
  }
}
