import { NextResponse, type NextRequest } from "next/server";
import { getPublicUrl } from "@/lib/server/public-url";
import { getDirectAccessState } from "@/lib/server/direct-access";
import { decideRequest, effectiveHost, isPublicHost, trustsForwardedHeaders, type GateInput } from "@/lib/server/request-gate";
import { decideAuth, isPublicPath } from "@/lib/server/auth-gate";
import { SESSION_COOKIE, sessionCookie, validateSession } from "@/lib/auth/sessions";
import { hasAnyUser } from "@/lib/auth/setup-state";
import { CAPTURE_PAGE_HEADER, isCapturePagePath } from "@/lib/server/capture-page";

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
  const gateInput: GateInput = {
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
  };
  const decision = decideRequest(gateInput);

  if (decision.kind === "redirect") return NextResponse.redirect(decision.location, 307);
  if (decision.kind === "forbidden") return NextResponse.json({ error: decision.reason }, { status: 403 });

  const isApi = pathname.startsWith("/api/");
  const needsSession = !isPublicPath(pathname) || pathname === "/login" || pathname === "/setup";
  const rawSession = request.cookies.get(SESSION_COOKIE)?.value;
  const session = needsSession ? await validateSession(rawSession) : null;
  // A valid session proves an account exists, so a stale-cached hasAnyUser()
  // (see setup-state.ts) can never send an already-signed-in user to /setup.
  const hasUsers = session?.user ? true : await hasAnyUser();
  const auth = decideAuth({ pathname, search, isApi, hasUsers, user: session?.user ?? null });

  if (auth.kind === "redirect") {
    // The browser-facing origin is not always request.url's: behind the TLS
    // reverse proxy, Next itself runs on plain HTTP, so request.url is
    // http://... even though the browser is on https://vault.example.com.
    // Use the public URL's origin when the request's effective host IS the
    // public host (spec 1's own effectiveHost/isPublicHost logic — never
    // duplicated here); otherwise this is a loopback/direct-access request
    // and the request's own origin is correct.
    const authOrigin = isPublicHost(effectiveHost(gateInput), gateInput.publicUrl)
      ? gateInput.publicUrl.origin
      : new URL(request.url).origin;
    // Defense in depth: decideAuth only ever hands back a path starting with
    // "/", but never trust that blindly when it flows through new URL() —
    // if the resolved origin ever drifted off the chosen origin above, bail
    // to "/" instead of following it.
    const target = new URL(auth.location, authOrigin);
    return NextResponse.redirect(target.origin === authOrigin ? target : new URL("/", authOrigin), 307);
  }
  if (auth.kind === "json") return NextResponse.json({ error: auth.error }, { status: auth.status });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(CAPTURE_PAGE_HEADER);
  if (isCapturePagePath(pathname)) requestHeaders.set(CAPTURE_PAGE_HEADER, "1");
  const response =
    auth.kind === "rewrite"
      ? NextResponse.rewrite(new URL(auth.pathname, request.url), {
          status: 403,
          request: { headers: requestHeaders },
        })
      : NextResponse.next({ request: { headers: requestHeaders } });
  if (session?.slidTo && rawSession) response.cookies.set(sessionCookie(rawSession, session.slidTo, request));
  return response;
}
