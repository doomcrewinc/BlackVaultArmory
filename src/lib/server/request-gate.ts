import type { PublicUrl } from "./public-url";

/**
 * Per-request policy, kept pure so every branch is testable without a server.
 * src/proxy.ts gathers the input and applies the decision. The TCP gate in
 * gate/ runs first and decides whether the connection may exist at all.
 */

export type GateInput = {
  method: string;
  pathname: string;
  search: string;
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  origin: string | null;
  requestProtocol: "http:" | "https:";
  publicUrl: PublicUrl;
  directAccessAllowed: boolean;
  trustForwardedHeaders: boolean;
};

export type GateDecision =
  | { kind: "pass" }
  | { kind: "redirect"; location: string }
  | { kind: "forbidden"; reason: string };

const PASS: GateDecision = { kind: "pass" };
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_PORT = { "http:": "80", "https:": "443" } as const;

function firstValue(header: string | null): string | null {
  const value = header?.split(",")[0]?.trim().toLowerCase();
  return value ? value : null;
}

function splitHost(host: string): { hostname: string; port: string | null } {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return { hostname: host, port: null };
    const rest = host.slice(end + 1);
    return { hostname: host.slice(0, end + 1), port: rest.startsWith(":") ? rest.slice(1) : null };
  }
  const colon = host.lastIndexOf(":");
  return colon === -1 ? { hostname: host, port: null } : { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

function effectiveProtocol(i: GateInput): "http:" | "https:" {
  if (i.trustForwardedHeaders) {
    const proto = firstValue(i.forwardedProto);
    if (proto === "https") return "https:";
    if (proto === "http") return "http:";
  }
  return i.requestProtocol;
}

/** Host as the browser addressed it, lowercased, default port dropped. */
function effectiveHost(i: GateInput): string | null {
  const raw = (i.trustForwardedHeaders ? firstValue(i.forwardedHost) : null) ?? firstValue(i.host);
  if (!raw) return null;
  const { hostname, port } = splitHost(raw);
  return port === null || port === DEFAULT_PORT[effectiveProtocol(i)] ? hostname : `${hostname}:${port}`;
}

export function decideRequest(i: GateInput): GateDecision {
  if (i.pathname === "/api/health") return PASS;

  const host = effectiveHost(i);
  // Treat as public if: exact match OR same hostname with default port for public URL's protocol.
  // Handles proxy sending "vault.example.com:443" without X-Forwarded-Proto.
  const isPublic = host === i.publicUrl.host ||
    (host !== null &&
      splitHost(host).hostname === splitHost(i.publicUrl.host).hostname &&
      splitHost(host).port === DEFAULT_PORT[i.publicUrl.protocol]);
  const isLoopback = host !== null && LOOPBACK_HOSTNAMES.has(splitHost(host).hostname);

  if (!isPublic && !isLoopback && !i.directAccessAllowed) {
    // String concatenation, never new URL(path, base): a path of "//evil.com"
    // would make URL resolve to another host.
    return { kind: "redirect", location: `${i.publicUrl.origin}${i.pathname}${i.search}` };
  }

  if (UNSAFE_METHODS.has(i.method.toUpperCase()) && i.origin !== null) {
    const origin = i.origin.trim().toLowerCase();
    const ownOrigin = host === null ? null : `${effectiveProtocol(i)}//${host}`;
    if (origin !== i.publicUrl.origin && origin !== ownOrigin) {
      return { kind: "forbidden", reason: "Cross-origin request rejected" };
    }
  }

  return PASS;
}

export function trustsForwardedHeaders(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.TRUSTED_PROXIES ?? "").trim() !== "";
}

export function isSecureRequest(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  if (trustsForwardedHeaders(env)) {
    const proto = firstValue(request.headers.get("x-forwarded-proto"));
    if (proto) return proto === "https";
  }
  return new URL(request.url).protocol === "https:";
}
