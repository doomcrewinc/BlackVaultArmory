import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidateDashboardData } from "@/lib/dashboard/revalidate-dashboard";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { normalizeQuantity } from "@/lib/quantity";
import { normalizeAccessoryNfaFields } from "@/lib/nfa";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

// GET /api/accessories/[id] - Get a single accessory with roundCountLogs and current buildSlots
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const accessory = await prisma.accessory.findUnique({
      where: { id },
      include: {
        roundCountLogs: {
          orderBy: { loggedAt: "desc" },
        },
        batteryChangeLogs: {
          orderBy: { changedAt: "desc" },
        },
        buildSlots: {
          include: {
            build: {
              select: {
                id: true,
                name: true,
                isActive: true,
                firearm: {
                  select: {
                    id: true,
                    name: true,
                    manufacturer: true,
                    model: true,
                    type: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!accessory) {
      return NextResponse.json(
        { error: "Accessory not found" },
        { status: 404 },
      );
    }

    const activeSlot = accessory.buildSlots.find((slot) => slot.build.isActive);

    return NextResponse.json({
      ...accessory,
      currentBuild: activeSlot
        ? {
            id: activeSlot.build.id,
            name: activeSlot.build.name,
            slotType: activeSlot.slotType,
            firearm: activeSlot.build.firearm,
          }
        : null,
    });
  } catch (error) {
    console.error("GET /api/accessories/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch accessory" },
      { status: 500 },
    );
  }
}

// PUT /api/accessories/[id] - Update an accessory
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await request.json();

    const {
      name,
      manufacturer,
      model,
      serialNumber,
      type,
      caliber,
      purchasePrice,
      acquisitionDate,
      notes,
      imageUrl,
      imageSource,
      compatibleFirearmTypes,
      compatibleCalibers,
      hasBattery,
      batteryType,
      lastBatteryChangeDate,
      replacementIntervalDays,
      quantity,
      nfaTransferMethod,
      nfaControlNumber,
      nfaApprovalDate,
      nfaTaxPaid,
      nfaRegisteredTo,
    } = body;

    const existing = await prisma.accessory.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Accessory not found" },
        { status: 404 },
      );
    }

    // Unlike the firearm route, the eligibility gate here (`type`) is an
    // ordinary editable field, not a dedicated class column — so a write that
    // only changes `type` (no paperwork field mentioned at all, e.g.
    // `{ type: "OPTIC" }`) must still re-derive the group: moving a
    // suppressor's type away must clear its paperwork even though the body
    // never names a paperwork column. So the gate fires on `type` OR any
    // paperwork field being present, and — critically — the normalizer is
    // handed the RESOLVED type (the body's type if this write sets one,
    // otherwise the type already stored), never the raw possibly-absent body
    // field, since normalizeAccessoryNfaFields trusts whatever string it is
    // given and cannot itself detect a stale or wrong one.
    const touchesNfaGroup =
      type !== undefined ||
      nfaTransferMethod !== undefined ||
      nfaControlNumber !== undefined ||
      nfaApprovalDate !== undefined ||
      nfaTaxPaid !== undefined ||
      nfaRegisteredTo !== undefined;
    const resolvedType =
      type !== undefined
        ? normalizeString(type) || "UNSPECIFIED"
        : existing.type;

    const updated = await prisma.accessory.update({
      where: { id },
      data: {
        ...(name !== undefined && {
          name: normalizeString(name) || existing.name,
        }),
        ...(manufacturer !== undefined && {
          manufacturer: normalizeString(manufacturer) || "Unknown",
        }),
        ...(model !== undefined && { model: normalizeString(model) || null }),
        ...(serialNumber !== undefined && {
          serialNumber: normalizeString(serialNumber) || null,
        }),
        ...(type !== undefined && { type: resolvedType }),
        ...(touchesNfaGroup
          ? normalizeAccessoryNfaFields(resolvedType, {
              // Absence is checked with !== undefined (not ??) so an explicit
              // null still clears a nullable paperwork column, matching the
              // firearm route's convention.
              nfaTransferMethod:
                nfaTransferMethod !== undefined
                  ? nfaTransferMethod
                  : existing.nfaTransferMethod,
              nfaControlNumber:
                nfaControlNumber !== undefined
                  ? nfaControlNumber
                  : existing.nfaControlNumber,
              nfaApprovalDate:
                nfaApprovalDate !== undefined
                  ? nfaApprovalDate
                  : existing.nfaApprovalDate,
              nfaTaxPaid:
                nfaTaxPaid !== undefined ? nfaTaxPaid : existing.nfaTaxPaid,
              nfaRegisteredTo:
                nfaRegisteredTo !== undefined
                  ? nfaRegisteredTo
                  : existing.nfaRegisteredTo,
            })
          : {}),
        ...(caliber !== undefined && { caliber }),
        ...(purchasePrice !== undefined && { purchasePrice }),
        ...(acquisitionDate !== undefined && {
          acquisitionDate: acquisitionDate
            ? toDateOnlyUTC(acquisitionDate)
            : null,
        }),
        ...(notes !== undefined && { notes }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(imageSource !== undefined && { imageSource }),
        ...(compatibleFirearmTypes !== undefined && { compatibleFirearmTypes }),
        ...(compatibleCalibers !== undefined && { compatibleCalibers }),
        ...(hasBattery !== undefined && { hasBattery: Boolean(hasBattery) }),
        ...(batteryType !== undefined && { batteryType }),
        ...(lastBatteryChangeDate !== undefined && {
          lastBatteryChangeDate: lastBatteryChangeDate
            ? toDateOnlyUTC(lastBatteryChangeDate)
            : null,
        }),
        ...(replacementIntervalDays !== undefined && {
          replacementIntervalDays,
        }),
        ...(quantity !== undefined && {
          quantity: normalizeQuantity(quantity, existing.quantity),
        }),
      },
      include: {
        roundCountLogs: {
          orderBy: { loggedAt: "desc" },
          take: 10,
        },
        buildSlots: {
          include: {
            build: {
              select: {
                id: true,
                name: true,
                isActive: true,
                firearm: {
                  select: { id: true, name: true },
                },
              },
            },
          },
        },
      },
    });

    revalidateDashboardData();

    return NextResponse.json(updated);
  } catch (error) {
    console.error("PUT /api/accessories/[id] error:", error);
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Failed to update accessory" },
      { status: 500 },
    );
  }
}

// DELETE /api/accessories/[id] - Delete an accessory
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = await prisma.accessory.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Accessory not found" },
        { status: 404 },
      );
    }

    await prisma.accessory.delete({ where: { id } });
    revalidateDashboardData();

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("DELETE /api/accessories/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to delete accessory" },
      { status: 500 },
    );
  }
}
