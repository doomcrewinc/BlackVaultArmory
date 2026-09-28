import { describe, expect, it } from "vitest";
import { decideAuth, isPublicPath, type AuthDecision, type AuthInput } from "./auth-gate";

/**
 * Table-driven proof of the five decision rules in order. States, in the
 * order the brief names them:
 *   - "no users"   → hasUsers=false, user=null
 *   - "logged out" → hasUsers=true,  user=null
 *   - "USER"       → hasUsers=true,  user={ role: "USER" }
 *   - "ADMIN"      → hasUsers=true,  user={ role: "ADMIN" }
 */
type StateName = "no users" | "logged out" | "USER" | "ADMIN";

const STATES: Record<StateName, Pick<AuthInput, "hasUsers" | "user">> = {
  "no users": { hasUsers: false, user: null },
  "logged out": { hasUsers: true, user: null },
  USER: { hasUsers: true, user: { role: "USER" } },
  ADMIN: { hasUsers: true, user: { role: "ADMIN" } },
};

function input(pathname: string, isApi: boolean, state: StateName): AuthInput {
  return { pathname, search: "", isApi, ...STATES[state] };
}

const PASS: AuthDecision = { kind: "pass" };

// [pathname, isApi, state, expected]
const ROWS: [string, boolean, StateName, AuthDecision][] = [
  // "/"
  ["/", false, "no users", { kind: "redirect", location: "/setup" }],
  ["/", false, "logged out", { kind: "redirect", location: "/login?next=%2F" }],
  ["/", false, "USER", PASS],
  ["/", false, "ADMIN", PASS],

  // "/vault/x"
  ["/vault/x", false, "no users", { kind: "redirect", location: "/setup" }],
  ["/vault/x", false, "logged out", { kind: "redirect", location: "/login?next=%2Fvault%2Fx" }],
  ["/vault/x", false, "USER", PASS],
  ["/vault/x", false, "ADMIN", PASS],

  // "/api/firearms"
  ["/api/firearms", true, "no users", { kind: "json", status: 503, error: "Setup required" }],
  ["/api/firearms", true, "logged out", { kind: "json", status: 401, error: "Authentication required" }],
  ["/api/firearms", true, "USER", PASS],
  ["/api/firearms", true, "ADMIN", PASS],

  // "/_next/static/a.js" — public prefix, always pass regardless of auth state
  ["/_next/static/a.js", false, "no users", PASS],
  ["/_next/static/a.js", false, "logged out", PASS],
  ["/_next/static/a.js", false, "USER", PASS],
  ["/_next/static/a.js", false, "ADMIN", PASS],

  // "/api/health" — public exact, always pass
  ["/api/health", true, "no users", PASS],
  ["/api/health", true, "logged out", PASS],
  ["/api/health", true, "USER", PASS],
  ["/api/health", true, "ADMIN", PASS],

  // "/login" — public exact; signed-in users get bounced to "/"
  ["/login", false, "no users", PASS],
  ["/login", false, "logged out", PASS],
  ["/login", false, "USER", { kind: "redirect", location: "/" }],
  ["/login", false, "ADMIN", { kind: "redirect", location: "/" }],

  // "/setup" — public exact; signed-in users get bounced to "/"
  ["/setup", false, "no users", PASS],
  ["/setup", false, "logged out", PASS],
  ["/setup", false, "USER", { kind: "redirect", location: "/" }],
  ["/setup", false, "ADMIN", { kind: "redirect", location: "/" }],

  // "/invite/abc" — public prefix; NOT one of the login/setup exceptions, so
  // it still works for a signed-in admin testing their own invite link.
  ["/invite/abc", false, "no users", PASS],
  ["/invite/abc", false, "logged out", PASS],
  ["/invite/abc", false, "USER", PASS],
  ["/invite/abc", false, "ADMIN", PASS],

  // "/admin/users" — page, admin-only
  ["/admin/users", false, "no users", { kind: "redirect", location: "/setup" }],
  ["/admin/users", false, "logged out", { kind: "redirect", location: "/login?next=%2Fadmin%2Fusers" }],
  ["/admin/users", false, "USER", { kind: "rewrite", pathname: "/admins-only" }],
  ["/admin/users", false, "ADMIN", PASS],

  // "/api/admin/users" — API, admin-only
  ["/api/admin/users", true, "no users", { kind: "json", status: 503, error: "Setup required" }],
  ["/api/admin/users", true, "logged out", { kind: "json", status: 401, error: "Authentication required" }],
  ["/api/admin/users", true, "USER", { kind: "json", status: 403, error: "Admins only" }],
  ["/api/admin/users", true, "ADMIN", PASS],

  // "/api/admin" — exact path must be treated the same as "/api/admin/*"
  // (mirrors "/admin" exact vs "/admin/*" for the page rule).
  ["/api/admin", true, "no users", { kind: "json", status: 503, error: "Setup required" }],
  ["/api/admin", true, "logged out", { kind: "json", status: 401, error: "Authentication required" }],
  ["/api/admin", true, "USER", { kind: "json", status: 403, error: "Admins only" }],
  ["/api/admin", true, "ADMIN", PASS],
];

describe("decideAuth", () => {
  it.each(ROWS)("%s [%s] as %s -> %o", (pathname, isApi, state, expected) => {
    expect(decideAuth(input(pathname, isApi, state))).toEqual(expected);
  });

  it("has exactly 44 rows (11 paths x 4 states)", () => {
    expect(ROWS.length).toBe(44);
  });
});

describe("isPublicPath", () => {
  it.each([
    ["/api/health", true],
    ["/login", true],
    ["/setup", true],
    ["/api/internal/gate-config", true],
    ["/favicon.svg", true],
    ["/favicon.ico", true],
    ["/site.webmanifest", true],
    ["/invite/abc", true],
    ["/reset/abc", true],
    ["/api/auth/login", true],
    ["/_next/static/a.js", true],
    ["/api/authx", false],
    ["/_next/image", false],
    ["/invitex", false],
    ["/resetx", false],
    ["/", false],
    ["/vault/x", false],
    ["/api/firearms", false],
    ["/admin/users", false],
    ["/api/admin/users", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isPublicPath(pathname)).toBe(expected);
  });
});
