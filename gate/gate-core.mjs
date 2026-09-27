// Pure helpers for the TCP gate (gate/gate.mjs). Plain JS: the container runs
// node directly with no TypeScript step. See
// docs/superpowers/specs/2026-09-26-public-url-and-direct-access-design.md.
import net from "node:net";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;

/** Strips the IPv4-mapped prefix a dual-stack socket reports. */
export function normalizePeer(address) {
  if (!address) return null;
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") && net.isIPv4(lower.slice(7))) return lower.slice(7);
  return lower;
}

export function isLoopback(ip) {
  return ip === "::1" || (net.isIPv4(ip) && ip.startsWith("127."));
}

export function parseTrustedProxies(raw) {
  const result = { ips: [], cidrs: [], hostnames: [], invalid: [] };
  for (const token of (raw ?? "").split(",")) {
    const entry = token.trim();
    if (entry === "") continue;
    if (entry.includes("/")) {
      const [address, prefixText] = entry.split("/");
      const family = net.isIPv4(address) ? "ipv4" : net.isIPv6(address) ? "ipv6" : null;
      const prefix = /^\d+$/.test(prefixText ?? "") ? Number(prefixText) : NaN;
      const max = family === "ipv4" ? 32 : 128;
      if (family && prefix >= 0 && prefix <= max) result.cidrs.push({ address: address.toLowerCase(), prefix, family });
      else result.invalid.push(entry);
    } else if (net.isIP(entry)) {
      result.ips.push(entry.toLowerCase());
    } else if (HOSTNAME.test(entry)) {
      result.hostnames.push(entry.toLowerCase());
    } else {
      result.invalid.push(entry);
    }
  }
  return result;
}

export function buildMatcher(parsed, resolvedIps) {
  const list = new net.BlockList();
  for (const ip of [...parsed.ips, ...resolvedIps]) {
    const normalised = normalizePeer(ip);
    if (normalised && net.isIP(normalised)) list.addAddress(normalised, net.isIPv4(normalised) ? "ipv4" : "ipv6");
  }
  for (const { address, prefix, family } of parsed.cidrs) list.addSubnet(address, prefix, family);
  return (ip) => {
    const family = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
    return family !== null && list.check(ip, family);
  };
}
