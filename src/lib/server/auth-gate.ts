import { safeNextPath } from "@/lib/auth/next-path";

/**
 * Per-request login/authorization policy, kept pure so every branch is
 * testable without a server. src/proxy.ts gathers the input (after spec 1's
 * decideRequest has already passed) and applies the decision.
 */

export type AuthInput = {
  pathname: string;
  search: string;
  isApi: boolean;
  hasUsers: boolean;
  user: { role: "ADMIN" | "USER" } | null;
};

export type AuthDecision =
  | { kind: "pass" }
  | { kind: "redirect"; location: string }
  | { kind: "json"; status: 401 | 403 | 503; error: string }
  | { kind: "rewrite"; pathname: "/admins-only" };

const PASS: AuthDecision = { kind: "pass" };

const PUBLIC_EXACT = new Set([
  "/api/health",
  "/login",
  "/setup",
  "/api/internal/gate-config",
  "/favicon.svg",
  "/favicon.ico",
  "/site.webmanifest",
]);

const PUBLIC_PREFIXES = ["/invite/", "/reset/", "/api/auth/", "/_next/static/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function decideAuth(input: AuthInput): AuthDecision {
  const { pathname, search, isApi, hasUsers, user } = input;

  // Rule 1: public paths pass, except a signed-in user landing on /login or
  // /setup — they don't need those pages, so send them home. Invite/reset
  // links are deliberately excluded from this exception:
  // an admin testing their own invite link must still see it work.
  if (isPublicPath(pathname)) {
    if (user && (pathname === "/login" || pathname === "/setup")) {
      return { kind: "redirect", location: "/" };
    }
    return PASS;
  }

  // Rule 2: no account exists yet — force setup.
  if (!hasUsers) {
    return isApi ? { kind: "json", status: 503, error: "Setup required" } : { kind: "redirect", location: "/setup" };
  }

  // Rule 3: not signed in.
  if (!user) {
    if (isApi) return { kind: "json", status: 401, error: "Authentication required" };
    const next = encodeURIComponent(safeNextPath(pathname + search));
    return { kind: "redirect", location: `/login?next=${next}` };
  }

  // Rule 4: admin-only surfaces.
  const isAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");
  const isAdminApi = pathname === "/api/admin" || pathname.startsWith("/api/admin/");
  if ((isAdminPage || isAdminApi) && user.role !== "ADMIN") {
    return isAdminApi ? { kind: "json", status: 403, error: "Admins only" } : { kind: "rewrite", pathname: "/admins-only" };
  }

  // Rule 5: everything else passes.
  return PASS;
}
