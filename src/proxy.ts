import { NextResponse, type NextRequest } from "next/server";
import { getPublicUrl } from "@/lib/server/public-url";
import { getDirectAccessState } from "@/lib/server/direct-access";
import { decideRequest, trustsForwardedHeaders } from "@/lib/server/request-gate";

/**
 * Runs on every request (Next 16 proxy, always the Node.js runtime). The TCP
 * gate in gate/ has already decided the connection may exist; this decides
 * what the request may do. Policy lives in request-gate.ts.
 */
export async function proxy(request: NextRequest) {
  const { allowed } = await getDirectAccessState();
  const decision = decideRequest({
    method: request.method,
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    host: request.headers.get("host"),
    forwardedHost: request.headers.get("x-forwarded-host"),
    forwardedProto: request.headers.get("x-forwarded-proto"),
    origin: request.headers.get("origin"),
    requestProtocol: request.nextUrl.protocol === "https:" ? "https:" : "http:",
    publicUrl: getPublicUrl(),
    directAccessAllowed: allowed,
    trustForwardedHeaders: trustsForwardedHeaders(),
  });

  if (decision.kind === "redirect") return NextResponse.redirect(decision.location, 307);
  if (decision.kind === "forbidden") return NextResponse.json({ error: decision.reason }, { status: 403 });
  return NextResponse.next();
}
