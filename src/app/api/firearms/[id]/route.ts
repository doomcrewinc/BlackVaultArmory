import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidateDashboardData } from "@/lib/dashboard/revalidate-dashboard";
import { decryptField } from "@/lib/crypto";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { isKnownNfaClass, normalizeFirearmNfaFields } from "@/lib/nfa";
import { normalizeMoney } from "@/lib/money";
import { NFA_CLASSES, normalizeTypeToken } from "@/lib/types";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackSerialNumber() {
  return `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// GET /api/firearms/[id] - Get a single firearm with active build, slots, and accessories
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const firearm = await prisma.firearm.findUnique({
      where: { id },
      include: {
        _count: {
          select: { builds: true, rangeSessions: true },
        },
        builds: {
          include: {
            slots: {
              include: {
                accessory: true,
              },
            },
          },
          orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
        },
      },
    });

    if (!firearm) {
      return NextResponse.json({ error: "Firearm not found" }, { status: 404 });
    }

    const activeBuild = firearm.builds.find((b) => b.isActive) ?? null;

    return NextResponse.json({
      ...firearm,
      serialNumber: decryptField(firearm.serialNumber),
      notes: firearm.notes,
      buildCount: firearm._count.builds,
      rangeSessionCount: firearm._count.rangeSessions,
      activeBuild,
      _count: undefined,
    });
  } catch (error) {
    console.error("GET /api/firearms/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch firearm" },
      { status: 500 },
    );
  }
}

// PUT /api/firearms/[id] - Update a firearm
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
      caliber,
      compatibleCalibers,
      serialNumber,
      type,
      acquisitionDate,
      purchasePrice,
      currentValue,
      notes,
      imageUrl,
      imageSource,
      lastMaintenanceDate,
      maintenanceIntervalDays,
      nfaClass,
      mgRegistry,
      nfaTransferMethod,
      nfaControlNumber,
      nfaApprovalDate,
      nfaTaxPaid,
      nfaRegisteredTo,
    } = body;

    // Input validation before the read: a class that is present but not a
    // known one is rejected rather than normalized, because the fallback for
    // an unrecognised class is NONE and NONE clears mgRegistry and all five
    // paperwork columns. Absent or explicitly null still means "not supplied"
    // (see the classProvided note below) and changes nothing.
    if (
      nfaClass !== undefined &&
      nfaClass !== null &&
      !isKnownNfaClass(nfaClass)
    ) {
      return NextResponse.json(
        {
          error: `Invalid nfaClass. Supported values: ${NFA_CLASSES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const existing = await prisma.firearm.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Firearm not found" }, { status: 404 });
    }

    // nfaClass is NOT NULL DEFAULT 'NONE', so it has no "cleared" state: an
    // explicit null would otherwise declassify an NFA item to Title I with no
    // audit trail, which is the one destructive edit on this route. So null is
    // treated exactly like an absent key. Every other field in the group
    // (mgRegistry and the five paperwork columns) IS nullable, so an explicit
    // null on any of those does clear it.
    //
    // The group is gated as a whole, not field-by-field: a write mentioning
    // NONE of the seven columns must leave all seven alone (a `name`-only PUT
    // must not touch paperwork), but a write mentioning ANY of them re-derives
    // the whole group through normalizeFirearmNfaFields — merging in the
    // stored value for every column the body didn't mention — so that dropping
    // nfaClass to NONE clears paperwork it never named, and normalizing FORM_4473
    // still clears the stamp fields even though only nfaTransferMethod was sent.
    // Deriving the whole group together (rather than gating each column on its
    // own presence) is what makes both rules hold at once: the class-drop rule
    // needs fields that weren't mentioned to still be cleared, so "mentioned"
    // has to gate entry into the derivation, not membership in the result.
    const classProvided = nfaClass !== undefined && nfaClass !== null;
    const touchesNfaGroup =
      classProvided ||
      mgRegistry !== undefined ||
      nfaTransferMethod !== undefined ||
      nfaControlNumber !== undefined ||
      nfaApprovalDate !== undefined ||
      nfaTaxPaid !== undefined ||
      nfaRegisteredTo !== undefined;

    const updated = await prisma.firearm.update({
      where: { id },
      data: {
        ...(name !== undefined && {
          name: normalizeString(name) || existing.name,
        }),
        ...(manufacturer !== undefined && {
          manufacturer: normalizeString(manufacturer) || "Unknown",
        }),
        ...(model !== undefined && {
          model: normalizeString(model) || "Unknown",
        }),
        ...(caliber !== undefined && {
          caliber: normalizeString(caliber) || "Unknown",
        }),
        ...(compatibleCalibers !== undefined && {
          compatibleCalibers: compatibleCalibers
            ? compatibleCalibers
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
                .join(",") || null
            : null,
        }),
        ...(serialNumber !== undefined && {
          serialNumber: normalizeString(serialNumber) || fallbackSerialNumber(),
        }),
        ...(type !== undefined && {
          type: normalizeTypeToken(type) || "UNSPECIFIED",
        }),
        ...(acquisitionDate !== undefined && {
          acquisitionDate: acquisitionDate
            ? toDateOnlyUTC(acquisitionDate)
            : existing.acquisitionDate,
        }),
        ...(purchasePrice !== undefined && {
          purchasePrice: normalizeMoney(purchasePrice),
        }),
        ...(currentValue !== undefined && {
          currentValue: normalizeMoney(currentValue),
        }),
        ...(notes !== undefined && {
          notes: notes ? normalizeString(notes) : null,
        }),
        ...(imageUrl !== undefined && { imageUrl }),
        ...(imageSource !== undefined && { imageSource }),
        ...(lastMaintenanceDate !== undefined && {
          lastMaintenanceDate: lastMaintenanceDate
            ? toDateOnlyUTC(lastMaintenanceDate)
            : null,
        }),
        ...(maintenanceIntervalDays !== undefined && {
          maintenanceIntervalDays,
        }),
        ...(touchesNfaGroup
          ? normalizeFirearmNfaFields({
              nfaClass: classProvided ? nfaClass : existing.nfaClass,
              // Absence is checked with !== undefined rather than ?? for every
              // field below so that an explicit null still clears a nullable
              // column (e.g. dropping a stale pre-sample marking while the
              // class stays MACHINE_GUN, or clearing just nfaControlNumber).
              mgRegistry:
                mgRegistry !== undefined ? mgRegistry : existing.mgRegistry,
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
      },
      include: {
        _count: {
          select: { builds: true },
        },
        builds: {
          where: { isActive: true },
          take: 1,
          include: {
            slots: {
              include: { accessory: true },
            },
          },
        },
      },
    });

    revalidateDashboardData();

    return NextResponse.json({
      ...updated,
      buildCount: updated._count.builds,
      activeBuild: updated.builds[0] ?? null,
      builds: undefined,
      _count: undefined,
    });
  } catch (error: unknown) {
    console.error("PUT /api/firearms/[id] error:", error);
    if (error instanceof InvalidDateError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (
      error instanceof Error &&
      error.message.includes("Unique constraint failed") &&
      error.message.includes("serialNumber")
    ) {
      return NextResponse.json(
        { error: "A firearm with that serial number already exists" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Failed to update firearm" },
      { status: 500 },
    );
  }
}

// DELETE /api/firearms/[id] - Delete a firearm
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    const existing = await prisma.firearm.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Firearm not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({}));
    const deleteAccessories = body.deleteAccessories === true;

    // Fetch build IDs outside the transaction (read-only, no mutation risk)
    const builds = await prisma.build.findMany({
      where: { firearmId: id },
      select: { id: true },
    });
    const buildIds = builds.map((b) => b.id);

    // Wrap all mutations in a transaction so partial failures don't leave orphaned data
    await prisma.$transaction(async (tx) => {
      if (buildIds.length > 0) {
        if (deleteAccessories) {
          const slots = await tx.buildSlot.findMany({
            where: { buildId: { in: buildIds }, accessoryId: { not: null } },
            select: { accessoryId: true },
          });
          const accessoryIds = slots
            .map((s) => s.accessoryId)
            .filter(Boolean) as string[];
          if (accessoryIds.length > 0) {
            await tx.accessory.deleteMany({
              where: { id: { in: accessoryIds } },
            });
          }
        } else {
          await tx.buildSlot.updateMany({
            where: { buildId: { in: buildIds } },
            data: { accessoryId: null },
          });
        }
      }

      await tx.firearm.delete({ where: { id } });
    });

    revalidateDashboardData();

    return NextResponse.json({ success: true, id });
  } catch (error) {
    console.error("DELETE /api/firearms/[id] error:", error);
    return NextResponse.json(
      { error: "Failed to delete firearm" },
      { status: 500 },
    );
  }
}
