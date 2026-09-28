export const dynamic = "force-dynamic";

import { NextResponse, type NextRequest } from "next/server";
import { peekToken } from "@/lib/auth/tokens";

const GONE = { error: "Link expired or already used" };

/**
 * What an invite/reset link is, for the /invite and /reset pages. Does not consume it.
 * Only INVITE and RESET are answered: setup codes are not links and are not probeable here.
 */
export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("t");
  if (!raw) return NextResponse.json(GONE, { status: 404 });
  const token = await peekToken(raw);
  if (!token || (token.kind !== "INVITE" && token.kind !== "RESET")) return NextResponse.json(GONE, { status: 404 });
  return NextResponse.json({ kind: token.kind, role: token.role });
}
