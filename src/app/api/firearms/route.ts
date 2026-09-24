import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { revalidateDashboardData } from "@/lib/dashboard/revalidate-dashboard";
import { decryptField } from "@/lib/crypto";
import { InvalidDateError, toDateOnlyUTC } from "@/lib/date";
import { isKnownNfaClass, normalizeFirearmNfaFields } from "@/lib/nfa";
import { NFA_CLASSES } from "@/lib/types";
import { firearmWhereForSection, sectionBySlug } from "@/lib/categories";

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackSerialNumber() {
  return `AUTO-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// GET /api/firearms - List all firearms with build count.
// An optional ?section=<slug> narrows the list to that category section. An
// unknown slug is ignored rather than erroring: the page-level 404 handles a bad
// slug, and a GET should not fail on a stray query parameter. A known slug from
// another group (a gear section) has no firearm source, and a section with no
// firearm source contains no firearms — so it answers none, not all of them.
export async function GET(request: NextRequest) {
  try {
    const slug = request.nextUrl.searchParams.get("section");
    const section = slug ? sectionBySlug(slug) : undefined;
    let where: object | undefined;
    if (section) {
      const fragment = firearmWhereForSection(section);
      if (!fragment) return NextResponse.json([]);
      where = fragment;
    }

    const firearms = await prisma.firearm.findMany({
      where,
      include: {
        _count: {
          select: { builds: true },
        },
        builds: {
          where: { isActive: true },
          take: 1,
          include: {
            slots: {
              include: {
                accessory: true,
              },
            },
          },
        },
        rangeSessions: {
          select: { roundsFired: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const result = firearms.map((firearm) => ({
      ...firearm,
      firearmRoundCount: firearm.rangeSessions.reduce(
        (sum, session) => sum + session.roundsFired,
        0,
      ),
      serialNumber: decryptField(firearm.serialNumber) ?? firearm.serialNumber,
      notes: firearm.notes,
      buildCount: firearm._count.builds,
      activeBuild: firearm.builds[0] ?? null,
      builds: undefined,
      rangeSessions: undefined,
      _count: undefined,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("GET /api/firearms error:", error);
    return NextResponse.json(
      { error: "Failed to fetch firearms" },
      { status: 500 },
    );
  }
}

// POST /api/firearms - Create a new firearm
export async function POST(request: NextRequest) {
  try {
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
      initialRoundCount,
      nfaClass,
      mgRegistry,
      nfaTransferMethod,
      nfaControlNumber,
      nfaApprovalDate,
      nfaTaxPaid,
      nfaRegisteredTo,
    } = body;

    const normalizedName = normalizeString(name);
    if (!normalizedName) {
      return NextResponse.json(
        { error: "Missing required field: name" },
        { status: 400 },
      );
    }

    // A class that is present but not a known one is rejected rather than
    // normalized: the fallback for an unrecognised class is NONE, and NONE
    // clears mgRegistry and the whole paperwork group. Absent (or explicitly
    // null) still means "no class supplied" and defaults to NONE, which loses
    // nothing.
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

    const nfaFields = normalizeFirearmNfaFields({
      nfaClass,
      mgRegistry,
      nfaTransferMethod,
      nfaControlNumber,
      nfaApprovalDate,
      nfaTaxPaid,
      nfaRegisteredTo,
    });

    const firearm = await prisma.firearm.create({
      data: {
        name: normalizedName,
        manufacturer: normalizeString(manufacturer) || "Unknown",
        model: normalizeString(model) || "Unknown",
        caliber: normalizeString(caliber) || "Unknown",
        compatibleCalibers: compatibleCalibers
          ? compatibleCalibers
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
              .join(",") || null
          : null,
        serialNumber: normalizeString(serialNumber) || fallbackSerialNumber(),
        type: normalizeString(type) || "UNSPECIFIED",
        ...nfaFields,
        // No date supplied: fall back to UTC's today. The server cannot know the
        // viewer's timezone (in Docker this container is UTC), so the client sends
        // the date whenever it has one.
        acquisitionDate: acquisitionDate
          ? toDateOnlyUTC(acquisitionDate)
          : toDateOnlyUTC(new Date()),
        purchasePrice: purchasePrice ?? null,
        currentValue: currentValue ?? null,
        notes: notes ? normalizeString(notes) : null,
        imageUrl: imageUrl ?? null,
        imageSource: imageSource ?? null,
        lastMaintenanceDate: lastMaintenanceDate
          ? toDateOnlyUTC(lastMaintenanceDate)
          : null,
        maintenanceIntervalDays: maintenanceIntervalDays ?? null,
      },
      include: {
        _count: {
          select: { builds: true },
        },
        rangeSessions: {
          select: { roundsFired: true },
        },
      },
    });

    // If the user specified an initial round count (pre-existing use), log it as a range session
    const parsedInitialRounds = initialRoundCount
      ? Math.floor(Number(initialRoundCount))
      : 0;
    if (parsedInitialRounds > 0) {
      await prisma.rangeSession.create({
        data: {
          firearmId: firearm.id,
          sessionDate: firearm.acquisitionDate
            ? toDateOnlyUTC(firearm.acquisitionDate)
            : toDateOnlyUTC(new Date()),
          location: "Pre-existing use",
          roundsFired: parsedInitialRounds,
          notes: "Initial round count logged at time of vault entry.",
        },
      });
    }

    revalidateDashboardData();

    return NextResponse.json(
      { ...firearm, buildCount: firearm._count.builds, _count: undefined },
      { status: 201 },
    );
  } catch (error: unknown) {
    console.error("POST /api/firearms error:", error);
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
      { error: "Failed to create firearm" },
      { status: 500 },
    );
  }
}
