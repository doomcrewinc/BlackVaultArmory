import { NextRequest, NextResponse } from "next/server";
import { describeError } from "@/lib/photos/errors";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/server/auth";
import { recordEventBestEffort } from "@/lib/audit/events";
import { createPass } from "@/lib/capture/pass";
import { OWNER_MODEL, SAFE_ENTITY_ID, findOwnerName, isPhotoEntityType } from "@/lib/photos/owner";

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

// POST /api/capture-passes - body { entityType, entityId }. The token is in this response only.
export async function POST(request: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (!user) return bad("Authentication required", 401);

    const body: unknown = await request.json().catch(() => null);
    if (typeof body !== "object" || body === null || Array.isArray(body)) return bad("Invalid request body.");
    const { entityType, entityId } = body as { entityType?: unknown; entityId?: unknown };
    if (!isPhotoEntityType(entityType)) return bad("Invalid entityType");
    if (typeof entityId !== "string" || !SAFE_ENTITY_ID.test(entityId)) return bad("Invalid entityId");

    const name = await findOwnerName(entityType, entityId);
    if (name === null) return bad("Item not found", 404);

    const rate = await enforceRateLimit({ key: `capture-pass:u:${user.id}`, windowMs: 60_000, maxAttempts: 10 });
    if (!rate.allowed) return bad("Too many capture passes. Please wait a minute.", 429);

    const pass = await createPass({ entityType, entityId, createdById: user.id, sessionId: user.sessionId });
    await recordEventBestEffort(null, {
      action: "CAPTURE_PASS_CREATED",
      entityType: OWNER_MODEL[entityType],
      entityId,
      entityLabel: name,
      changes: { passId: pass.id, expiresAt: pass.expiresAt.toISOString() },
    });

    return NextResponse.json(
      { id: pass.id, token: pass.token, path: `/capture/${pass.token}`, expiresAt: pass.expiresAt.toISOString() },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("POST /api/capture-passes failed:", describeError(e));
    return bad("Failed to create capture pass", 500);
  }
}
