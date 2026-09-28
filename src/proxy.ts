import { NextResponse, type NextRequest } from "next/server";
import { getPublicUrl } from "@/lib/server/public-url";
import { getDirectAccessState } from "@/lib/server/direct-access";
import { decideRequest, trustsForwardedHeaders } from "@/lib/server/request-gate";
import { decideAuth, isPublicPath } from "@/lib/server/auth-gate";
import { SESSION_COOKIE, sessionCookie, validateSession } from "@/lib/auth/sessions";
import { hasAnyUser } from "@/lib/auth/setup-state";

/**
 * Runs on every request (Next 16 proxy, always the Node.js runtime). The TCP
 * gate in gate/ has already decided the connection may exist; this decides
 * what the request may do. Policy lives in request-gate.ts. Once that gate
 * passes, decideAuth (auth-gate.ts) decides who may do it.
 */
export async function proxy(request: NextRequest) {
  const { allowed } = await getDirectAccessState();
  const pathname = request.nextUrl.pathname;
  const search = request.nextUrl.search;
  const decision = decideRequest({
    method: request.method,
    pathname,
    search,
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

  const isApi = pathname.startsWith("/api/");
  const needsSession = !isPublicPath(pathname) || pathname === "/login" || pathname === "/setup";
  const rawSession = request.cookies.get(SESSION_COOKIE)?.value;
  const session = needsSession ? await validateSession(rawSession) : null;
  const auth = decideAuth({ pathname, search, isApi, hasUsers: await hasAnyUser(), user: session?.user ?? null });

  if (auth.kind === "redirect") {
    // Defense in depth: decideAuth only ever hands back a path starting with
    // "/", but never trust that blindly when it flows through new URL() —
    // if the resolved origin ever drifted off the request's own origin,
    // bail to "/" instead of following it.
    const target = new URL(auth.location, request.url);
    const requestOrigin = new URL(request.url).origin;
    return NextResponse.redirect(target.origin === requestOrigin ? target : new URL("/", request.url), 307);
  }
  if (auth.kind === "json") return NextResponse.json({ error: auth.error }, { status: auth.status });

  const response = auth.kind === "rewrite" ? NextResponse.rewrite(new URL(auth.pathname, request.url), { status: 403 }) : NextResponse.next();
  if (session?.slidTo && rawSession) response.cookies.set(sessionCookie(rawSession, session.slidTo, request));
  return response;
}
