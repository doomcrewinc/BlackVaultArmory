import { NextResponse } from "next/server";
import { PASS_MAX_UPLOADS } from "@/lib/capture/pass";
import { failureResponse, resolvePass } from "@/lib/capture/upload";
import { findOwnerName } from "@/lib/photos/owner";
import { describeError } from "@/lib/photos/errors";

type Ctx = { params: Promise<{ token: string }> };

// GET /api/capture/[token] - no session. Reveals the item's name and type only.
export async function GET(request: Request, { params }: Ctx) {
  try {
    const { token } = await params;
    const resolved = await resolvePass(request, token);
    if (!resolved.ok) return failureResponse(resolved);
    const { pass } = resolved;

    const itemName = await findOwnerName(pass.entityType, pass.entityId);
    if (itemName === null) {
      return failureResponse({
        ok: false,
        status: 410,
        body: { error: "This pass was closed. Make a new one on the computer.", reason: "closed" },
      });
    }
    return NextResponse.json(
      {
        itemName,
        entityType: pass.entityType,
        expiresAt: pass.expiresAt.toISOString(),
        remaining: PASS_MAX_UPLOADS - pass.uploadCount,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("GET /api/capture/[token] failed:", describeError(e));
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
